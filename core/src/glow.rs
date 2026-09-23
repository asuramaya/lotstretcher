//! The glow halo and alpha compositing (port of compose/effects.py).

use crate::resize::resize_bilinear;
use crate::spec;
use crate::Image;

pub fn glow_color(name: &str) -> Result<[u8; 3], String> {
    spec::rgb_map(&["glow", "colors"]).into_iter().find(|(k, _)| k == &name.to_lowercase())
        .map(|(_, c)| c)
        .ok_or_else(|| format!("unknown glow colour {name:?}"))
}

/// Gaussian blur of a single-channel image, separable, radius in pixels
/// (sigma = radius, as Pillow's GaussianBlur takes it).
fn gaussian_blur_l(img: &Image, radius: f64) -> Image {
    let sigma = radius.max(0.1);
    let half = (sigma * 3.0).ceil() as i64;
    let kernel: Vec<f64> = (-half..=half).map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f64 = kernel.iter().sum();
    let kernel: Vec<f64> = kernel.iter().map(|k| k / sum).collect();
    let (w, h) = (img.width, img.height);
    let mut tmp = vec![0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (k, kv) in kernel.iter().enumerate() {
                let sx = (x as i64 + k as i64 - half).clamp(0, w as i64 - 1) as usize;
                acc += kv * img.data[y * w + sx] as f64;
            }
            tmp[y * w + x] = acc;
        }
    }
    let mut out = Image::new(w, h, 1);
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (k, kv) in kernel.iter().enumerate() {
                let sy = (y as i64 + k as i64 - half).clamp(0, h as i64 - 1) as usize;
                acc += kv * tmp[sy * w + x];
            }
            out.data[y * w + x] = acc.round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// A soft coloured halo behind the car's silhouette: its alpha, padded,
/// blurred at quarter scale and recoloured. Returns (glow_rgba, pad).
pub fn make_glow_layer(car: &Image, color: [u8; 3], radius: usize, intensity: f64) -> (Image, usize) {
    let pad = radius * 2;
    let (pw, ph) = (car.width + pad * 2, car.height + pad * 2);
    let mut alpha = Image::new(pw, ph, 1);
    for y in 0..car.height {
        for x in 0..car.width {
            alpha.data[(y + pad) * pw + x + pad] = car.data[(y * car.width + x) * 4 + 3];
        }
    }
    let small = resize_bilinear(&alpha, (pw / 4).max(1), (ph / 4).max(1));
    let blurred_small = gaussian_blur_l(&small, ((radius as f64) / 4.0).round().max(1.0));
    let blurred = resize_bilinear(&blurred_small, pw, ph);
    let mut glow = Image::new(pw, ph, 4);
    for i in 0..pw * ph {
        let mut a = blurred.data[i] as f64;
        if intensity < 1.0 {
            a = (a * intensity).round().min(255.0);
        }
        glow.data[i * 4] = color[0];
        glow.data[i * 4 + 1] = color[1];
        glow.data[i * 4 + 2] = color[2];
        glow.data[i * 4 + 3] = a as u8;
    }
    (glow, pad)
}

/// Pillow's Image.paste(src, (x, y), src): straight alpha over, the
/// destination treated as opaque RGB (its alpha, if any, is left alone).
pub fn paste_alpha(dst: &mut Image, src: &Image, x: i64, y: i64) {
    let dc = dst.channels;
    let (dw, dh) = (dst.width, dst.height);
    // Only the destination rows the source covers are visited; each row
    // is independent, so they run in parallel when there are threads.
    let y0 = y.max(0) as usize;
    let y1 = (y + src.height as i64).min(dh as i64).max(0) as usize;
    if y1 <= y0 { return; }
    let band = &mut dst.data[y0 * dw * dc..y1 * dw * dc];
    crate::par::rows_mut(band, dw * dc, |i, drow| {
        let dy = (y0 + i) as i64;
        let sy = (dy - y) as usize;
        for sx in 0..src.width {
            let dx = x + sx as i64;
            if dx < 0 || dx >= dw as i64 { continue; }
            let si = (sy * src.width + sx) * 4;
            let a = src.data[si + 3] as u32;
            if a == 0 { continue; }
            let di = dx as usize * dc;
            if a == 255 {
                drow[di..di + 3].copy_from_slice(&src.data[si..si + 3]);
                if dc == 4 { drow[di + 3] = 255; }
                continue;
            }
            for c in 0..3 {
                let s = src.data[si + c] as u32;
                let d = drow[di + c] as u32;
                // (s*a + d*(255-a)) / 255, rounded as Pillow does; the
                // divide is the exact-for-u8 shift form, which is what a
                // per-pixel loop needs to vectorise.
                let x = s * a + d * (255 - a) + 128;
                drow[di + c] = ((x + (x >> 8)) >> 8) as u8;
            }
            if dc == 4 {
                let d = drow[di + 3] as u32;
                let x = d * (255 - a) + 128;
                drow[di + 3] = (a + ((x + (x >> 8)) >> 8)).min(255) as u8;
            }
        }
    });
}

/// The ground shadow under a car: its silhouette squashed flat, blurred,
/// and laid dark about the contact line (the lowest opaque row). Read
/// off the alpha, so a car on a photo backdrop looks set down on it.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct Shadow {
    /// Opacity at the darkest, 0..1.
    #[serde(default = "shadow_strength")]
    pub strength: f64,
    /// The shadow's height as a fraction of the car's height.
    #[serde(default = "shadow_height")]
    pub height: f64,
    /// Blur radius as a fraction of the car's width.
    #[serde(default = "shadow_blur")]
    pub blur: f64,
}
fn shadow_strength() -> f64 { 0.5 }
fn shadow_height() -> f64 { 0.12 }
fn shadow_blur() -> f64 { 0.035 }

impl Default for Shadow {
    fn default() -> Self { Shadow { strength: shadow_strength(), height: shadow_height(), blur: shadow_blur() } }
}

/// Returns (shadow_rgba, dx, dy): the layer's offset from the car's own
/// top-left. The layer is centred vertically on the contact line, so
/// half of it tucks under the car and half spills below.
pub fn make_shadow_layer(car: &Image, s: &Shadow) -> (Image, i64, i64) {
    let (w, h) = (car.width, car.height);
    let mut alpha = Image::new(w, h, 1);
    let mut contact = 0usize;
    for y in 0..h {
        for x in 0..w {
            let a = car.data[(y * w + x) * 4 + 3];
            alpha.data[y * w + x] = a;
            if a > 16 { contact = y; }
        }
    }
    let sh = ((h as f64 * s.height).round() as usize).max(2);
    let pad = ((w as f64 * s.blur).round() as usize).max(1);
    let (pw, ph) = (w + pad * 2, sh + pad * 2);
    let flat = resize_bilinear(&alpha, w, sh);
    let mut padded = Image::new(pw, ph, 1);
    for y in 0..sh {
        padded.data[(y + pad) * pw + pad..(y + pad) * pw + pad + w].copy_from_slice(&flat.data[y * w..(y + 1) * w]);
    }
    // Blurred at quarter scale like the glow: the shadow is soft by
    // definition, so the detail a full-size blur keeps is never seen.
    let small = resize_bilinear(&padded, (pw / 4).max(1), (ph / 4).max(1));
    let blurred_small = gaussian_blur_l(&small, (pad as f64 / 4.0).max(1.0));
    let blurred = resize_bilinear(&blurred_small, pw, ph);
    let strength = s.strength.clamp(0.0, 1.0);
    let mut out = Image::new(pw, ph, 4);
    for i in 0..pw * ph {
        out.data[i * 4 + 3] = (blurred.data[i] as f64 * strength).round().min(255.0) as u8;
    }
    let dy = contact as i64 + 1 - (sh as i64 / 2) - pad as i64;
    (out, -(pad as i64), dy)
}

/// The shadow pasted under a car at (x, y), faded by `alpha` for a car
/// mid-dissolve.
pub fn paste_shadow(canvas: &mut Image, car: &Image, x: i64, y: i64, s: &Shadow, alpha: f64) {
    let (mut layer, dx, dy) = make_shadow_layer(car, s);
    if alpha < 1.0 {
        for i in (3..layer.data.len()).step_by(4) {
            layer.data[i] = (layer.data[i] as f64 * alpha.clamp(0.0, 1.0)).round() as u8;
        }
    }
    paste_alpha(canvas, &layer, x + dx, y + dy);
}

/// A floor reflection: the car mirrored below its contact line and
/// faded out over `height` of its own height, as a glossy studio floor
/// gives. Painted under the shadow and the car.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct Reflection {
    /// Opacity at the contact line, 0..1.
    #[serde(default = "reflection_strength")]
    pub strength: f64,
    /// How far down the reflection reaches, as a fraction of the car's height.
    #[serde(default = "reflection_height")]
    pub height: f64,
}
fn reflection_strength() -> f64 { 0.35 }
fn reflection_height() -> f64 { 0.4 }

impl Default for Reflection {
    fn default() -> Self { Reflection { strength: reflection_strength(), height: reflection_height() } }
}

/// Returns (reflection_rgba, dy): the layer's offset below the car's
/// own top-left; it starts one row under the contact line.
pub fn make_reflection_layer(car: &Image, r: &Reflection) -> (Image, i64) {
    let (w, h) = (car.width, car.height);
    let mut contact = 0usize;
    for y in 0..h {
        for x in 0..w {
            if car.data[(y * w + x) * 4 + 3] > 16 { contact = y; }
        }
    }
    let rows = ((h as f64 * r.height).round() as usize).clamp(1, contact + 1);
    let strength = r.strength.clamp(0.0, 1.0);
    let mut out = Image::new(w, rows, 4);
    for k in 0..rows {
        // Row k of the reflection is the car's row `contact - k`, faded
        // by a curve that leaves the bottom of the car clearest.
        let src = contact - k;
        let fade = (1.0 - k as f64 / rows as f64).powf(1.6) * strength;
        for x in 0..w {
            let si = (src * w + x) * 4;
            let di = (k * w + x) * 4;
            out.data[di..di + 3].copy_from_slice(&car.data[si..si + 3]);
            out.data[di + 3] = (car.data[si + 3] as f64 * fade).round() as u8;
        }
    }
    (out, contact as i64 + 1)
}

pub fn paste_reflection(canvas: &mut Image, car: &Image, x: i64, y: i64, r: &Reflection, alpha: f64) {
    let (mut layer, dy) = make_reflection_layer(car, r);
    if alpha < 1.0 {
        for i in (3..layer.data.len()).step_by(4) {
            layer.data[i] = (layer.data[i] as f64 * alpha.clamp(0.0, 1.0)).round() as u8;
        }
    }
    paste_alpha(canvas, &layer, x, y + dy);
}

pub fn paste_with_glow(canvas: &mut Image, car: &Image, x: i64, y: i64, color: [u8; 3], radius: usize, intensity: f64) {
    let (glow, pad) = make_glow_layer(car, color, radius, intensity);
    paste_alpha(canvas, &glow, x - pad as i64, y - pad as i64);
    paste_alpha(canvas, car, x, y);
}
