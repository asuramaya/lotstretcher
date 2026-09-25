//! Where each cutout goes (port of compose/layout.py).

/// (left, top, right, bottom)
pub type Box_ = (i64, i64, i64, i64);

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Anchor { Center, Bottom }

pub struct Placement { pub x: i64, pub y: i64, pub w: usize, pub h: usize }

/// Scale a (cw x ch) cutout to fit `bx` minus a margin; centred
/// horizontally, centred or bottom-anchored vertically.
/// The silhouette a car's height is capped at: a vehicle is never drawn
/// taller than one of this width-to-height ratio would be in the same
/// box, so a head-on shot (about 1.2:1) stands as tall as a three-quarter
/// one instead of filling the frame, and a set reads as one shoot.
pub fn height_cap_aspect() -> f64 {
    crate::spec::get(&["compose", "heightCapAspect"]).as_f64().unwrap_or(1.7)
}

pub fn compute_placement(cw: usize, ch: usize, bx: Box_, margin_frac: f64, anchor: Anchor) -> Placement {
    let (bl, bt, br, bb) = bx;
    let avail_w = (br - bl) as f64 * (1.0 - 2.0 * margin_frac);
    let avail_h = (bb - bt) as f64 * (1.0 - 2.0 * margin_frac);
    // The tallest a car of the reference shape could stand in this box.
    let ref_h = avail_h.min(avail_w / height_cap_aspect());
    let scale = (avail_w / cw as f64).min(avail_h / ch as f64).min(ref_h / ch as f64);
    let w = ((cw as f64 * scale).round() as usize).max(1);
    let h = ((ch as f64 * scale).round() as usize).max(1);
    let x = bl + ((br - bl) - w as i64).div_euclid(2);
    let y = match anchor {
        Anchor::Bottom => bb - ((bb - bt) as f64 * margin_frac) as i64 - h as i64,
        // Centred on the reference car, then set down on its floor line:
        // every car in a set has its wheels at the same height.
        Anchor::Center => {
            let floor = bt as f64 + ((bb - bt) as f64 - ref_h) / 2.0 + ref_h;
            floor.round() as i64 - h as i64
        }
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

/// A window much wider than tall (a 16:9 clip once the text's band is
/// off the top): the accents sit beside the hero on one floor, a lineup,
/// instead of in the top corners under the text where the three trucks
/// and the words crowded one band.
const CONVEYOR_WIDE_RATIO: f64 = 1.6;

pub fn conveyor_wide(window: Box_, _n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    let (ww, wh) = ((wr - wl) as f64, (wb - wt) as f64);
    // A staggered lineup: the hero wide across the front, the accents
    // behind it at the edges, higher (further back) and half hidden by
    // it, as a showroom row is shot. The hero is drawn last.
    let hw = r(ww * 0.74);
    let hl = wl + ((ww as i64) - hw).div_euclid(2);
    let aw = r(ww * 0.27);
    let ah = r(wh * 0.5);
    let ab = wb - r(wh * 0.14);
    let left = (wl, ab - ah, wl + aw, ab);
    let right = (wr - aw, ab - ah, wr, ab);
    // Headroom over the hero: the clip's beat pulse and push grow it, and
    // a roof must never meet the frame's top edge.
    let ht = wt + r(wh * 0.08);
    vec![((hl, ht, hl + hw, wb), Anchor::Bottom), (left, Anchor::Bottom), (right, Anchor::Bottom)]
}

/// Whichever conveyor suits the frame: stacked once taller than wide,
/// a lineup once much wider than tall, the corners layout between.
pub fn conveyor_for_window(window: Box_, n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    let (ww, wh) = ((wr - wl) as f64, (wb - wt) as f64);
    if ww < wh { conveyor_stack(window, n_extra) }
    else if ww >= wh * CONVEYOR_WIDE_RATIO { conveyor_wide(window, n_extra) }
    else { conveyor(window, n_extra) }
}

pub fn layout(name: &str, window: Box_, n_extra: usize) -> Result<Vec<(Box_, Anchor)>, String> {
    Ok(match name {
        "single" => single(window, n_extra),
        "corners" => corners(window, n_extra),
        "quad" => quad(window, n_extra),
        "conveyor" => conveyor_for_window(window, n_extra),
        "conveyor_stack" => conveyor_stack(window, n_extra),
        "conveyor_wide" => conveyor_wide(window, n_extra),
        other => return Err(format!("unknown layout {other:?}")),
    })
}
