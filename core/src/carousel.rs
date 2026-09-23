//! The conveyor choreography (port of the scheduling and geometry half
//! of hero_video.py). Pure arithmetic over a plan the host asks for once
//! and hands back each frame; every pixel then goes through
//! frame::render_frame. Both video hosts share this, so the browser's
//! clip and the CLI's are the same edit.

use serde::{Deserialize, Serialize};

use crate::compose::{slice_image, Slice};
use crate::layout::{compute_placement, conveyor_for_window, Anchor, Box_};
use crate::resize::{crop, resize_lanczos};
use crate::spec;
use crate::spotlight::compute_dim_strength;
use crate::window::{detect_window, resolve_collision};
use crate::Image;
#[allow(unused_imports)]
use std::rc::Rc;

pub type Rect = [f64; 4];

#[derive(Deserialize)]
pub struct ShotIn {
    pub image: Slice,
    #[serde(default = "t")]
    pub pannable: bool,
    /// "left" or "right": which way the nose faces, for the pan direction.
    #[serde(default)]
    pub hood_side: Option<String>,
}
fn t() -> bool { true }

#[derive(Deserialize)]
pub struct PlanRequest {
    pub width: usize,
    pub height: usize,
    #[serde(default)]
    pub border: Option<Slice>,
    /// A representative backdrop frame (RGB, canvas-sized) the spotlight
    /// contrast is measured against.
    pub backdrop: Slice,
    pub shots: Vec<ShotIn>,
    pub audio_loop_s: f64,
    /// The layout window to use instead of the border's (or the canvas):
    /// a host passes one already shrunk by the text band.
    #[serde(default)]
    pub window: Option<[i64; 4]>,
    #[serde(default)]
    pub bars_per_loop: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ShotPlan {
    pub hero_rect: Rect,
    pub hero_fit_rect: Rect,
    pub left_rect: Rect,
    pub right_rect: Rect,
    pub center: [f64; 2],
    pub dim: f64,
    pub is_pan: bool,
    pub pan_draw_w: f64,
    pub pan_draw_h: f64,
    pub pan_x_start: f64,
    pub pan_x_end: f64,
    pub bars: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Plan {
    pub shots: Vec<ShotPlan>,
    pub schedule: Vec<[f64; 2]>,
    pub period: f64,
    pub dwell: f64,
    pub transition_s: f64,
    pub beat_s: f64,
}

/// (dwell, transition_s, beat_s) from the loop's own length.
pub fn timing(audio_loop_s: f64, bars_per_loop: u32) -> (f64, f64, f64) {
    let beats_per_bar = spec::f64_at(&["video", "beatsPerBar"]);
    let frac = spec::f64_at(&["video", "transitionFrac"]);
    let (min_t, max_t) = (spec::f64_at(&["video", "minTransitionS"]), spec::f64_at(&["video", "maxTransitionS"]));
    let dwell = audio_loop_s / bars_per_loop as f64;
    let beat_s = dwell / beats_per_bar;
    let transition = (dwell * frac).max(min_t).min(max_t).min(dwell * 0.9);
    (dwell, transition, beat_s)
}

fn place(car: &Image, bx: Box_, anchor: Anchor, border: Option<&Image>, margin: f64) -> (Image, Rect) {
    let p = compute_placement(car.width, car.height, bx, margin, anchor);
    let resized = if p.w == car.width && p.h == car.height { car.clone() } else { resize_lanczos(car, p.w, p.h) };
    let y = match border { Some(b) => resolve_collision(b, &resized, p.x, p.y), None => p.y };
    (resized, [p.x as f64, y as f64, p.w as f64, p.h as f64])
}

pub fn plan(req: &PlanRequest, arena: &[u8]) -> Result<Plan, String> {
    let border = match &req.border { Some(s) => Some(slice_image(arena, s)?), None => None };
    let (w, h) = match &border { Some(b) => (b.width, b.height), None => (req.width, req.height) };
    let window = match req.window {
        Some(win) => (win[0], win[1], win[2], win[3]),
        None => match &border { Some(b) => detect_window(b)?, None => (0, 0, w as i64, h as i64) },
    };
    let border = border.as_deref();
    let boxes = conveyor_for_window(window, 2);
    let (hero_box, hero_anchor) = boxes[0];
    let (left_box, left_anchor) = boxes[1];
    let (right_box, right_anchor) = boxes[2];
    let backdrop = slice_image(arena, &req.backdrop)?;
    let hero_margin = spec::f64_at(&["video", "heroMarginFrac"]);
    let accent_margin = spec::f64_at(&["video", "accentMarginFrac"]);
    let min_overflow = spec::f64_at(&["video", "minPanOverflowFrac"]);
    let pan_bars = spec::f64_at(&["video", "panBars"]) as u32;

    let mut shots = Vec::with_capacity(req.shots.len());
    for s in &req.shots {
        let car = slice_image(arena, &s.image)?;
        let (_, left_rect) = place(&car, left_box, left_anchor, border, accent_margin);
        let (_, right_rect) = place(&car, right_box, right_anchor, border, accent_margin);
        let (hero_fit, hero_fit_rect) = place(&car, hero_box, hero_anchor, border, hero_margin);

        let (bl, bt, br, bb) = hero_box;
        let avail_w = (br - bl) as f64 * (1.0 - 2.0 * hero_margin);
        let avail_h = (bb - bt) as f64 * (1.0 - 2.0 * hero_margin);
        let width_constrained = (avail_w / car.width as f64) < (avail_h / car.height as f64);
        let fill_scale = avail_h / car.height as f64;
        let filled_w = car.width as f64 * fill_scale;
        let overflow = filled_w / avail_w - 1.0;
        let is_pan = s.pannable && width_constrained && overflow >= min_overflow;

        let (hero_rect, pan_draw_w, pan_draw_h, pan_x_start, pan_x_end, content);
        if is_pan {
            let win_w = (br - bl) as f64;
            let x0 = bl as f64;
            let y0 = if hero_anchor == Anchor::Bottom { bb as f64 - (bb - bt) as f64 * hero_margin - avail_h }
                     else { bt as f64 + ((bb - bt) as f64 - avail_h) / 2.0 };
            hero_rect = [x0, y0, win_w, avail_h];
            pan_draw_w = filled_w; pan_draw_h = avail_h;
            let big = resize_lanczos(&car, (filled_w.round() as usize).max(1), (avail_h.round() as usize).max(1));
            content = crop(&big, 0, 0, (win_w.round() as usize).max(1).min(big.width), big.height);
            let xc = x0 + win_w / 2.0;
            if s.hood_side.as_deref() == Some("right") { pan_x_start = xc - filled_w; pan_x_end = xc; }
            else { pan_x_start = xc; pan_x_end = xc - filled_w; }
        } else {
            hero_rect = hero_fit_rect;
            pan_draw_w = 0.0; pan_draw_h = 0.0; pan_x_start = 0.0; pan_x_end = 0.0;
            content = hero_fit;
        }
        let [x, y, rw, rh] = hero_rect;
        let (x0, y0) = (x.round().max(0.0) as usize, y.round().max(0.0) as usize);
        let x1 = ((x + rw).round() as usize).min(backdrop.width);
        let y1 = ((y + rh).round() as usize).min(backdrop.height);
        let region = crop(&backdrop, x0.min(x1), y0.min(y1), (x1 - x0.min(x1)).max(1), (y1 - y0.min(y1)).max(1));
        let dim = compute_dim_strength(&region, &content);
        shots.push(ShotPlan {
            hero_rect, hero_fit_rect, left_rect, right_rect,
            center: [(x.round() + (x + rw).round()) / 2.0, (y.round() + (y + rh).round()) / 2.0],
            dim, is_pan, pan_draw_w, pan_draw_h, pan_x_start, pan_x_end,
            bars: if is_pan { pan_bars } else { 1 },
        });
    }
    let bars = req.bars_per_loop.unwrap_or(spec::f64_at(&["video", "barsPerLoop"]) as u32);
    let (dwell, transition_s, beat_s) = timing(req.audio_loop_s, bars);
    let mut schedule = Vec::new();
    let mut t = 0.0;
    for s in &shots { let d = dwell * s.bars as f64; schedule.push([t, d]); t += d; }
    Ok(Plan { shots, schedule, period: t, dwell, transition_s, beat_s })
}

fn ease_out(t: f64) -> f64 { 1.0 - (1.0 - t).powi(2) }
fn lerp(a: Rect, b: Rect, t: f64) -> Rect { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t] }
fn hero_state(s: &ShotPlan, progress: f64) -> Rect {
    if !s.is_pan { return s.hero_fit_rect; }
    let p = progress.clamp(0.0, 1.0);
    [s.pan_x_start + (s.pan_x_end - s.pan_x_start) * p, s.hero_rect[1], s.pan_draw_w, s.pan_draw_h]
}
fn pulse(t: f64, beat_s: f64) -> f64 {
    if beat_s <= 0.0 { return 1.0; }
    let strength = spec::f64_at(&["video", "pulseStrength"]);
    let decay = spec::f64_at(&["video", "pulseDecay"]);
    let phase = (t % beat_s) / beat_s;
    1.0 + strength * (-phase / decay).exp()
}
fn scaled_about(r: Rect, c: [f64; 2], s: f64) -> Rect { [c[0] + (r[0] - c[0]) * s, c[1] + (r[1] - c[1]) * s, r[2] * s, r[3] * s] }

#[derive(Serialize)]
pub struct FrameCarOut { pub shot: usize, pub rect: Rect, pub alpha: f64 }
#[derive(Serialize)]
pub struct FrameOut { pub hero: usize, pub cars: Vec<FrameCarOut> }

/// The cars to draw at time `t`, in draw order (accents first, hero last).
pub fn frame(plan: &Plan, t: f64) -> FrameOut {
    let n = plan.shots.len();
    let pos = t % plan.period;
    let mut idx = n - 1;
    for (i, [start, dur]) in plan.schedule.iter().enumerate() {
        if pos < start + dur { idx = i; break; }
    }
    let [slot_start, slot_dur] = plan.schedule[idx];
    let within = pos - slot_start;
    let hold = slot_dur - plan.transition_s;
    let hero = &plan.shots[idx];
    let m = |i: i64| ((i % n as i64 + n as i64) % n as i64) as usize;
    let cars = if within < hold {
        let (li, ri) = (m(idx as i64 - 1), m(idx as i64 + 1));
        let mut draw = hero_state(hero, if hold > 0.0 { within / hold } else { 1.0 });
        let p = pulse(t, plan.beat_s);
        if p != 1.0 {
            let pivot = [hero.hero_rect[0] + hero.hero_rect[2] / 2.0, hero.hero_rect[1] + hero.hero_rect[3] / 2.0];
            draw = scaled_about(draw, pivot, p);
        }
        vec![
            FrameCarOut { shot: li, rect: plan.shots[li].left_rect, alpha: 1.0 },
            FrameCarOut { shot: ri, rect: plan.shots[ri].right_rect, alpha: 1.0 },
            FrameCarOut { shot: idx, rect: draw, alpha: 1.0 },
        ]
    } else {
        let tau = ((within - hold) / plan.transition_s).min(1.0);
        let e = ease_out(tau);
        let (pi, ni, n2) = (m(idx as i64 - 1), m(idx as i64 + 1), m(idx as i64 + 2));
        let (a, b, c, d) = (&plan.shots[idx], &plan.shots[pi], &plan.shots[ni], &plan.shots[n2]);
        vec![
            FrameCarOut { shot: pi, rect: b.left_rect, alpha: 1.0 - tau },
            FrameCarOut { shot: n2, rect: d.right_rect, alpha: tau },
            FrameCarOut { shot: idx, rect: lerp(hero_state(a, 1.0), a.left_rect, e), alpha: 1.0 },
            FrameCarOut { shot: ni, rect: lerp(c.right_rect, hero_state(c, 0.0), e), alpha: 1.0 },
        ]
    };
    FrameOut { hero: idx, cars }
}
