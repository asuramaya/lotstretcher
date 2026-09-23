//! The spin choreography (port of the scheduling and placement half of
//! compose/spin.py): a half-turn cross-dissolved between a vehicle's
//! real angle cutouts. The host supplies the anchors in geometric order
//! (spec spin.angleOrder, chosen from angles.json), the core says where
//! each sits, how long it holds, and which two are on screen at any
//! frame. Pixels go through `place_layer`, `blend` and
//! frame::render_frame, so both surfaces produce the same clip.

use serde::{Deserialize, Serialize};

use crate::resize::resize_lanczos;
use crate::spec;
use crate::Image;

#[derive(Deserialize)]
pub struct AnchorSize { pub width: usize, pub height: usize }

#[derive(Deserialize)]
pub struct SpinPlanRequest {
    pub width: usize,
    pub height: usize,
    #[serde(default)]
    pub fps: Option<f64>,
    pub anchors: Vec<AnchorSize>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SpinPlan {
    /// [x, y, w, h] each anchor is drawn at: one height, one ground line.
    pub rects: Vec<[i64; 4]>,
    pub fps: f64,
    pub hold_frames: usize,
    pub trans_frames: usize,
    pub total_frames: usize,
    pub total_seconds: f64,
    /// [cx, cy, dim] of the spotlight on the ground line.
    pub spotlight: [f64; 3],
}

#[derive(Serialize)]
pub struct SpinFrame {
    pub index: usize,
    /// The next anchor when the frame is inside a dissolve, else null.
    pub next: Option<usize>,
    pub tau: f64,
}

/// Python's round(): half to even, which is what the anchor sizes were
/// computed with.
fn round_even(v: f64) -> f64 {
    let r = v.round();
    if (v - v.trunc()).abs() == 0.5 && r % 2.0 != 0.0 { r - v.signum() } else { r }
}

pub fn plan(req: &SpinPlanRequest) -> Result<SpinPlan, String> {
    if req.width == 0 || req.height == 0 { return Err("canvas must not be empty".into()); }
    let (cw, ch) = (req.width as f64, req.height as f64);
    let fps = req.fps.unwrap_or_else(|| spec::f64_at(&["spin", "fps"]));
    let target_h = round_even(ch * spec::f64_at(&["spin", "heightFrac"]));
    let ground_y = round_even(ch * spec::f64_at(&["spin", "groundFrac"]));
    let mut rects = Vec::with_capacity(req.anchors.len());
    for a in &req.anchors {
        if a.height == 0 { return Err("anchor must not be empty".into()); }
        let scale = target_h / a.height as f64;
        let w = round_even(a.width as f64 * scale).max(1.0);
        let x = ((cw - w) / 2.0).floor();
        rects.push([x as i64, (ground_y - target_h) as i64, w as i64, target_h as i64]);
    }
    let hold_frames = round_even(spec::f64_at(&["spin", "holdSeconds"]) * fps) as usize;
    let trans_frames = round_even(spec::f64_at(&["spin", "transitionSeconds"]) * fps) as usize;
    let n = req.anchors.len();
    let total_frames = n * hold_frames + n.saturating_sub(1) * trans_frames;
    Ok(SpinPlan {
        rects, fps, hold_frames, trans_frames, total_frames,
        total_seconds: total_frames as f64 / fps,
        spotlight: [cw / 2.0, ch * spec::f64_at(&["spin", "groundFrac"]), spec::f64_at(&["spin", "spotlightDim"])],
    })
}

pub fn frame(plan: &SpinPlan, f: usize) -> SpinFrame {
    let n = plan.rects.len();
    let cycle = plan.hold_frames + plan.trans_frames;
    if n == 0 || cycle == 0 { return SpinFrame { index: 0, next: None, tau: 0.0 }; }
    let (idx, within) = (f / cycle, f % cycle);
    if idx >= n - 1 || within < plan.hold_frames {
        SpinFrame { index: idx.min(n - 1), next: None, tau: 0.0 }
    } else {
        SpinFrame { index: idx, next: Some(idx + 1), tau: (within - plan.hold_frames) as f64 / plan.trans_frames as f64 }
    }
}

/// A canvas-sized transparent RGBA layer with `car` resized to (w, h)
/// and copied in at (x, y): what the dissolve blends between.
pub fn place_layer(car: &Image, width: usize, height: usize, rect: [i64; 4]) -> Result<Image, String> {
    if car.channels != 4 { return Err("place_layer needs an RGBA car".into()); }
    let [x, y, w, h] = rect;
    let (w, h) = (w.max(1) as usize, h.max(1) as usize);
    let scaled = if w == car.width && h == car.height { car.clone() } else { resize_lanczos(car, w, h) };
    let mut out = Image::new(width, height, 4);
    for sy in 0..h {
        let dy = y + sy as i64;
        if dy < 0 || dy >= height as i64 { continue; }
        for sx in 0..w {
            let dx = x + sx as i64;
            if dx < 0 || dx >= width as i64 { continue; }
            let si = (sy * w + sx) * 4;
            let di = (dy as usize * width + dx as usize) * 4;
            out.data[di..di + 4].copy_from_slice(&scaled.data[si..si + 4]);
        }
    }
    Ok(out)
}

/// Pillow's Image.blend: a + (b - a) * t on every channel, alpha
/// included, in single precision and truncated to the pixel (measured
/// against Pillow 12: no half-up rounding).
pub fn blend(a: &Image, b: &Image, t: f64) -> Result<Image, String> {
    if a.width != b.width || a.height != b.height || a.channels != b.channels {
        return Err("blend needs two images of one shape".into());
    }
    let t = t as f32;
    let mut out = a.clone();
    if a.channels == 4 {
        // A layer is mostly untouched zeros: a pixel that is all zero in
        // both inputs blends to all zero, so only the rest is computed.
        for (o, (pa, pb)) in out.data.chunks_exact_mut(4).zip(a.data.chunks_exact(4).zip(b.data.chunks_exact(4))) {
            if pa == [0u8; 4] && pb == [0u8; 4] { continue; }
            for c in 0..4 {
                let (x, y) = (pa[c] as f32, pb[c] as f32);
                o[c] = (x + (y - x) * t).clamp(0.0, 255.0) as u8;
            }
        }
        return Ok(out);
    }
    for i in 0..out.data.len() {
        let (x, y) = (a.data[i] as f32, b.data[i] as f32);
        out.data[i] = (x + (y - x) * t).clamp(0.0, 255.0) as u8;
    }
    Ok(out)
}
