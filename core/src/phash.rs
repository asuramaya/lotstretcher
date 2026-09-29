//! The perceptual hash that recognises a dealer's known junk graphics (a
//! reviews card, a "photos coming soon" card) wherever they turn up in a
//! gallery, on both surfaces. imaging/dedupe.py's module docstring
//! records why only flat, full-bleed graphics may be templates: on studio
//! photography pHash is dominated by the backdrop, so a photo-like template
//! would delete real photos across the inventory.
//!
//! imagehash.phash's recipe: grey, 32x32, a 2-D DCT-II, the top-left 8x8
//! of it against its own median. The templates' hashes live in the spec
//! (listing.junk), computed by this code.

use crate::{spec, Image};

fn grey_32(img: &Image) -> Vec<f64> {
    let mut g = Image::new(img.width, img.height, 1);
    for i in 0..img.width * img.height {
        let p = &img.data[i * img.channels..(i + 1) * img.channels];
        let (r, gr, b) = if img.channels >= 3 { (p[0] as u32, p[1] as u32, p[2] as u32) } else { (p[0] as u32, p[0] as u32, p[0] as u32) };
        // Pillow's "L": ITU-R 601-2 luma in 16-bit fixed point.
        g.data[i] = ((r * 19595 + gr * 38470 + b * 7471 + 0x8000) >> 16) as u8;
    }
    crate::resize::resize_lanczos(&g, 32, 32).data.iter().map(|&v| v as f64).collect()
}

/// DCT-II of each row of an n x n block (scipy.fftpack.dct's unnormalised form).
fn dct_rows(x: &[f64], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n * n];
    for r in 0..n {
        for k in 0..n {
            let mut s = 0.0;
            for i in 0..n {
                s += x[r * n + i] * (std::f64::consts::PI * k as f64 * (2 * i + 1) as f64 / (2 * n) as f64).cos();
            }
            out[r * n + k] = 2.0 * s;
        }
    }
    out
}

fn transpose(x: &[f64], n: usize) -> Vec<f64> {
    (0..n * n).map(|i| x[(i % n) * n + i / n]).collect()
}

/// 16 hex digits, row-major, as imagehash prints a hash.
pub fn phash(img: &Image) -> String {
    let n = 32;
    let px = grey_32(img);
    // dct(dct(pixels, axis=0), axis=1)
    let cols = transpose(&dct_rows(&transpose(&px, n), n), n);
    let full = dct_rows(&cols, n);
    let low: Vec<f64> = (0..8).flat_map(|r| (0..8).map(move |c| (r, c))).map(|(r, c)| full[r * n + c]).collect();
    let mut sorted = low.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = (sorted[31] + sorted[32]) / 2.0;
    let bits = low.iter().fold(0u64, |acc, v| (acc << 1) | (*v > med) as u64);
    format!("{bits:016x}")
}

pub fn distance(a: &str, b: &str) -> Option<u32> {
    Some((u64::from_str_radix(a, 16).ok()? ^ u64::from_str_radix(b, 16).ok()?).count_ones())
}

/// The spec's junk template this hash is within the threshold of, by name.
pub fn junk_match(hash: &str) -> Option<String> {
    let threshold = spec::f64_at(&["listing", "junk", "threshold"]) as u32;
    spec::get(&["listing", "junk", "templates"]).as_array()?.iter().find_map(|t| {
        let d = distance(hash, t.get("phash")?.as_str()?)?;
        (d <= threshold).then(|| t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string())
    })
}
