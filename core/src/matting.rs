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
    let t = transpose(&rows, w, h);
    let cols = box_rows(&t, h, w, r);
    transpose(&cols, h, w)
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

fn transpose(src: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    par::rows_mut(&mut out, h, |x, col| {
        for y in 0..h { col[y] = src[y * w + x]; }
    });
    out
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

    // 2. Foreground colour: two blur-fusion passes, wide then fine.
    let mut f = rgb.clone();
    let mut bg = rgb.clone();
    for r in [r_wide, r_fine] {
        let ba = box_mean(&alpha, w, h, r);
        let mut nf = [vec![0f32; n], vec![0f32; n], vec![0f32; n]];
        let mut nb = [vec![0f32; n], vec![0f32; n], vec![0f32; n]];
        for c in 0..3 {
            let fa: Vec<f32> = f[c].iter().zip(&alpha).map(|(x, y)| x * y).collect();
            let b1a: Vec<f32> = bg[c].iter().zip(&alpha).map(|(x, y)| x * (1.0 - y)).collect();
            let bfa = box_mean(&fa, w, h, r);
            let bb1a = box_mean(&b1a, w, h, r);
            for i in 0..n {
                let bf = bfa[i] / (ba[i] + 1e-5);
                let bb = bb1a[i] / ((1.0 - ba[i]) + 1e-5);
                let al = alpha[i];
                nf[c][i] = (bf + al * (rgb[c][i] - al * bf - (1.0 - al) * bb)).clamp(0.0, 1.0);
                nb[c][i] = bb;
            }
        }
        f = nf;
        bg = nb;
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
