//! Generated gradient backdrops (port of compose/background.py's
//! gradient half).

use crate::hsv::hsv_bytes;
use crate::palette::vehicle_gradient_colors;
use crate::prng::Rng;
use crate::resize::resize_bilinear;
use crate::spec;
use crate::Image;

pub struct GradientSpec {
    pub angle: f64,
    pub start: [u8; 3],
    pub end: [u8; 3],
}

/// A reproducible (angle, two colours) description for `seed`, with no
/// vehicle input: hues from the spec's bands, both stops dark-to-midtone.
pub fn gradient_spec(seed: &str) -> GradientSpec {
    let bands = spec::get(&["compose", "gradientHueBands"]).as_array().expect("hue bands");
    let mut rng = Rng::from_seed(seed);
    let band = &bands[rng.choice(bands.len())];
    let lo = band[0].as_f64().unwrap();
    let hi = band[1].as_f64().unwrap();
    let h1 = rng.uniform(lo, hi);
    let h2 = h1 + rng.uniform(-0.06, 0.06);
    let mut dark = hsv_bytes(h1, rng.uniform(0.35, 0.72), rng.uniform(0.10, 0.22));
    let mut light = hsv_bytes(h2, rng.uniform(0.40, 0.80), rng.uniform(0.45, 0.72));
    if rng.random() < 0.5 {
        std::mem::swap(&mut dark, &mut light);
    }
    GradientSpec { angle: rng.uniform(0.0, 360.0), start: dark, end: light }
}

/// A linear gradient across (w, h) at `angle` degrees (0 = left to right,
/// increasing counter-clockwise), start -> end, full range corner to
/// corner at any angle. Built at gradientBuildMax and upscaled.
pub fn linear_gradient(w: usize, h: usize, angle: f64, start: [u8; 3], end: [u8; 3]) -> Image {
    let build_max = spec::f64_at(&["compose", "gradientBuildMax"]);
    let scale = w.max(h) as f64 / build_max;
    let (bw, bh) = if scale > 1.0 {
        (((w as f64 / scale).round() as usize).max(2), ((h as f64 / scale).round() as usize).max(2))
    } else {
        (w, h)
    };
    let theta = angle.to_radians();
    let (dx, dy) = (theta.cos(), -theta.sin());
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for (x, y) in [(0.0, 0.0), ((bw - 1) as f64, 0.0), (0.0, (bh - 1) as f64), ((bw - 1) as f64, (bh - 1) as f64)] {
        let p = x * dx + y * dy;
        min = min.min(p);
        max = max.max(p);
    }
    let span = if max - min != 0.0 { max - min } else { 1.0 };
    let mut small = Image::new(bw, bh, 3);
    for y in 0..bh {
        for x in 0..bw {
            let t = ((x as f64 * dx + y as f64 * dy) - min) / span;
            let i = (y * bw + x) * 3;
            for c in 0..3 {
                let v = start[c] as f64 + (end[c] as f64 - start[c] as f64) * t;
                small.data[i + c] = v.clamp(0.0, 255.0) as u8;
            }
        }
    }
    if bw == w && bh == h { small } else { resize_bilinear(&small, w, h) }
}

pub fn generic_gradient(w: usize, h: usize, seed: &str) -> Image {
    let g = gradient_spec(seed);
    linear_gradient(w, h, g.angle, g.start, g.end)
}

/// A gradient from THIS vehicle's own colours at a seeded angle; only
/// the angle and the stop order are random.
pub fn vehicle_gradient(w: usize, h: usize, seed: &str, exterior: Option<&str>, interior: Option<&str>, sample: Option<&Image>) -> Image {
    let (mut start, mut end) = vehicle_gradient_colors(exterior, interior, sample);
    let mut rng = Rng::from_seed(seed);
    let angle = rng.uniform(0.0, 360.0);
    if rng.random() < 0.5 {
        std::mem::swap(&mut start, &mut end);
    }
    linear_gradient(w, h, angle, start, end)
}
