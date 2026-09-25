//! Cutout edge refinement: a matte computed small (the browser's u2net
//! runs at 256x256) and stretched to the photo is soft for several pixels
//! and carries the old background's colour in that rim, which reads as a
//! pale halo on a dark backdrop. Two O(n) passes fix both, the same on
//! the CLI and in the browser:
//!
//! 1. A guided filter (He, Sun and Tang 2010) with the photo's luminance
//!    as the guide, applied only in the uncertain band around the edge,
//!    so the alpha follows the vehicle's real outline.
//! 2. Blur-fusion foreground estimation (Germer et al. 2020, "Fast
//!    Multi-Level Foreground Estimation"): each edge pixel's colour is
//!    re-estimated as foreground alone, with the local background taken
//!    out, so a white showroom wall no longer tints the rim.
//!
//! Interior pixels (alpha 1) keep their colour exactly; the arithmetic
//! is rows of box filters, parallel where the core has threads.

use crate::par;
use crate::spec;
use crate::Image;

/// Mean over a (2r+1) square window, clamped at the edges (divided by
/// the pixels actually inside), separable: rows, then columns.
fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 { return src.to_vec(); }
    let rows = box_rows(src, w, h, r);
    box_cols(&rows, w, h, r)
}

/// The vertical pass as a running sum of whole rows: every access walks
/// memory in order, where a transpose jumps a row's width per read.
fn box_cols(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    let mut acc = vec![0f32; w];
    let hi0 = r.min(h - 1);
    for y in 0..=hi0 { for (a, v) in acc.iter_mut().zip(&src[y * w..(y + 1) * w]) { *a += *v; } }
    for y in 0..h {
        let lo = y.saturating_sub(r);
        let hi = (y + r).min(h - 1);
        let inv = 1.0 / (hi - lo + 1) as f32;
        for (o, a) in out[y * w..(y + 1) * w].iter_mut().zip(&acc) { *o = a * inv; }
        if y + r + 1 < h { for (a, v) in acc.iter_mut().zip(&src[(y + r + 1) * w..(y + r + 2) * w]) { *a += *v; } }
        if y >= r { for (a, v) in acc.iter_mut().zip(&src[(y - r) * w..(y - r + 1) * w]) { *a -= *v; } }
    }
    out
}

fn box_rows(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    par::rows_mut(&mut out, w, |y, row| {
        let s = &src[y * w..(y + 1) * w];
        let mut sum = 0f64;
        let hi0 = r.min(w - 1);
        for v in &s[..=hi0] { sum += *v as f64; }
        for x in 0..w {
            let lo = x.saturating_sub(r);
            let hi = (x + r).min(w - 1);
            row[x] = (sum / (hi - lo + 1) as f64) as f32;
            // Slide: add the next right pixel, drop the left one.
            if x + r + 1 < w { sum += s[x + r + 1] as f64; }
            if x >= r { sum -= s[x - r] as f64; }
        }
    });
    out
}


/// Block-average by `k` (edge blocks averaged over what they hold).
fn shrink(src: &[f32], w: usize, h: usize, k: usize, sw: usize, sh: usize) -> Vec<f32> {
    let mut out = vec![0f32; sw * sh];
    par::rows_mut(&mut out, sw, |sy, row| {
        let y0 = sy * k; let y1 = (y0 + k).min(h);
        for (sx, v) in row.iter_mut().enumerate() {
            let x0 = sx * k; let x1 = (x0 + k).min(w);
            let mut sum = 0f32;
            for y in y0..y1 { for x in x0..x1 { sum += src[y * w + x]; } }
            *v = sum / ((y1 - y0) * (x1 - x0)) as f32;
        }
    });
    out
}

/// A shrunk plane read back at full-resolution pixel (x, y), bilinear
/// between block centres.
#[inline]
fn sample(src: &[f32], sw: usize, sh: usize, k: usize, x: usize, y: usize) -> f32 {
    let fx = ((x as f32 + 0.5) / k as f32 - 0.5).clamp(0.0, (sw - 1) as f32);
    let fy = ((y as f32 + 0.5) / k as f32 - 0.5).clamp(0.0, (sh - 1) as f32);
    let (x0, y0) = (fx as usize, fy as usize);
    let (x1, y1) = ((x0 + 1).min(sw - 1), (y0 + 1).min(sh - 1));
    let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
    let a = src[y0 * sw + x0] * (1.0 - tx) + src[y0 * sw + x1] * tx;
    let b = src[y1 * sw + x0] * (1.0 - tx) + src[y1 * sw + x1] * tx;
    a * (1.0 - ty) + b * ty
}

fn param(key: &str, default: f64) -> f64 {
    spec::get(&["matteRefine", key]).as_f64().unwrap_or(default)
}

/// Refine an RGBA cutout (the photo with the stretched matte as alpha)
/// in place of its alpha and edge colours. Returns a new RGBA image of
/// the same size.
pub fn refine_cutout(img: &Image) -> Result<Image, String> {
    if img.channels != 4 { return Err("refine_cutout needs RGBA".into()); }
    let (w, h) = (img.width, img.height);
    let n = w * h;
    if n == 0 { return Ok(img.clone()); }
    let short = w.min(h) as f64;
    let r_guide = ((short * param("guideRadiusFrac", 0.006)).round() as usize).max(2);
    let eps = param("guideEps", 2e-4) as f32;
    let lo = param("edgeLow", 0.12) as f32;
    let hi = param("edgeHigh", 0.88) as f32;
    let r_wide = ((short * param("fgWideRadiusFrac", 0.09)).round() as usize).max(8);
    let r_fine = ((short * param("fgFineRadiusFrac", 0.006)).round() as usize).max(2);

    let px = &img.data;
    let mut a = vec![0f32; n];
    let mut g = vec![0f32; n];
    let mut rgb = [vec![0f32; n], vec![0f32; n], vec![0f32; n]];
    for i in 0..n {
        let (r, gg, b) = (px[i * 4] as f32 / 255.0, px[i * 4 + 1] as f32 / 255.0, px[i * 4 + 2] as f32 / 255.0);
        rgb[0][i] = r; rgb[1][i] = gg; rgb[2][i] = b;
        g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
        a[i] = px[i * 4 + 3] as f32 / 255.0;
    }

    // 1. Guided filter, kept to the band where the matte is uncertain.
    let mean_a = box_mean(&a, w, h, r_guide);
    let mean_g = box_mean(&g, w, h, r_guide);
    let gg: Vec<f32> = g.iter().map(|v| v * v).collect();
    let ga: Vec<f32> = g.iter().zip(&a).map(|(x, y)| x * y).collect();
    let mean_gg = box_mean(&gg, w, h, r_guide);
    let mean_ga = box_mean(&ga, w, h, r_guide);
    let mut ca = vec![0f32; n];
    let mut cb = vec![0f32; n];
    for i in 0..n {
        let var = mean_gg[i] - mean_g[i] * mean_g[i];
        let cov = mean_ga[i] - mean_g[i] * mean_a[i];
        ca[i] = cov / (var + eps);
        cb[i] = mean_a[i] - ca[i] * mean_g[i];
    }
    let ma = box_mean(&ca, w, h, r_guide);
    let mb = box_mean(&cb, w, h, r_guide);
    let mut alpha = a.clone();
    for i in 0..n {
        let m = mean_a[i];
        if m > 0.002 && m < 0.998 {
            let q = (ma[i] * g[i] + mb[i]).clamp(0.0, 1.0);
            // Stretch the band's contrast so the faint veil a stretched
            // matte leaves outside the car goes to nothing and the edge
            // reads as an edge, not a haze.
            alpha[i] = ((q - lo) / (hi - lo)).clamp(0.0, 1.0);
        }
    }

    // 2. Foreground colour, two blur-fusion passes. A colour only moves
    //    where the alpha is partial (an opaque pixel's estimate is its
    //    own colour, a clear one's is multiplied away), so both passes
    //    write only the band and what the fine pass reads around it.
    let partial: Vec<f32> = alpha.iter().map(|&a| if a > 0.0 && a < 1.0 { 1.0 } else { 0.0 }).collect();
    let near = box_mean(&partial, w, h, r_fine);
    let live: Vec<usize> = (0..n).filter(|&i| near[i] > 0.0).collect();

    let mut f = rgb.clone();
    let mut bg = rgb.clone();

    // Wide pass: its means are smooth at its radius, so they are taken on
    // a copy shrunk by k and read back bilinearly at the live pixels.
    {
        let k = (r_wide / 12).clamp(1, 8);
        let (sw, sh) = (w.div_ceil(k), h.div_ceil(k));
        let rs = (r_wide / k).max(1);
        let sa = box_mean(&shrink(&alpha, w, h, k, sw, sh), sw, sh, rs);
        for c in 0..3 {
            let fa: Vec<f32> = rgb[c].iter().zip(&alpha).map(|(x, y)| x * y).collect();
            let b1a: Vec<f32> = rgb[c].iter().zip(&alpha).map(|(x, y)| x * (1.0 - y)).collect();
            let sfa = box_mean(&shrink(&fa, w, h, k, sw, sh), sw, sh, rs);
            let sb1a = box_mean(&shrink(&b1a, w, h, k, sw, sh), sw, sh, rs);
            let sbf: Vec<f32> = sfa.iter().zip(&sa).map(|(x, a)| x / (a + 1e-5)).collect();
            let sbb: Vec<f32> = sb1a.iter().zip(&sa).map(|(x, a)| x / ((1.0 - a) + 1e-5)).collect();
            for &i in &live {
                let (x, y) = (i % w, i / w);
                let bf = sample(&sbf, sw, sh, k, x, y);
                let bb = sample(&sbb, sw, sh, k, x, y);
                let al = alpha[i];
                f[c][i] = (bf + al * (rgb[c][i] - al * bf - (1.0 - al) * bb)).clamp(0.0, 1.0);
                bg[c][i] = bb;
            }
        }
    }

    // Fine pass, full resolution, written at the band only.
    {
        let ba = box_mean(&alpha, w, h, r_fine);
        for c in 0..3 {
            let fa: Vec<f32> = f[c].iter().zip(&alpha).map(|(x, y)| x * y).collect();
            let b1a: Vec<f32> = bg[c].iter().zip(&alpha).map(|(x, y)| x * (1.0 - y)).collect();
            let bfa = box_mean(&fa, w, h, r_fine);
            let bb1a = box_mean(&b1a, w, h, r_fine);
            let mut nf = f[c].clone();
            for &i in &live {
                let al = alpha[i];
                if al <= 0.0 || al >= 1.0 { continue; }
                let bf = bfa[i] / (ba[i] + 1e-5);
                let bb = bb1a[i] / ((1.0 - ba[i]) + 1e-5);
                nf[i] = (bf + al * (rgb[c][i] - al * bf - (1.0 - al) * bb)).clamp(0.0, 1.0);
            }
            f[c] = nf;
        }
    }

    let mut out = Image::new(w, h, 4);
    for i in 0..n {
        let al = alpha[i];
        for c in 0..3 {
            // A fully opaque pixel keeps the photo's own colour, byte for byte.
            out.data[i * 4 + c] = if al >= 1.0 { px[i * 4 + c] } else { (f[c][i] * 255.0).round() as u8 };
        }
        out.data[i * 4 + 3] = (al * 255.0).round() as u8;
    }
    Ok(out)
}
