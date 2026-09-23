//! compose_hero (port of compose/hero.py, frameless path).
//!
//! One request shape for both bindings: a JSON description plus one
//! flat byte arena the images are sliced out of by offset. That keeps
//! the ctypes and wasm-bindgen surfaces to a single function each,
//! which is what makes adding a feature here a change in one place.

use serde::Deserialize;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use crate::glow::{glow_color, paste_alpha, paste_with_glow};
use crate::gradient::{generic_gradient, vehicle_gradient};
use crate::layout::{compute_placement, layout, Anchor};
use crate::resize::{cover_fit, crop, resize_lanczos};
use crate::spec;
use crate::spotlight::{apply_spotlight, compute_dim_strength};
use crate::window::{detect_window, resolve_collision};
use crate::Image;

/// Where an image comes from: a run of the request's byte arena, or an
/// image the core is already holding (`retained`, from a `retain` op),
/// in which case no bytes travel with the request at all. A video host
/// retains its scaled cars, layers and backdrop frames once and then
/// refers to them by id on every frame.
#[derive(Deserialize, Clone)]
pub struct Slice {
    #[serde(default)] pub offset: usize,
    #[serde(default)] pub len: usize,
    #[serde(default)] pub width: usize,
    #[serde(default)] pub height: usize,
    #[serde(default)] pub channels: usize,
    #[serde(default)] pub retained: Option<u64>,
}

pub type GlowKey = (u64, [u8; 3], usize, u64);

thread_local! {
    static STORE: RefCell<HashMap<u64, Rc<Image>>> = RefCell::new(HashMap::new());
    static NEXT_ID: Cell<u64> = const { Cell::new(1) };
    /// Glow halos of retained cars, by (id, colour, radius, intensity
    /// bits): a clip draws the same scaled car with the same glow on
    /// every frame, so the blur is paid once per car, not per frame.
    static GLOW_CACHE: RefCell<HashMap<GlowKey, (Rc<Image>, usize)>> = RefCell::new(HashMap::new());
}

/// The halo for retained image `id`, built by `make` on the first ask.
pub fn glow_cached(key: GlowKey, make: impl FnOnce() -> (Image, usize)) -> (Rc<Image>, usize) {
    if let Some(hit) = GLOW_CACHE.with(|c| c.borrow().get(&key).cloned()) { return hit; }
    let (img, pad) = make();
    let entry = (Rc::new(img), pad);
    GLOW_CACHE.with(|c| c.borrow_mut().insert(key, entry.clone()));
    entry
}

/// Keep `img` in the core and hand back its id.
pub fn retain(img: Image) -> u64 {
    let id = NEXT_ID.with(|n| { let id = n.get(); n.set(id + 1); id });
    STORE.with(|s| s.borrow_mut().insert(id, Rc::new(img)));
    id
}

/// Drop a retained image. False when the id was not held.
pub fn release(id: u64) -> bool {
    GLOW_CACHE.with(|c| c.borrow_mut().retain(|k, _| k.0 != id));
    STORE.with(|s| s.borrow_mut().remove(&id).is_some())
}

/// Drop every retained image; returns how many there were.
pub fn release_all() -> usize {
    GLOW_CACHE.with(|c| c.borrow_mut().clear());
    STORE.with(|s| { let mut s = s.borrow_mut(); let n = s.len(); s.clear(); n })
}

/// The image a slice names: a copy out of the arena, or a shared handle
/// to a retained one.
pub fn slice_image(arena: &[u8], s: &Slice) -> Result<Rc<Image>, String> {
    if let Some(id) = s.retained {
        return STORE.with(|st| st.borrow().get(&id).cloned()).ok_or_else(|| format!("no retained image {id}"));
    }
    let end = s.offset.checked_add(s.len).ok_or("slice overflow")?;
    if end > arena.len() {
        return Err(format!("slice {}..{} is outside the {}-byte arena", s.offset, end, arena.len()));
    }
    Ok(Rc::new(Image::from_vec(s.width, s.height, s.channels, arena[s.offset..end].to_vec())?))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Background {
    /// A gradient from the vehicle's colours (or the cutout's paint).
    Vehicle { seed: String, exterior: Option<String>, interior: Option<String> },
    /// Seeded hue bands, no vehicle input.
    Generic { seed: String },
    /// A supplied image, cover-fitted.
    Image { image: Slice },
    /// An explicit linear gradient: what a video host asks for per
    /// frame as the angle turns, without a round trip for the pixels.
    Linear { angle: f64, start: [u8; 3], end: [u8; 3] },
}

#[derive(Deserialize)]
pub struct ComposeRequest {
    pub width: usize,
    pub height: usize,
    pub background: Background,
    /// car 0 is the hero; the rest fill the layout's accent slots.
    pub cars: Vec<Slice>,
    #[serde(default = "default_layout")]
    pub layout: String,
    #[serde(default = "default_true")]
    pub spotlight: bool,
    #[serde(default)]
    pub glow: bool,
    #[serde(default)]
    pub glow_color: Option<String>,
    #[serde(default)]
    pub glow_radius: Option<usize>,
    #[serde(default)]
    pub glow_intensity: Option<f64>,
    #[serde(default)]
    pub margin_frac: Option<f64>,
    /// A border frame (RGBA). It defines the window the cars are laid
    /// out in, has its art collision-checked against every placement,
    /// and is the top layer. The FORMAT decides the canvas size: a frame
    /// of another shape is fitted to it by `border_fit`.
    #[serde(default)]
    pub border: Option<Slice>,
    /// How a frame meets a canvas of another shape: "fit" (whole frame,
    /// centred, the backdrop fills the rest), "fill" (covers the canvas,
    /// edges cropped) or "stretch" (pulled to the canvas). Default fit.
    #[serde(default)]
    pub border_fit: Option<String>,
}

/// The transform that places a border of `bw`x`bh` on a `w`x`h` canvas:
/// (scale_x, scale_y, offset_x, offset_y), original -> canvas.
pub fn fit_transform(bw: usize, bh: usize, w: usize, h: usize, fit: &str) -> Result<(f64, f64, f64, f64), String> {
    let (bw, bh, w, h) = (bw as f64, bh as f64, w as f64, h as f64);
    Ok(match fit {
        "fit" => { let s = (w / bw).min(h / bh); (s, s, ((w - bw * s) / 2.0).round(), ((h - bh * s) / 2.0).round()) }
        "fill" => { let s = (w / bw).max(h / bh); (s, s, ((w - bw * s) / 2.0).round(), ((h - bh * s) / 2.0).round()) }
        "stretch" => (w / bw, h / bh, 0.0, 0.0),
        other => return Err(format!("unknown border fit {other:?}; fit, fill or stretch")),
    })
}

/// A border laid onto a `w`x`h` transparent RGBA canvas by `fit`. A
/// border already the canvas's size is returned as is, byte for byte.
pub fn fit_border(b: &Image, w: usize, h: usize, fit: &str) -> Result<Image, String> {
    if b.channels != 4 { return Err("border must be RGBA".into()); }
    if b.width == w && b.height == h { return Ok(b.clone()); }
    let (sx, sy, ox, oy) = fit_transform(b.width, b.height, w, h, fit)?;
    let rw = ((b.width as f64 * sx).round() as usize).max(1);
    let rh = ((b.height as f64 * sy).round() as usize).max(1);
    let resized = resize_lanczos(b, rw, rh);
    let mut out = Image::new(w, h, 4);
    let (ox, oy) = (ox as i64, oy as i64);
    for y in 0..rh {
        let dy = y as i64 + oy;
        if dy < 0 || dy >= h as i64 { continue; }
        for x in 0..rw {
            let dx = x as i64 + ox;
            if dx < 0 || dx >= w as i64 { continue; }
            let s = (y * rw + x) * 4;
            let d = (dy as usize * w + dx as usize) * 4;
            out.data[d..d + 4].copy_from_slice(&resized.data[s..s + 4]);
        }
    }
    Ok(out)
}

/// The border's car window in canvas coordinates after `fit`. The
/// window is read on the border's own pixels and moved: a fitted border
/// has transparent bands the detector would otherwise take for window.
pub fn fit_window(b: &Image, w: usize, h: usize, fit: &str) -> Result<(i64, i64, i64, i64), String> {
    let (l, t, r, bt) = detect_window(b)?;
    if b.width == w && b.height == h { return Ok((l, t, r, bt)); }
    let (sx, sy, ox, oy) = fit_transform(b.width, b.height, w, h, fit)?;
    let map = |v: i64, s: f64, o: f64| (v as f64 * s + o).round() as i64;
    Ok((map(l, sx, ox).max(0), map(t, sy, oy).max(0), map(r, sx, ox).min(w as i64), map(bt, sy, oy).min(h as i64)))
}

fn default_layout() -> String { "single".into() }
fn default_true() -> bool { true }

/// Returns the composed RGB canvas (width * height * 3 bytes).
pub fn compose_hero(req: &ComposeRequest, arena: &[u8]) -> Result<Image, String> {
    let (w, h) = (req.width, req.height);
    if w == 0 || h == 0 || w > 8192 || h > 8192 {
        return Err("canvas must be within 8192x8192".into());
    }
    let fit = req.border_fit.as_deref().unwrap_or("fit");
    // The window comes from the border's own pixels and follows the fit;
    // the fitted border is what placements collide with and goes on top.
    let (border, window) = match &req.border {
        Some(s) => {
            let b = slice_image(arena, s)?;
            if b.channels != 4 { return Err("border must be RGBA".into()); }
            let window = fit_window(&b, w, h, fit)?;
            (Some(Rc::new(fit_border(&b, w, h, fit)?)), window)
        }
        None => (None, (0i64, 0i64, w as i64, h as i64)),
    };
    let cars: Vec<Rc<Image>> = req.cars.iter().map(|s| slice_image(arena, s)).collect::<Result<_, _>>()?;
    if cars.iter().any(|c| c.channels != 4) {
        return Err("cutouts must be RGBA".into());
    }

    let mut canvas = match &req.background {
        Background::Vehicle { seed, exterior, interior } =>
            vehicle_gradient(w, h, seed, exterior.as_deref(), interior.as_deref(), cars.first().map(|c| &**c)),
        Background::Generic { seed } => generic_gradient(w, h, seed),
        Background::Linear { angle, start, end } => crate::gradient::linear_gradient(w, h, *angle, *start, *end),
        Background::Image { image } => {
            let img = slice_image(arena, image)?;
            let rgb = if img.channels == 3 { (*img).clone() } else { drop_alpha(&img) };
            cover_fit(&rgb, w, h)
        }
    };

    let margin = req.margin_frac.unwrap_or_else(|| spec::f64_at(&["compose", "marginFrac"]));
    let boxes = layout(&req.layout, window, cars.len().saturating_sub(1))?;
    let mut placements: Vec<(i64, i64, Image)> = cars.iter().zip(boxes.iter()).map(|(car, (bx, anchor))| {
        let p = compute_placement(car.width, car.height, *bx, margin, *anchor);
        let resized = if p.w == car.width && p.h == car.height { (**car).clone() } else { resize_lanczos(car, p.w, p.h) };
        (p.x, p.y, resized)
    }).collect();
    // Layout boxes approximate one rectangle; real border art is not
    // one. Check every placement against the border's own alpha and
    // nudge down whatever collides.
    if let Some(b) = &border {
        for (x, y, resized) in placements.iter_mut() {
            *y = resolve_collision(b, resized, *x, *y);
        }
    }

    if req.spotlight {
        if let Some((x, y, resized)) = placements.first() {
            // The hero drives the contrast measurement and the centre.
            let (x0, y0) = ((*x).max(0) as usize, (*y).max(0) as usize);
            let rw = resized.width.min(w.saturating_sub(x0));
            let rh = resized.height.min(h.saturating_sub(y0));
            if rw > 0 && rh > 0 {
                let region = crop(&canvas, x0, y0, rw, rh);
                let dim = compute_dim_strength(&region, resized);
                let cx = *x as f64 + resized.width as f64 / 2.0;
                let cy = *y as f64 + resized.height as f64 / 2.0;
                apply_spotlight(&mut canvas, cx, cy, dim);
            }
        }
    }

    let _ = Anchor::Center;
    let color = glow_color(req.glow_color.as_deref().unwrap_or("white"))?;
    let radius = req.glow_radius.unwrap_or_else(|| spec::f64_at(&["glow", "radius"]) as usize);
    let intensity = req.glow_intensity.unwrap_or_else(|| spec::f64_at(&["glow", "intensity"]));
    // Accents first, hero last, so the hero is never covered.
    for (x, y, resized) in placements.iter().rev() {
        if req.glow {
            paste_with_glow(&mut canvas, resized, *x, *y, color, radius, intensity);
        } else {
            paste_alpha(&mut canvas, resized, *x, *y);
        }
    }
    if let Some(b) = &border {
        paste_alpha(&mut canvas, b, 0, 0);
    }
    Ok(canvas)
}

fn drop_alpha(img: &Image) -> Image {
    let mut out = Image::new(img.width, img.height, 3);
    for i in 0..img.width * img.height {
        out.data[i * 3..i * 3 + 3].copy_from_slice(&img.data[i * 4..i * 4 + 3]);
    }
    out
}

/// Parse and run: the single entry point both bindings call.
pub fn compose_json(request: &str, arena: &[u8]) -> Result<Image, String> {
    let req: ComposeRequest = serde_json::from_str(request).map_err(|e| format!("bad request: {e}"))?;
    compose_hero(&req, arena)
}
