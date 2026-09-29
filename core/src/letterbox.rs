//! Vendor padding on dealer photos, found so it can be cropped off:
//! flat letterbox bars (a BMW gallery's ~78px white bands) and a
//! saturated single-hue dealer banner (Tomball Ford's pink studio
//! banner, which made a front shot read as an interior).
//!
//! This replaces the math of imaging/letterbox.py, whose docstring and
//! constants record the real misses and the two failed approaches behind
//! each rule; the constants live in the spec's `letterbox` block now.
//! Hosts crop; the core only measures.

use crate::{spec, Image};

fn k(name: &str) -> f64 { spec::f64_at(&["letterbox", name]) }

fn row_luminance(img: &Image) -> Vec<f64> {
    let c = img.channels;
    (0..img.height).map(|y| {
        let row = &img.data[y * img.width * c..(y + 1) * img.width * c];
        let sum: f64 = row.chunks_exact(c).map(|p| {
            let (r, g, b) = if c >= 3 { (p[0], p[1], p[2]) } else { (p[0], p[0], p[0]) };
            r as f64 * 0.299 + g as f64 * 0.587 + b as f64 * 0.114
        }).sum();
        sum / img.width.max(1) as f64
    }).collect()
}

fn std(v: &[f64]) -> f64 {
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    (v.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / v.len() as f64).sqrt()
}

/// The sharpest single-row jump within the window, trusted only when
/// everything before it is flat: a genuine solid bar.
fn find_edge(rows: &[f64], max_bar: usize) -> usize {
    let window = &rows[..(max_bar + 1).min(rows.len())];
    if window.len() < 2 {
        return 0;
    }
    let mut jump = 0;
    let mut best = -1.0;
    for i in 0..window.len() - 1 {
        let d = (window[i + 1] - window[i]).abs();
        if d > best {
            best = d;
            jump = i;
        }
    }
    if best < k("minJump") || std(&window[..jump + 1]) > k("maxPreJumpStd") {
        return 0;
    }
    jump + 1
}

/// (top, bottom) px of flat padding on each edge, 0 where there is none.
pub fn detect_bars(img: &Image) -> (usize, usize) {
    let max_bar = (img.height as f64 * k("maxBarFrac")) as usize;
    let mut rows = row_luminance(img);
    let top = find_edge(&rows, max_bar);
    rows.reverse();
    let bottom = find_edge(&rows, max_bar);
    let min = k("minBarPx") as usize;
    (if top >= min { top } else { 0 }, if bottom >= min { bottom } else { 0 })
}

/// The most common non-zero top and bottom over a batch from one gallery
/// (a vendor's bar is one size across a batch, so photos whose own edge
/// is too gradual to find get the size the clear ones agree on); ties go
/// to the value seen first.
pub fn batch_bars(bars: &[(usize, usize)]) -> (usize, usize) {
    let mode = |vals: Vec<usize>| -> usize {
        let mut counts: Vec<(usize, usize)> = vec![];
        for v in vals.into_iter().filter(|v| *v > 0) {
            match counts.iter_mut().find(|(x, _)| *x == v) { Some(c) => c.1 += 1, None => counts.push((v, 1)) }
        }
        let mut best: Option<(usize, usize)> = None;
        for (v, n) in counts {
            if best.is_none_or(|(_, bn)| n > bn) { best = Some((v, n)); }
        }
        best.map(|(v, _)| v).unwrap_or(0)
    };
    (mode(bars.iter().map(|b| b.0).collect()), mode(bars.iter().map(|b| b.1).collect()))
}

/// Pillow's RGB to HSV bytes (Convert.c rgb2hsv_row), float for float,
/// so a banner is measured on the numbers the CLI measured it on.
fn pil_hsv(r: u8, g: u8, b: u8) -> (u8, u8) {
    let maxc = r.max(g).max(b);
    let minc = r.min(g).min(b);
    if minc == maxc {
        return (0, 0);
    }
    let cr = (maxc - minc) as f32;
    let s = cr / maxc as f32;
    let rc = (maxc - r) as f32 / cr;
    let gc = (maxc - g) as f32 / cr;
    let bc = (maxc - b) as f32 / cr;
    let h: f32 = if r == maxc { bc - gc } else if g == maxc { 2.0 + rc - bc } else { 4.0 + gc - rc };
    let h = ((h as f64 / 6.0 + 1.0) % 1.0) as f32;
    let clip = |v: f64| (v as i32).clamp(0, 255) as u8;
    (clip(h as f64 * 255.0), clip(s as f64 * 255.0))
}

/// numpy.percentile's default (linear) on a sorted slice.
fn percentile(sorted: &[f64], q: f64) -> f64 {
    let pos = q / 100.0 * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(sorted.len() - 1);
    let t = pos - lo as f64;
    let (a, b) = (sorted[lo], sorted[hi]);
    let d = b - a;
    if t >= 0.5 { b - d * (1.0 - t) } else { a + d * t }
}

fn iqr(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    percentile(v, 75.0) - percentile(v, 25.0)
}

/// Rows of banner in from one edge, walking inward until a row is not
/// mostly saturated in one hue. `rows` yields each row's (hue deg, sat).
fn banner_rows(img: &Image, order: impl Iterator<Item = usize>, max_bar: usize) -> usize {
    let (sat_min, frac_min, iqr_max) = (k("bannerSaturation"), k("bannerMinFraction"), k("bannerMaxHueIqr"));
    let c = img.channels;
    let mut count = 0;
    for (r, y) in order.take(max_bar).enumerate() {
        let row = &img.data[y * img.width * c..(y + 1) * img.width * c];
        let mut hues = vec![];
        for p in row.chunks_exact(c) {
            let (h, s) = if c >= 3 { pil_hsv(p[0], p[1], p[2]) } else { (0, 0) };
            if s as f64 / 255.0 > sat_min {
                hues.push(h as f64 * (360.0 / 255.0));
            }
        }
        if (hues.len() as f64 / img.width.max(1) as f64) < frac_min || hues.len() < 10 {
            break;
        }
        // Hue is circular: a band near the 0/360 wrap reads as a huge
        // spread, so it is measured again turned half round.
        let mut rotated: Vec<f64> = hues.iter().map(|h| (h + 180.0) % 360.0).collect();
        let spread = iqr(&mut hues).min(iqr(&mut rotated));
        if spread > iqr_max {
            break;
        }
        count = r + 1;
    }
    count
}

/// (top, bottom) px of a saturated single-hue dealer banner.
pub fn detect_banner(img: &Image) -> (usize, usize) {
    let max_bar = (img.height as f64 * k("maxBarFrac")) as usize;
    let top = banner_rows(img, 0..img.height, max_bar);
    let bottom = banner_rows(img, (0..img.height).rev(), max_bar);
    let min = k("bannerMinPx") as usize;
    (if top >= min { top } else { 0 }, if bottom >= min { bottom } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_white_band_is_found_and_a_plain_photo_is_left_alone() {
        let (w, h) = (100, 400);
        let mut img = Image::new(w, h, 3);
        for y in 0..h {
            for x in 0..w {
                let v = if y < 40 { 255 } else { ((x * 7 + y * 3) % 90 + 40) as u8 };
                img.data[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&[v, v, v]);
            }
        }
        assert_eq!(detect_bars(&img), (40, 0));
        assert_eq!(batch_bars(&[(40, 0), (0, 0), (39, 0), (40, 0)]), (40, 0));
    }

    #[test]
    fn a_pink_banner_is_found() {
        let (w, h) = (200, 300);
        let mut img = Image::new(w, h, 3);
        for y in 0..h {
            for x in 0..w {
                let px = if y < 30 && (x % 17) > 2 { [230, 30, 120] } else if y < 30 { [255, 255, 255] }
                         else { [((x * 5) % 200) as u8, ((y * 3) % 200) as u8, 90] };
                img.data[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&px);
            }
        }
        assert_eq!(detect_banner(&img), (30, 0));
    }
}
