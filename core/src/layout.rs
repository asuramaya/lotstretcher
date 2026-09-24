//! Where each cutout goes (port of compose/layout.py).

/// (left, top, right, bottom)
pub type Box_ = (i64, i64, i64, i64);

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Anchor { Center, Bottom }

pub struct Placement { pub x: i64, pub y: i64, pub w: usize, pub h: usize }

/// Scale a (cw x ch) cutout to fit `bx` minus a margin; centred
/// horizontally, centred or bottom-anchored vertically.
pub fn compute_placement(cw: usize, ch: usize, bx: Box_, margin_frac: f64, anchor: Anchor) -> Placement {
    let (bl, bt, br, bb) = bx;
    let avail_w = (br - bl) as f64 * (1.0 - 2.0 * margin_frac);
    let avail_h = (bb - bt) as f64 * (1.0 - 2.0 * margin_frac);
    let scale = (avail_w / cw as f64).min(avail_h / ch as f64);
    let w = ((cw as f64 * scale).round() as usize).max(1);
    let h = ((ch as f64 * scale).round() as usize).max(1);
    let x = bl + ((br - bl) - w as i64).div_euclid(2);
    let y = match anchor {
        Anchor::Bottom => bb - ((bb - bt) as f64 * margin_frac) as i64 - h as i64,
        Anchor::Center => bt + ((bb - bt) - h as i64).div_euclid(2),
    };
    Placement { x, y, w, h }
}

fn r(x: f64) -> i64 { crate::hsv::round_half_even(x) as i64 }

pub fn single(window: Box_, _n_extra: usize) -> Vec<(Box_, Anchor)> {
    vec![(window, Anchor::Center)]
}

pub fn corners(window: Box_, n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    let (ww, wh) = ((wr - wl) as f64, (wb - wt) as f64);
    let (aw, ah) = (r(ww * 0.40), r(wh * 0.30));
    let corners = [(wl, wt), (wr - aw, wt)];
    let accents: Vec<(Box_, Anchor)> = corners.iter().take(n_extra)
        .map(|(ax, ay)| ((*ax, *ay, ax + aw, ay + ah), Anchor::Center)).collect();
    let hero_top = if accents.is_empty() { wt } else { wt + ah + r(wh * 0.02) };
    let mut out = vec![((wl, hero_top, wr, wb), Anchor::Bottom)];
    out.extend(accents);
    out
}

pub fn quad(window: Box_, _n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    let (ww, wh) = ((wr - wl) as f64, (wb - wt) as f64);
    let gap = r(ww * 0.02);
    let (cw, ch) = (r(ww * 0.32), r(wh * 0.26));
    let top_left = (wl, wt, wl + cw, wt + ch);
    let top_right = (wr - cw, wt, wr, wt + ch);
    let side_h = r(ch as f64 * 0.85);
    let side = (top_left.2 + gap, wt, top_right.0 - gap, wt + side_h);
    let row_bottom = top_left.3.max(top_right.3).max(side.3);
    vec![
        ((wl, row_bottom + gap, wr, wb), Anchor::Bottom),
        (top_left, Anchor::Center),
        (top_right, Anchor::Center),
        (side, Anchor::Center),
    ]
}

const CONVEYOR_MAX_HERO_ASPECT: f64 = 2.1;
const CONVEYOR_HERO_ASPECT: f64 = 1.55;
const CONVEYOR_ACCENT_ASPECT: f64 = 1.75;

pub fn conveyor(window: Box_, _n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    let (ww, wh) = ((wr - wl) as f64, (wb - wt) as f64);
    let (aw, ah) = (r(ww * 0.46), r(wh * 0.34));
    let gap = r(wh * 0.015);
    let left = (wl, wt, wl + aw, wt + ah);
    let right = (wr - aw, wt, wr, wt + ah);
    let hero_top = wt + ah + gap;
    let hero_h = wb - hero_top;
    let hero_w = (ww as i64).min(r(hero_h as f64 * CONVEYOR_MAX_HERO_ASPECT));
    let hero_l = wl + ((ww as i64) - hero_w).div_euclid(2);
    vec![((hero_l, hero_top, hero_l + hero_w, wb), Anchor::Bottom), (left, Anchor::Center), (right, Anchor::Center)]
}

pub fn conveyor_stack(window: Box_, _n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    let (ww, wh) = (wr - wl, wb - wt);
    let hero_w = ww;
    let hero_h = wh.min(r(hero_w as f64 / CONVEYOR_HERO_ASPECT));
    let aw = r(ww as f64 * 0.62);
    let ah = r(aw as f64 / CONVEYOR_ACCENT_ASPECT);
    let hero_top = wt + (wh - hero_h).div_euclid(2);
    let hero = (wl, hero_top, wr, hero_top + hero_h);
    let top_band = hero_top - wt;
    let bottom_band = wb - (hero_top + hero_h);
    // A short window (a frame's, or one with a text band taken off) can
    // leave a band shorter than the accent: the accent shrinks to the
    // band, never past the window's edge where the frame would cut it.
    // Less a breath of air, so a tall hero never touches its accents.
    let band = (top_band.min(bottom_band) - r(wh as f64 * 0.03)).max(1);
    let (aw, ah) = if ah > band { (r(band as f64 * CONVEYOR_ACCENT_ASPECT).min(ww).max(1), band) } else { (aw, ah) };
    let al = wl + (ww - aw).div_euclid(2);
    let top_y = wt + ((top_band - ah).div_euclid(2)).max(0);
    let bottom_y = hero_top + hero_h + ((bottom_band - ah).div_euclid(2)).max(0);
    vec![
        (hero, Anchor::Center),
        ((al, top_y, al + aw, top_y + ah), Anchor::Center),
        ((al, bottom_y, al + aw, bottom_y + ah), Anchor::Center),
    ]
}

/// Whichever conveyor suits the frame: stacked once taller than wide.
pub fn conveyor_for_window(window: Box_, n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    if (wr - wl) < (wb - wt) { conveyor_stack(window, n_extra) } else { conveyor(window, n_extra) }
}

pub fn layout(name: &str, window: Box_, n_extra: usize) -> Result<Vec<(Box_, Anchor)>, String> {
    Ok(match name {
        "single" => single(window, n_extra),
        "corners" => corners(window, n_extra),
        "quad" => quad(window, n_extra),
        "conveyor" => conveyor_for_window(window, n_extra),
        "conveyor_stack" => conveyor_stack(window, n_extra),
        other => return Err(format!("unknown layout {other:?}")),
    })
}
