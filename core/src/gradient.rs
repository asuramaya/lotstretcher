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
    // A linear ramp is exactly reconstructible at any size, so it is
    // computed per pixel directly: one multiply-add per pixel per
    // channel. (The Python built it small and upscaled because numpy
    // made the full-size version slow; here the direct form is faster
    // than the upscale it replaced.) gradientBuildMax stays in the spec
    // as the resolution the ramp's endpoints are defined at, so the
    // corner-to-corner normalisation is unchanged.
    let build_max = spec::f64_at(&["compose", "gradientBuildMax"]);
    let scale = (w.max(h) as f64 / build_max).max(1.0);
    let (bw, bh) = (((w as f64 / scale).round() as usize).max(2), ((h as f64 / scale).round() as usize).max(2));
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
    // Map an output pixel to the small grid's coordinate space, as the
    // bilinear upscale would have sampled it.
    let (sx, sy) = (bw as f64 / w as f64, bh as f64 / h as f64);
    let ax = (dx * sx / span) as f32;
    let ay = (dy * sy / span) as f32;
    let c0 = ((-min) / span + (dx * (sx * 0.5 - 0.5) + dy * (sy * 0.5 - 0.5)) / span) as f32;
    let s = [start[0] as f32, start[1] as f32, start[2] as f32];
    let d = [end[0] as f32 - s[0], end[1] as f32 - s[1], end[2] as f32 - s[2]];
    let mut out = Image::new(w, h, 3);
    crate::par::rows_mut(&mut out.data, w * 3, |y, row| {
        let ty = ay * y as f32 + c0;
        for x in 0..w {
            let t = (ax * x as f32 + ty).clamp(0.0, 1.0);
            let i = x * 3;
            row[i] = (s[0] + d[0] * t) as u8;
            row[i + 1] = (s[1] + d[1] * t) as u8;
            row[i + 2] = (s[2] + d[2] * t) as u8;
        }
    });
    let _ = resize_bilinear;
    out
}

/// Seeded hue bands; with a chosen colour ("#rrggbb" or a colour
/// word), the bands are that hue: its backdrop-safe dark and light
/// stops (the same pair the paint would give) at the seeded angle.
pub fn generic_gradient(w: usize, h: usize, seed: &str, color: Option<&str>) -> Image {
    if let Some(c) = color.filter(|c| crate::palette::parse_color_name(Some(c)).is_some()) {
        let (mut start, mut end) = vehicle_gradient_colors(Some(c), Some(c), None);
        let mut rng = Rng::from_seed(seed);
        let angle = rng.uniform(0.0, 360.0);
        if rng.random() < 0.5 {
            std::mem::swap(&mut start, &mut end);
        }
        return linear_gradient(w, h, angle, start, end);
    }
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

/// A studio sweep: a cyclorama in the vehicle's own colours. The wall
/// darkens toward the top, brightens to a lit floor line, and the floor
/// falls off below it, with a pool of light about the middle of the
/// line where the car stands. Only the horizon's height and the pool's
/// centre are seeded, so a rerun reproduces the file.
/// `color` ("#rrggbb" or a colour word) puts the sweep in that colour
/// instead of the paint's.
pub fn sweep(w: usize, h: usize, seed: &str, exterior: Option<&str>, interior: Option<&str>, sample: Option<&Image>, color: Option<&str>) -> Image {
    let (a, b) = match color.filter(|c| crate::palette::parse_color_name(Some(c)).is_some()) {
        Some(c) => vehicle_gradient_colors(Some(c), Some(c), None),
        None => vehicle_gradient_colors(exterior, interior, sample),
    };
    let lum = |c: [u8; 3]| 0.299 * c[0] as f64 + 0.587 * c[1] as f64 + 0.114 * c[2] as f64;
    let (dark, light) = if lum(a) <= lum(b) { (a, b) } else { (b, a) };
    let mut rng = Rng::from_seed(seed);
    let horizon = rng.uniform(0.60, 0.68);
    let pool_x = rng.uniform(0.46, 0.54);
    let dark = [dark[0] as f64, dark[1] as f64, dark[2] as f64];
    let light = [light[0] as f64, light[1] as f64, light[2] as f64];
    let mix = |p: [f64; 3], q: [f64; 3], t: f64| [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    let scale = |p: [f64; 3], k: f64| [p[0] * k, p[1] * k, p[2] * k];
    let top = scale(dark, 0.55);
    let wall = scale(light, 0.92);
    let floor_near = scale(light, 0.80);
    let floor_far = scale(dark, 0.70);
    let mut out = Image::new(w, h, 3);
    let (wf, hf) = (w as f64, h as f64);
    crate::par::rows_mut(&mut out.data, w * 3, |y, row| {
        let v = (y as f64 + 0.5) / hf;
        let base = if v < horizon {
            let t = (v / horizon).powf(1.5);
            mix(top, wall, t)
        } else {
            let u = ((v - horizon) / (1.0 - horizon)).sqrt();
            mix(floor_near, floor_far, u)
        };
        for x in 0..w {
            let dx = ((x as f64 + 0.5) / wf - pool_x) * 1.7;
            let dy = (v - horizon) / 0.22;
            let glow = (-(dx * dx + dy * dy)).exp() * 0.32;
            let i = x * 3;
            for c in 0..3 {
                row[i + c] = (base[c] + (255.0 - base[c]) * glow).round().clamp(0.0, 255.0) as u8;
            }
        }
    });
    out
}
