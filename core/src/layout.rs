//! Where each cutout goes: the named layouts, hero first, and the
//! placement of a cutout in its box. Both hosts call these (ops `layout`
//! and `placement`); compose/layout.py is a thin wrapper over them.

/// (left, top, right, bottom)
pub type Box_ = (i64, i64, i64, i64);

#[derive(Clone, Copy, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Anchor { Center, Bottom }

#[derive(serde::Serialize)]
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

/// Just one car, filling the window. Centered rather than bottom-anchored -- bottom-anchoring reads
/// right for the quad layout's hero (standing on "the ground" at the base of the frame, other cars
/// above it), but for a solo shot with nothing else in the window it just leaves a lot of dead
/// space up top; centered uses the window evenly. n_extra is ignored (kept for a consistent layout-
/// function signature). A story-shaped window (1.3x taller than wide) bottom-anchors the car on a
/// box ending compose.tallFloorFrac down it, near its words, instead.
pub fn single(window: Box_, _n_extra: usize) -> Vec<(Box_, Anchor)> {
    let (wl, wt, wr, wb) = window;
    let (ww, wh) = ((wr - wl) as f64, (wb - wt) as f64);
    // A story-shaped window: the car stands low, near its words, rather
    // than centred with a band of backdrop between it and the title.
    if wh >= ww * 1.3 {
        let frac = crate::spec::get(&["compose", "tallFloorFrac"]).as_f64().unwrap_or(0.9);
        return vec![((wl, wt, wr, wt + r(wh * frac)), Anchor::Bottom)];
    }
    vec![(window, Anchor::Center)]
}

/// Hero fills the window (bottom-anchored) below the two corner accents; up to 2 smaller accent
/// shots tucked into the top corners.
///
/// Corner placement (rather than e.g. side-by-side thirds) keeps the hero the clear focal point at
/// full size instead of shrinking everything to fit -- accents read as supporting angles, not equal
/// billing.
///
/// Hero's box is bounded to start below the corner accents (not the full window) -- see quad's
/// docstring for why: a hero that isn't always the same wide/low 3/4 shot (e.g. the clip's
/// carousel, which cycles through every angle) can be tall enough, scaled to fill the window, to
/// visually paint over the accents above it if its box isn't actually bounded away from theirs.
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

/// Hero at the bottom + 3 fixed accent slots: front in the top-left corner, rear/back in the top-
/// right corner, and a wide strip for a full side profile filling the gap between them. Always 4
/// slots regardless of n_extra -- pair with imaging/select.py::pick_for_quad to hand compose_hero()
/// the [hero, front, back, side] car order this expects.
///
/// Hero's box stops just below the accent row instead of spanning the full window.
/// compose_placement() only guarantees a car fits inside its OWN box -- it doesn't know or care
/// about any other box's content, and compose_hero() paints the hero last (on top), so a hero box
/// that overlaps the accent boxes lets a sufficiently tall hero visually cover them. That's
/// invisible for a still image (the hero is always the same wide/low 3/4 shot, which is naturally
/// short enough not to reach the accent row even when the box was the full window) -- but the clip
/// cycles the hero through every angle, including squarer ones (a straight rear shot, a wheel money
/// shot) that DO reach that high once scaled to fill a same-sized box. Bounding the hero box itself
/// is the fix that works regardless of which shot ends up in it, rather than special-casing "unless
/// it's this angle."
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

/// Hero + 2 top-corner accents for the clip's 3-slot conveyor.
///
/// Same idea as corners_layout, retuned for a frame where all three slots are ALWAYS occupied --
/// corners_layout has to look right with 0, 1, or 2 accents and with a hero that may be the only
/// thing on screen, so it leaves generous air. Here the video was measurably empty: 832px of
/// content in a 1046px window (20% dead), with the worst gap 236px of bare background between a
/// short accent and the hero.
///
/// Two changes, each aimed at one measured cause: - Boxes are bigger (0.46w x 0.34h vs 0.40 x 0.30)
/// and the row gap tighter, so the accents themselves occupy more of the top band. - The hero box
/// takes everything below that band; the clip pairs this with a much smaller inset than the still
/// pipeline's (see HERO_MARGIN_FRAC), since a video frame is viewed briefly and wants to read big,
/// where a still is looked at.
///
/// Accents stay CENTER-anchored. Bottom-anchoring them was tried, and it does close the gap to the
/// hero -- a wide side profile only fills 174px of a 356px box, so dropping it to a shared baseline
/// with the other accent cut the worst gap from 236px to 73px. But it reads wrong: a short wide
/// shot pinned to the bottom of an invisible box looks like it's sinking, with all of its slack
/// stacked above it, while centering splits the slack evenly and reads as deliberate letterboxing.
/// Note this only affects wide/short shots -- an accent that fills its box height (a wheel, a
/// straight-on front) lands within ~1px either way, so this is not a general "align everything"
/// knob.
///
/// n_extra is accepted for signature compatibility and ignored -- the conveyor is always exactly
/// hero + 2.
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

/// The same 3-slot conveyor, stacked instead of side-by-side, for a window taller than it is wide.
///
/// conveyor_layout cannot be reused on a vertical frame. Measured on a 1080x1920 canvas it produces
/// a 0.87:1 hero box and 0.76:1 accent boxes -- portrait boxes, which is the worst possible shape
/// for an object whose median aspect is 1.80:1. A median vehicle fills 48% of that hero box and 42%
/// of an accent. The frame isn't badly composed, it's mostly empty.
///
/// So the accents move above and below the hero rather than sitting in its top corners. The
/// important detail is that they must also be NARROWER than the hero: everything in a tall frame is
/// width- constrained, so three full-width slots would draw the vehicle at exactly the same size in
/// all three and the hero/accent hierarchy would vanish entirely. 0.62 width keeps roughly the same
/// accent-to-hero size ratio the square layout has (0.46/1.0).
///
/// Boxes are sized to the content's aspect rather than to equal shares of the height, and whatever
/// height is left over becomes air between them -- a tall composition wants that spacing, and
/// sizing the boxes to fill the frame is what produced the 48% number above.
///
/// Slot order matches conveyor_layout's [hero, outgoing, incoming], so the clip's animation is
/// unchanged: a shot fades in at the BOTTOM accent, grows into the hero, shrinks into the TOP
/// accent and fades out. The travel reads upward, which suits a vertical frame.
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
        // The corners-style conveyor itself, whatever the window's shape.
        "conveyor_plain" => conveyor(window, n_extra),
        "conveyor_stack" => conveyor_stack(window, n_extra),
        "conveyor_wide" => conveyor_wide(window, n_extra),
        other => return Err(format!("unknown layout {other:?}")),
    })
}
