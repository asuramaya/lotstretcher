//! A vehicle's own colours into a backdrop palette (port of
//! imaging/palette.py; the browser's palette.js is retired by this).

use crate::hsv::{hsv_bytes, rgb_to_hsv};
use crate::spec;
use crate::Image;

fn color_words() -> Vec<(String, [u8; 3])> {
    let mut words = spec::rgb_map(&["palette", "colorWords"]);
    // Longest first, so "dark blue" cannot match a shorter word first.
    words.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.0.cmp(&b.0)));
    words
}

fn word(name: &str) -> [u8; 3] {
    color_words().into_iter().find(|(w, _)| w == name).map(|(_, c)| c).expect("palette word")
}

/// RGB for the first base colour word in a marketing name, or None when
/// the name is pure branding ("Avalanche", "Iconic"). A "#rrggbb" is
/// taken as itself, so a chosen colour travels the same field a name does.
pub fn parse_color_name(name: Option<&str>) -> Option<[u8; 3]> {
    let lowered = name?.trim().to_lowercase();
    if lowered.is_empty() {
        return None;
    }
    if let Some(rgb) = parse_hex(&lowered) {
        return Some(rgb);
    }
    color_words().into_iter().find(|(w, _)| lowered.contains(w.as_str())).map(|(_, c)| c)
}

/// "#rrggbb" (or "#rgb") as RGB; None for anything else.
pub fn parse_hex(text: &str) -> Option<[u8; 3]> {
    let hex = text.strip_prefix('#')?;
    let digit = |c: char| c.to_digit(16).map(|d| d as u8);
    match hex.len() {
        6 => {
            let mut out = [0u8; 3];
            for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
                let hi = digit(pair[0] as char)?;
                let lo = digit(pair[1] as char)?;
                out[i] = hi * 16 + lo;
            }
            Some(out)
        }
        3 => {
            let mut out = [0u8; 3];
            for (i, c) in hex.chars().enumerate() {
                let d = digit(c)?;
                out[i] = d * 17;
            }
            Some(out)
        }
        _ => None,
    }
}

/// The paint colour measured off a cutout: the median of the brighter
/// half of the opaque pixels, so glass, tyres and shadow do not drag it
/// toward black.
pub fn sample_cutout_color(cutout: &Image) -> Option<[u8; 3]> {
    debug_assert_eq!(cutout.channels, 4);
    let mut px: Vec<[u8; 3]> = Vec::new();
    for i in (0..cutout.data.len()).step_by(4) {
        if cutout.data[i + 3] > 200 {
            px.push([cutout.data[i], cutout.data[i + 1], cutout.data[i + 2]]);
        }
    }
    if px.len() < 50 {
        return None;
    }
    let mut values: Vec<u8> = px.iter().map(|p| *p.iter().max().unwrap()).collect();
    values.sort_unstable();
    // numpy.percentile(50) with linear interpolation.
    let n = values.len();
    let pos = (n - 1) as f64 * 0.5;
    let lo = values[pos.floor() as usize] as f64;
    let hi = values[pos.ceil() as usize] as f64;
    let p50 = lo + (hi - lo) * (pos - pos.floor());
    let mut bright: Vec<[u8; 3]> = px.iter().copied().filter(|p| *p.iter().max().unwrap() as f64 >= p50).collect();
    if bright.len() < 20 {
        bright = px;
    }
    let mut out = [0u8; 3];
    for c in 0..3 {
        let mut ch: Vec<u8> = bright.iter().map(|p| p[c]).collect();
        ch.sort_unstable();
        let m = ch.len();
        let med = if m % 2 == 1 { ch[m / 2] as f64 } else { (ch[m / 2 - 1] as f64 + ch[m / 2] as f64) / 2.0 };
        out[c] = crate::hsv::round_half_even(med) as u8;
    }
    Some(out)
}

fn to_backdrop(rgb: [u8; 3]) -> (f64, f64, f64) {
    let (h, mut s, v) = rgb_to_hsv(rgb[0] as f64 / 255.0, rgb[1] as f64 / 255.0, rgb[2] as f64 / 255.0);
    let neutral_ceiling = spec::f64_at(&["palette", "neutralSaturationCeiling"]);
    if s > neutral_ceiling {
        let range = spec::get(&["palette", "backdropSaturationRange"]).as_array().expect("range");
        let lo = range[0].as_f64().unwrap();
        let hi = range[1].as_f64().unwrap();
        s = s.max(lo).min(hi);
    }
    let vmin = spec::f64_at(&["palette", "backdropValueMin"]);
    let vmax = spec::f64_at(&["palette", "backdropValueMax"]);
    let mut out_v = vmin + v * (vmax - vmin);
    // Orange, amber and yellow darken into brown and olive.
    let warm = spec::get(&["palette", "warmHueRange"]).as_array().map(|a| (a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0)));
    if let Some((lo, hi)) = warm {
        if s > neutral_ceiling && h >= lo && h <= hi {
            out_v = out_v.max(spec::f64_at(&["palette", "warmValueMin"]));
        }
    }
    (h, s, out_v)
}

/// (exterior_stop, interior_stop) as backdrop-safe RGB.
pub fn vehicle_gradient_colors(exterior: Option<&str>, interior: Option<&str>, sample: Option<&Image>) -> ([u8; 3], [u8; 3]) {
    let mut ext = parse_color_name(exterior);
    if ext.is_none() {
        if let Some(s) = sample {
            ext = sample_cutout_color(s);
        }
    }
    let ext = ext.unwrap_or_else(|| word("steel"));
    let inr = parse_color_name(interior).unwrap_or_else(|| word("black"));

    let (mut h1, mut s1, mut v1) = to_backdrop(ext);
    let (mut h2, mut s2, mut v2) = to_backdrop(inr);

    let sat = |c: [u8; 3]| rgb_to_hsv(c[0] as f64 / 255.0, c[1] as f64 / 255.0, c[2] as f64 / 255.0).1;
    let neutral_ceiling = spec::f64_at(&["palette", "neutralSaturationCeiling"]);
    let src_neutral = sat(ext).max(sat(inr)) <= neutral_ceiling * 1.5;

    let min_sep = spec::f64_at(&["palette", "minStopSeparation"]);
    let vmin = spec::f64_at(&["palette", "backdropValueMin"]);
    let vmax = spec::f64_at(&["palette", "backdropValueMax"]);
    if (v1 - v2).abs() < min_sep {
        let mid = (v1 + v2) / 2.0;
        let half = min_sep / 2.0;
        if v1 >= v2 { v1 = mid + half; v2 = mid - half; } else { v1 = mid - half; v2 = mid + half; }
        v1 = v1.max(vmin).min(vmax);
        v2 = v2.max(vmin).min(vmax);
    }

    if ((h1 - h2 + 0.5).rem_euclid(1.0) - 0.5).abs() < 0.02 && (s1 - s2).abs() < 0.05 {
        if src_neutral {
            let tint_h = spec::f64_at(&["palette", "neutralTintHue"]);
            let tint_s = spec::f64_at(&["palette", "neutralTintSaturation"]);
            if v1 >= v2 { h1 = tint_h; s1 = tint_s; } else { h2 = tint_h; s2 = tint_s; }
        } else {
            h2 += spec::f64_at(&["palette", "matchingHueShift"]);
        }
    }
    (hsv_bytes(h1, s1, v1), hsv_bytes(h2, s2, v2))
}
