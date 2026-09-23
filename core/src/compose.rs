//! compose_hero (port of compose/hero.py, frameless path).
//!
//! One request shape for both bindings: a JSON description plus one
//! flat byte arena the images are sliced out of by offset. That keeps
//! the ctypes and wasm-bindgen surfaces to a single function each,
//! which is what makes adding a feature here a change in one place.

use serde::Deserialize;

use crate::glow::{glow_color, paste_alpha, paste_with_glow};
use crate::gradient::{generic_gradient, vehicle_gradient};
use crate::layout::{compute_placement, layout, Anchor};
use crate::resize::{cover_fit, crop, resize_lanczos};
use crate::spec;
use crate::spotlight::{apply_spotlight, compute_dim_strength};
use crate::window::{detect_window, resolve_collision};
use crate::Image;

#[derive(Deserialize)]
pub struct Slice { pub offset: usize, pub len: usize, pub width: usize, pub height: usize, pub channels: usize }

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
    /// A border frame (RGBA). When given it decides the canvas size,
    /// defines the window the cars are laid out in, has its art
    /// collision-checked against every placement, and is the top layer.
    #[serde(default)]
    pub border: Option<Slice>,
}

fn default_layout() -> String { "single".into() }
fn default_true() -> bool { true }

fn slice_image(arena: &[u8], s: &Slice) -> Result<Image, String> {
    let end = s.offset.checked_add(s.len).ok_or("slice overflow")?;
    if end > arena.len() {
        return Err(format!("slice {}..{} is outside the {}-byte arena", s.offset, end, arena.len()));
    }
    Image::from_vec(s.width, s.height, s.channels, arena[s.offset..end].to_vec())
}

/// Returns the composed RGB canvas (width * height * 3 bytes).
pub fn compose_hero(req: &ComposeRequest, arena: &[u8]) -> Result<Image, String> {
    let border = match &req.border {
        Some(s) => {
            let b = slice_image(arena, s)?;
            if b.channels != 4 { return Err("border must be RGBA".into()); }
            Some(b)
        }
        None => None,
    };
    let (w, h) = match &border {
        Some(b) => (b.width, b.height),
        None => (req.width, req.height),
    };
    if w == 0 || h == 0 || w > 8192 || h > 8192 {
        return Err("canvas must be within 8192x8192".into());
    }
    let cars: Vec<Image> = req.cars.iter().map(|s| slice_image(arena, s)).collect::<Result<_, _>>()?;
    if cars.iter().any(|c| c.channels != 4) {
        return Err("cutouts must be RGBA".into());
    }

    let mut canvas = match &req.background {
        Background::Vehicle { seed, exterior, interior } =>
            vehicle_gradient(w, h, seed, exterior.as_deref(), interior.as_deref(), cars.first()),
        Background::Generic { seed } => generic_gradient(w, h, seed),
        Background::Linear { angle, start, end } => crate::gradient::linear_gradient(w, h, *angle, *start, *end),
        Background::Image { image } => {
            let img = slice_image(arena, image)?;
            let rgb = if img.channels == 3 { img } else { drop_alpha(&img) };
            cover_fit(&rgb, w, h)
        }
    };

    let margin = req.margin_frac.unwrap_or_else(|| spec::f64_at(&["compose", "marginFrac"]));
    let window = match &border {
        Some(b) => detect_window(b)?,
        None => (0i64, 0i64, w as i64, h as i64),
    };
    let boxes = layout(&req.layout, window, cars.len().saturating_sub(1))?;
    let mut placements: Vec<(i64, i64, Image)> = cars.iter().zip(boxes.iter()).map(|(car, (bx, anchor))| {
        let p = compute_placement(car.width, car.height, *bx, margin, *anchor);
        let resized = if p.w == car.width && p.h == car.height { car.clone() } else { resize_lanczos(car, p.w, p.h) };
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
