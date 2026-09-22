//! HSV conversions matching Python's colorsys (h, s, v all in [0, 1]).

pub fn rgb_to_hsv(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let maxc = r.max(g).max(b);
    let minc = r.min(g).min(b);
    let v = maxc;
    if minc == maxc {
        return (0.0, 0.0, v);
    }
    let s = (maxc - minc) / maxc;
    let rc = (maxc - r) / (maxc - minc);
    let gc = (maxc - g) / (maxc - minc);
    let bc = (maxc - b) / (maxc - minc);
    let h = if r == maxc { bc - gc } else if g == maxc { 2.0 + rc - bc } else { 4.0 + gc - rc };
    let h = (h / 6.0).rem_euclid(1.0);
    (h, s, v)
}

pub fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    if s == 0.0 {
        return (v, v, v);
    }
    let i = (h * 6.0).floor() as i64;
    let f = h * 6.0 - i as f64;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i.rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

/// Python's round(): half to even.
pub fn round_half_even(x: f64) -> f64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && r % 2.0 != 0.0 { r - x.signum() } else { r }
}

/// colorsys.hsv_to_rgb -> bytes, with the Python's clamping and rounding.
pub fn hsv_bytes(h: f64, s: f64, v: f64) -> [u8; 3] {
    let (r, g, b) = hsv_to_rgb(h.rem_euclid(1.0), s.clamp(0.0, 1.0), v.clamp(0.0, 1.0));
    [round_half_even(r * 255.0) as u8, round_half_even(g * 255.0) as u8, round_half_even(b * 255.0) as u8]
}
