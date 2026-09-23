//! Interior photo treatment (port of imaging/interior.py's pixel maths):
//! a partial, capped white balance from bright near-neutral pixels, an
//! exposure lift that holds the highlights, and the gradient scrim a
//! callout sits on. Whole photos in, whole photos out, same size; the
//! text itself is drawn by the host, which owns the fonts.
//!
//! Arithmetic is single precision throughout, matching the float32
//! numpy it replaced, and pixels are truncated (not rounded) on the way
//! back to bytes, as astype("uint8") did.

use crate::spec;
use crate::Image;

#[inline]
fn lum(r: f32, g: f32, b: f32) -> f32 { r * 0.299 + g * 0.587 + b * 0.114 }

fn median_f32(v: &mut [f32]) -> f32 {
    let n = v.len();
    if n == 0 { return 0.0; }
    let mid = n / 2;
    let (_, m, _) = v.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap());
    let hi = *m;
    if n % 2 == 1 { return hi; }
    let lo = v[..mid].iter().cloned().fold(f32::MIN, f32::max);
    (lo + hi) / 2.0
}

/// numpy's default (linear) percentile.
fn percentile_f32(v: &mut [f32], q: f64) -> f32 {
    let n = v.len();
    if n == 0 { return 0.0; }
    let pos = q / 100.0 * (n - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil().min((n - 1) as f64) as usize;
    let frac = (pos - lo as f64) as f32;
    let (_, a, _) = v.select_nth_unstable_by(lo, |a, b| a.partial_cmp(b).unwrap());
    let a = *a;
    if hi == lo { return a; }
    let b = v[lo + 1..].iter().cloned().fold(f32::MAX, f32::min);
    a + (b - a) * frac
}

/// Lift a dark cabin toward a readable midtone, holding the highlights.
/// Gamma (only ever <= 1, so only ever brighter), faded out across the
/// highlight knee..ceiling of the ORIGINAL luminance.
pub fn enhance_exposure(img: &Image, target_median: f32, max_lift: f32) -> Image {
    let c = img.channels;
    let n = img.width * img.height;
    let mut l = Vec::with_capacity(n);
    for i in 0..n {
        let p = i * c;
        l.push(lum(img.data[p] as f32 / 255.0, img.data[p + 1] as f32 / 255.0, img.data[p + 2] as f32 / 255.0));
    }
    let median = median_f32(&mut l.clone());
    if median <= 0.001 || median >= target_median { return img.clone(); }
    let gamma = ((target_median as f64).ln() / (median as f64).ln()).max(max_lift as f64) as f32;
    let knee = spec::f64_at(&["interior", "highlightKnee"]) as f32;
    let ceiling = spec::f64_at(&["interior", "highlightCeiling"]) as f32;
    let mut out = img.clone();
    for i in 0..n {
        let t = ((l[i] - knee) / (ceiling - knee)).clamp(0.0, 1.0);
        let protect = t * t * (3.0 - 2.0 * t);
        let p = i * c;
        for ch in 0..3 {
            let v = img.data[p + ch] as f32 / 255.0;
            let lifted = v.powf(gamma);
            let blended = lifted * (1.0 - protect) + v * protect;
            out.data[p + ch] = (blended.clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    out
}

/// Take a colour cast off the cabin, estimated from bright near-neutral
/// pixels only; unchanged when there is no meaningful cast.
pub fn correct_white_balance(img: &Image) -> Image {
    let c = img.channels;
    let n = img.width * img.height;
    let min_cast = spec::f64_at(&["interior", "whiteBalanceMinCast"]) as f32;
    let strength = spec::f64_at(&["interior", "whiteBalanceStrength"]) as f32;
    let max_gain = spec::f64_at(&["interior", "whiteBalanceMaxGain"]) as f32;
    let pct = spec::f64_at(&["interior", "whiteBalanceBrightPercentile"]);
    let min_sample = spec::f64_at(&["interior", "whiteBalanceMinSample"]) as usize;

    let mut bright = Vec::with_capacity(n);
    for i in 0..n {
        let p = i * c;
        let (r, g, b) = (img.data[p] as f32 / 255.0, img.data[p + 1] as f32 / 255.0, img.data[p + 2] as f32 / 255.0);
        bright.push(r.max(g).max(b));
    }
    let threshold = percentile_f32(&mut bright.clone(), pct);
    let mut sums = [0f64; 3];
    let mut count = 0usize;
    for i in 0..n {
        let p = i * c;
        let (r, g, b) = (img.data[p] as f32 / 255.0, img.data[p + 1] as f32 / 255.0, img.data[p + 2] as f32 / 255.0);
        let hi = bright[i];
        let spread = hi - r.min(g).min(b);
        if hi >= threshold && spread <= 0.18 * hi.max(1e-6) + 0.06 && hi < 0.99 {
            sums[0] += r as f64; sums[1] += g as f64; sums[2] += b as f64;
            count += 1;
        }
    }
    if count < min_sample { return img.clone(); }
    let means = [(sums[0] / count as f64) as f32, (sums[1] / count as f64) as f32, (sums[2] / count as f64) as f32];
    let (lo, hi) = (means[0].min(means[1]).min(means[2]), means[0].max(means[1]).max(means[2]));
    if lo <= 1e-6 { return img.clone(); }
    let mean = (means[0] + means[1] + means[2]) / 3.0;
    if (hi - lo) / mean < min_cast { return img.clone(); }
    let gains: Vec<f32> = means.iter().map(|m| {
        let g = (mean / m).clamp(1.0 / max_gain, max_gain);
        1.0 + (g - 1.0) * strength
    }).collect();
    let mut out = img.clone();
    for i in 0..n {
        let p = i * c;
        for ch in 0..3 {
            let v = img.data[p + ch] as f32 / 255.0 * gains[ch];
            out.data[p + ch] = (v.clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    out
}

/// The whole non-destructive treatment: neutralise, then lift. White
/// balance first so the lift measures a neutral image.
pub fn enhance_interior(img: &Image) -> Image {
    let target = spec::f64_at(&["interior", "targetMedian"]) as f32;
    let max_lift = spec::f64_at(&["interior", "maxLift"]) as f32;
    enhance_exposure(&correct_white_balance(img), target, max_lift)
}

/// A gradient scrim up from the bottom edge: darkening that ramps from
/// nothing to scrimStrength over the bottom band, with scrimGamma
/// shaping the ramp, so a line of text reads whatever is behind it.
pub fn scrim(img: &Image, band_frac: f32) -> Image {
    let strength = spec::f64_at(&["interior", "scrimStrength"]) as f32;
    let gamma = spec::f64_at(&["interior", "scrimGamma"]) as f32;
    let (w, h, c) = (img.width, img.height, img.channels);
    let band = ((h as f32 * band_frac) as usize).max(1).min(h);
    let mut out = img.clone();
    for row in 0..band {
        let step = if band > 1 { (row as f64 * (strength as f64 / (band - 1) as f64)) as f32 } else { 0.0 };
        let keep = 1.0 - step.powf(gamma);
        let y = h - band + row;
        for x in 0..w {
            let p = (y * w + x) * c;
            for ch in 0..3 {
                out.data[p + ch] = ((img.data[p + ch] as f32 * keep).clamp(0.0, 255.0)) as u8;
            }
        }
    }
    out
}
