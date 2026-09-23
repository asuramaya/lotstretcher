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
    for sy in 0..src.height {
        let dy = y + sy as i64;
        if dy < 0 || dy >= dst.height as i64 { continue; }
        for sx in 0..src.width {
            let dx = x + sx as i64;
            if dx < 0 || dx >= dst.width as i64 { continue; }
            let si = (sy * src.width + sx) * 4;
            let a = src.data[si + 3] as u32;
            if a == 0 { continue; }
            let di = (dy as usize * dst.width + dx as usize) * dc;
            if a == 255 {
                dst.data[di..di + 3].copy_from_slice(&src.data[si..si + 3]);
                if dc == 4 { dst.data[di + 3] = 255; }
                continue;
            }
            for c in 0..3 {
                let s = src.data[si + c] as u32;
                let d = dst.data[di + c] as u32;
                // (s*a + d*(255-a)) / 255, rounded as Pillow does; the
                // divide is the exact-for-u8 shift form, which is what a
                // per-pixel loop needs to vectorise.
                let x = s * a + d * (255 - a) + 128;
                dst.data[di + c] = ((x + (x >> 8)) >> 8) as u8;
            }
            if dc == 4 {
                let d = dst.data[di + 3] as u32;
                let x = d * (255 - a) + 128;
                dst.data[di + 3] = (a + ((x + (x >> 8)) >> 8)).min(255) as u8;
            }
        }
    }
}

pub fn paste_with_glow(canvas: &mut Image, car: &Image, x: i64, y: i64, color: [u8; 3], radius: usize, intensity: f64) {
    let (glow, pad) = make_glow_layer(car, color, radius, intensity);
    paste_alpha(canvas, &glow, x - pad as i64, y - pad as i64);
    paste_alpha(canvas, car, x, y);
}
