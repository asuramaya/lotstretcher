//! A border frame's transparent window, and keeping cars out of its art
//! (port of compose/window.py).

use crate::Image;

pub type Window = (i64, i64, i64, i64);

fn widest_run(mask: impl Iterator<Item = bool>) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut start: Option<usize> = None;
    let mut last = 0usize;
    for (i, on) in mask.enumerate() {
        if on {
            if start.is_none() { start = Some(i); }
            last = i;
        } else if let Some(s) = start.take() {
            if best.map_or(true, |(a, b)| last - s > b - a) { best = Some((s, last)); }
        }
    }
    if let Some(s) = start {
        if best.map_or(true, |(a, b)| last - s > b - a) { best = Some((s, last)); }
    }
    best
}

/// The main transparent window as (left, top, right, bottom): the
/// widest near-transparent run across rows through the middle, then
/// down columns, so corner cut-outs and logo holes cannot fool it.
pub fn detect_window(border: &Image) -> Result<Window, String> {
    debug_assert_eq!(border.channels, 4);
    let (w, h) = (border.width, border.height);
    let alpha = |x: usize, y: usize| border.data[(y * w + x) * 4 + 3] < 10;
    let min_w = (w as f64 * 0.5) as usize;
    let min_h = (h as f64 * 0.5) as usize;

    let mut lr: Option<(usize, usize)> = None;
    let mut y = h / 4;
    while y < 3 * h / 4 {
        if let Some(run) = widest_run((0..w).map(|x| alpha(x, y))) {
            if lr.map_or(true, |(l, r)| run.1 - run.0 > r - l) && run.1 - run.0 >= min_w { lr = Some(run); }
        }
        y += (h / 40).max(1);
    }
    let mut tb: Option<(usize, usize)> = None;
    let mut x = w / 4;
    while x < 3 * w / 4 {
        if let Some(run) = widest_run((0..h).map(|yy| alpha(x, yy))) {
            if tb.map_or(true, |(t, b)| run.1 - run.0 > b - t) && run.1 - run.0 >= min_h { tb = Some(run); }
        }
        x += (w / 40).max(1);
    }
    match (lr, tb) {
        (Some((l, r)), Some((t, b))) => Ok((l as i64, t as i64, r as i64, b as i64)),
        _ => Err("could not find a transparent window in this border image".into()),
    }
}

/// Nudge a car at (x, y) straight down until its opaque pixels clear
/// the border's opaque pixels, then a little further for breathing
/// room; the least-overlapping y tried if it never clears.
pub fn resolve_collision(border: &Image, car: &Image, x: i64, y: i64) -> i64 {
    let (max_shift, step, margin_frac) = (300i64, 3i64, 0.04f64);
    let (bw, bh) = (border.width as i64, border.height as i64);
    let (cw, ch) = (car.width as i64, car.height as i64);
    let overlap_at = |yy: i64| -> Option<usize> {
        if yy < 0 || yy + ch > bh || x < 0 || x + cw > bw { return None; }
        let mut n = 0;
        for cy in 0..ch {
            for cx in 0..cw {
                let ca = car.data[((cy * cw + cx) * 4 + 3) as usize] >= 10;
                if !ca { continue; }
                let ba = border.data[(((yy + cy) * bw + (x + cx)) * 4 + 3) as usize] >= 10;
                if ba { n += 1; }
            }
        }
        Some(n)
    };
    let mut best = (y, None::<usize>);
    let mut shift = 0;
    while shift <= max_shift {
        let yy = y + shift;
        let Some(overlap) = overlap_at(yy) else { break };
        if overlap == 0 {
            let padded = yy + (crate::hsv::round_half_even(ch as f64 * margin_frac) as i64).max(1);
            return if overlap_at(padded) == Some(0) { padded } else { yy };
        }
        if best.1.map_or(true, |b| overlap < b) { best = (yy, Some(overlap)); }
        shift += step;
    }
    best.0
}
