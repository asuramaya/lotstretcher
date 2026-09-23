//! The adaptive spotlight dim (port of compose/background.py's
//! compute_dim_strength and apply_spotlight).

use crate::spec;
use crate::Image;

#[inline]
fn luminance(r: f64, g: f64, b: f64) -> f64 {
    r * 0.299 + g * 0.587 + b * 0.114
}

/// How hard to dim the backdrop so the car reads as brighter, from the
/// measured contrast between the car's opaque pixels and the patch of
/// background that will sit behind it. 1.0 means no dimming.
pub fn compute_dim_strength(bg_region: &Image, car: &Image) -> f64 {
    let margin = spec::f64_at(&["compose", "spotlight", "dimMargin"]);
    let min_dim = spec::f64_at(&["compose", "spotlight", "minDim"]);
    let max_dim = spec::f64_at(&["compose", "spotlight", "maxDim"]);

    let mut car_sum = 0.0;
    let mut alpha_sum = 0.0;
    for i in (0..car.data.len()).step_by(4) {
        let a = car.data[i + 3] as f64 / 255.0;
        car_sum += luminance(car.data[i] as f64, car.data[i + 1] as f64, car.data[i + 2] as f64) * a;
        alpha_sum += a;
    }
    if alpha_sum < 1.0 {
        return 1.0;
    }
    let car_lum = car_sum / alpha_sum;

    let c = bg_region.channels;
    let n = (bg_region.data.len() / c).max(1);
    let mut bg_sum = 0.0;
    for i in (0..bg_region.data.len()).step_by(c) {
        bg_sum += luminance(bg_region.data[i] as f64, bg_region.data[i + 1] as f64, bg_region.data[i + 2] as f64);
    }
    let bg_lum = bg_sum / n as f64;

    let target = car_lum - margin;
    if bg_lum <= target || bg_lum <= 0.0 {
        return 1.0;
    }
    let dim = if target > 0.0 { target / bg_lum } else { min_dim };
    dim.clamp(min_dim, max_dim)
}

/// Radial dim: full brightness within innerRadiusFrac of `center`,
/// fading to `dim` by outerRadiusFrac, flat beyond. Radii are fractions
/// of the distance to the farthest corner. In place, RGB or RGBA.
pub fn apply_spotlight(canvas: &mut Image, cx: f64, cy: f64, dim: f64) {
    if dim >= 1.0 {
        return;
    }
    let (w, h, c) = (canvas.width, canvas.height, canvas.channels);
    let factor = spotlight_factor(w, h, cx, cy, dim);
    // Fixed point: the factor is in [dim, 1], so a 16.16 multiply and a
    // shift reproduce the f32 multiply-then-truncate to the pixel.
    let factor: &[f32] = &factor;
    crate::par::rows_mut(&mut canvas.data, w * c, |y, row| {
        let frow = &factor[y * w..(y + 1) * w];
        for x in 0..w {
            let f = (frow[x] * 65536.0) as u32;
            let p = x * c;
            for ch in 0..3 {
                row[p + ch] = ((row[p + ch] as u32 * f) >> 16) as u8;
            }
        }
    });
}

thread_local! {
    static FACTOR_CACHE: std::cell::RefCell<Vec<((usize, usize, i64, i64, i64), std::rc::Rc<Vec<f32>>)>> =
        std::cell::RefCell::new(Vec::new());
}
const FACTOR_CACHE_MAX: usize = 16;

/// The radial falloff, memoized on (size, centre, dim). A video holds
/// one centre and dim for a whole shot, so the map is built once per
/// shot rather than once per frame. Keyed on rounded values so
/// floating-point jitter cannot defeat the cache.
fn spotlight_factor(w: usize, h: usize, cx: f64, cy: f64, dim: f64) -> std::rc::Rc<Vec<f32>> {
    let key = (w, h, cx.round() as i64, cy.round() as i64, (dim * 1000.0).round() as i64);
    if let Some(hit) = FACTOR_CACHE.with(|c| c.borrow().iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())) {
        return hit;
    }
    let inner = spec::f64_at(&["compose", "spotlight", "innerRadiusFrac"]);
    let outer = spec::f64_at(&["compose", "spotlight", "outerRadiusFrac"]);
    let max_dist = [(0.0, 0.0), (w as f64, 0.0), (0.0, h as f64), (w as f64, h as f64)]
        .iter()
        .map(|(px, py)| ((cx - px).powi(2) + (cy - py).powi(2)).sqrt())
        .fold(0.0, f64::max);
    let inv = 1.0 / (max_dist * (outer - inner));
    let mut factor = vec![0f32; w * h];
    crate::par::rows_mut(&mut factor, w, |y, row| {
        let dy2 = (y as f64 - cy).powi(2);
        for x in 0..w {
            let dist = (((x as f64 - cx).powi(2) + dy2).sqrt() - inner * max_dist) * inv;
            let t = dist.clamp(0.0, 1.0);
            let smooth = t * t * (3.0 - 2.0 * t);
            row[x] = (1.0 - smooth * (1.0 - dim)) as f32;
        }
    });
    let rc = std::rc::Rc::new(factor);
    FACTOR_CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= FACTOR_CACHE_MAX { c.remove(0); }
        c.push((key, rc.clone()));
    });
    rc
}
