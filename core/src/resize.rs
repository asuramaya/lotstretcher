//! Resampling: separable Lanczos-3 for cutouts and cover-fit, bilinear
//! for the gradient upscale (a ramp has no detail to lose).
//!
//! Pillow's LANCZOS and the canvas's drawImage each had their own idea
//! of these; a cutout scaled here is the same bytes on both surfaces.

use crate::Image;

fn lanczos3(x: f64) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    if x.abs() >= 3.0 {
        return 0.0;
    }
    let px = std::f64::consts::PI * x;
    3.0 * px.sin() * (px / 3.0).sin() / (px * px)
}

/// Weights for one output coordinate along one axis, with the filter
/// support widened when downscaling (as Pillow does) so it averages
/// rather than aliases.
fn weights(in_len: usize, out_len: usize) -> Vec<(usize, Vec<f64>)> {
    let scale = in_len as f64 / out_len as f64;
    let support = 3.0 * scale.max(1.0);
    let mut out = Vec::with_capacity(out_len);
    for o in 0..out_len {
        let center = (o as f64 + 0.5) * scale;
        let lo = ((center - support).floor().max(0.0)) as usize;
        let hi = ((center + support).ceil().min(in_len as f64)) as usize;
        let mut w: Vec<f64> = (lo..hi).map(|i| lanczos3((i as f64 + 0.5 - center) / scale.max(1.0))).collect();
        let sum: f64 = w.iter().sum();
        if sum != 0.0 {
            for v in w.iter_mut() {
                *v /= sum;
            }
        }
        out.push((lo, w));
    }
    out
}

/// Lanczos-3 resize of an RGB or RGBA image. Alpha is resampled like any
/// other channel, which is what Pillow does for RGBA.
pub fn resize_lanczos(img: &Image, out_w: usize, out_h: usize) -> Image {
    let c = img.channels;
    let wx = weights(img.width, out_w);
    let wy = weights(img.height, out_h);

    // Horizontal pass into f32 rows.
    let mut tmp = vec![0f32; out_w * img.height * c];
    let (src, in_w) = (&img.data, img.width);
    crate::par::rows_mut(&mut tmp, out_w * c, |y, trow| {
        let row = &src[y * in_w * c..(y + 1) * in_w * c];
        for (ox, (lo, w)) in wx.iter().enumerate() {
            for ch in 0..c {
                let mut acc = 0.0f64;
                for (k, wk) in w.iter().enumerate() {
                    acc += *wk * row[(lo + k) * c + ch] as f64;
                }
                trow[ox * c + ch] = acc as f32;
            }
        }
    });
    // Vertical pass.
    let mut out = Image::new(out_w, out_h, c);
    let tmp: &[f32] = &tmp;
    crate::par::rows_mut(&mut out.data, out_w * c, |oy, orow| {
        let (lo, w) = &wy[oy];
        for x in 0..out_w {
            for ch in 0..c {
                let mut acc = 0.0f64;
                for (k, wk) in w.iter().enumerate() {
                    acc += *wk * tmp[((lo + k) * out_w + x) * c + ch] as f64;
                }
                orow[x * c + ch] = acc.round().clamp(0.0, 255.0) as u8;
            }
        }
    });
    out
}

/// Bilinear upscale (or downscale) of an RGB/RGBA image.
pub fn resize_bilinear(img: &Image, out_w: usize, out_h: usize) -> Image {
    let c = img.channels;
    let mut out = Image::new(out_w, out_h, c);
    let sx = img.width as f64 / out_w as f64;
    let sy = img.height as f64 / out_h as f64;
    crate::par::rows_mut(&mut out.data, out_w * c, |oy, orow| {
        let fy = ((oy as f64 + 0.5) * sy - 0.5).max(0.0);
        let y0 = fy.floor() as usize;
        let y1 = (y0 + 1).min(img.height - 1);
        let ty = fy - y0 as f64;
        for ox in 0..out_w {
            let fx = ((ox as f64 + 0.5) * sx - 0.5).max(0.0);
            let x0 = fx.floor() as usize;
            let x1 = (x0 + 1).min(img.width - 1);
            let tx = fx - x0 as f64;
            for ch in 0..c {
                let p = |x: usize, y: usize| img.data[(y * img.width + x) * c + ch] as f64;
                let v = p(x0, y0) * (1.0 - tx) * (1.0 - ty) + p(x1, y0) * tx * (1.0 - ty)
                    + p(x0, y1) * (1.0 - tx) * ty + p(x1, y1) * tx * ty;
                orow[ox * c + ch] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    });
    out
}

/// CSS background-size: cover. Scale to fill, crop the overflow centred.
pub fn cover_fit(img: &Image, cw: usize, ch: usize) -> Image {
    let scale = (cw as f64 / img.width as f64).max(ch as f64 / img.height as f64);
    let nw = (img.width as f64 * scale).round().max(cw as f64) as usize;
    let nh = (img.height as f64 * scale).round().max(ch as f64) as usize;
    let resized = if nw == img.width && nh == img.height { img.clone() } else { resize_lanczos(img, nw, nh) };
    let left = (nw - cw) / 2;
    let top = (nh - ch) / 2;
    crop(&resized, left, top, cw, ch)
}

pub fn crop(img: &Image, x: usize, y: usize, w: usize, h: usize) -> Image {
    let c = img.channels;
    let mut out = Image::new(w, h, c);
    for row in 0..h {
        let src = ((y + row) * img.width + x) * c;
        out.data[row * w * c..(row + 1) * w * c].copy_from_slice(&img.data[src..src + w * c]);
    }
    out
}
