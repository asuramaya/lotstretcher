//! Is a cutout good enough to compose? One gate for both surfaces, read
//! off the model's own alpha at the photo's full size, before any edge
//! refinement: a confidently wrong cutout does not look like a failure,
//! it looks like a post.
//!
//! This replaces imaging/cutout.py's quality_ok and the browser's
//! gateCutout, which measured different things: the CLI counted
//! ambiguous alpha at full size in 20..200 and rejected a crop touching
//! two frame edges; the browser counted it on the model's small matte in
//! 0.1..0.9, checked the frame edges only for a shot on trial, and had
//! coverage bounds the CLI lacked. The CLI's measures and edge rule are
//! kept; the coverage bounds join them (none of the CLI's 1,583 accepted
//! library cutouts falls outside them: 12% to 41% of the photo).

use crate::{spec, Image};
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct Gate {
    pub ok: bool,
    /// Why not, phrased for a person; null when ok.
    pub reason: Option<String>,
    pub ambiguous: f64,
    pub coverage: f64,
    pub fills_frame: bool,
    /// [left, top, right, bottom), exclusive, of alpha > alphaThreshold.
    pub bbox: Option<[usize; 4]>,
}

fn k(name: &str) -> f64 { spec::f64_at(&["cutout", name]) }

/// `alpha` is one channel at the photo's size. `strict` off (the app's
/// Quality gates lever) keeps only the hard failure: no subject at all.
pub fn cutout_gate(alpha: &Image, strict: bool) -> Gate {
    let (w, h) = (alpha.width, alpha.height);
    let c = alpha.channels;
    let threshold = k("alphaThreshold") as u8;
    let (mut fg, mut bg, mut on) = (0usize, 0usize, 0usize);
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            let a = alpha.data[(y * w + x) * c + c - 1];
            if a > 200 { fg += 1 } else if a < 20 { bg += 1 }
            if a > threshold {
                on += 1;
                x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x + 1); y1 = y1.max(y + 1);
            }
        }
    }
    let n = (w * h).max(1) as f64;
    let ambiguous = 1.0 - (fg + bg) as f64 / n;
    let bbox = (on > 0).then_some([x0, y0, x1, y1]);
    let coverage = on as f64 / n;
    let margin = k("frameFillMargin");
    let fills_frame = bbox.is_some_and(|[l, t, r, b]| {
        [l as f64 / w as f64, t as f64 / h as f64, (w - r) as f64 / w as f64, (h - b) as f64 / h as f64]
            .iter().filter(|m| **m < margin).count() as f64 >= k("frameFillMinEdges")
    });
    let reason = if bbox.is_none() {
        Some("no vehicle found in this photo".to_string())
    } else if !strict {
        None
    } else if ambiguous > k("maxAmbiguousFraction") {
        Some(format!("edges too uncertain ({:.1}% ambiguous)", ambiguous * 100.0))
    } else if fills_frame {
        Some("a close-up that fills the frame, not the whole vehicle".to_string())
    } else if coverage < k("minCoverage") {
        Some("subject too small to be the vehicle".to_string())
    } else if coverage > k("maxCoverage") {
        Some("background not separated".to_string())
    } else {
        None
    };
    Gate { ok: reason.is_none(), reason, ambiguous, coverage, fills_frame, bbox }
}
