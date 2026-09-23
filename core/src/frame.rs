//! One video frame, and the small operations a video host needs around
//! it. The hosts (hero_video.py, video.js) keep the choreography: which
//! shot is where, how far a pan has travelled, how much a transition has
//! eased. Everything that touches pixels comes here.
//!
//! A frame is: a backdrop (a gradient the core builds, or an image the
//! host supplies such as a flag-video frame), an optional spotlight dim
//! about a centre, any number of cars at explicit rectangles with an
//! alpha each, an optional glow behind each, and an optional border on
//! top. A car whose slice is already the rectangle's size is pasted as
//! is, so a host may cache scaled cars (through `resize`) and pay for
//! resampling once per size rather than once per frame.

use serde::{Deserialize, Serialize};

use crate::compose::{Background, Slice};
use crate::glow::{glow_color, make_glow_layer, paste_alpha};
use crate::gradient::{generic_gradient, linear_gradient, vehicle_gradient};
use crate::resize::{cover_fit, crop, resize_bilinear, resize_lanczos};
use crate::spec;
use crate::spotlight::{apply_spotlight, compute_dim_strength};
use crate::window::{detect_window, resolve_collision};
use crate::Image;

#[derive(Deserialize)]
pub struct FrameCar {
    pub image: Slice,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default = "one")]
    pub alpha: f64,
}
fn one() -> f64 { 1.0 }

#[derive(Deserialize)]
pub struct Spotlight { pub cx: f64, pub cy: f64, pub dim: f64 }

#[derive(Deserialize)]
pub struct FrameRequest {
    pub width: usize,
    pub height: usize,
    pub background: Background,
    #[serde(default)]
    pub border: Option<Slice>,
    #[serde(default)]
    pub spotlight: Option<Spotlight>,
    pub cars: Vec<FrameCar>,
    #[serde(default)]
    pub glow: bool,
    #[serde(default)]
    pub glow_color: Option<String>,
    #[serde(default)]
    pub glow_radius: Option<usize>,
    #[serde(default)]
    pub glow_intensity: Option<f64>,
    /// "lanczos" (default) or "bilinear" for cars that still need scaling.
    #[serde(default)]
    pub resample: Option<String>,
}

fn slice_image(arena: &[u8], s: &Slice) -> Result<Image, String> {
    let end = s.offset.checked_add(s.len).ok_or("slice overflow")?;
    if end > arena.len() {
        return Err(format!("slice {}..{} is outside the {}-byte arena", s.offset, end, arena.len()));
    }
    Image::from_vec(s.width, s.height, s.channels, arena[s.offset..end].to_vec())
}

fn faded(img: &Image, alpha: f64) -> Image {
    if alpha >= 1.0 { return img.clone(); }
    let mut out = img.clone();
    for i in (3..out.data.len()).step_by(4) {
        out.data[i] = (out.data[i] as f64 * alpha.clamp(0.0, 1.0)).round() as u8;
    }
    out
}

pub fn render_frame(req: &FrameRequest, arena: &[u8]) -> Result<Image, String> {
    let border = match &req.border {
        Some(s) => Some(slice_image(arena, s)?),
        None => None,
    };
    let (w, h) = match &border { Some(b) => (b.width, b.height), None => (req.width, req.height) };
    if w == 0 || h == 0 || w > 8192 || h > 8192 {
        return Err("canvas must be within 8192x8192".into());
    }
    let mut canvas = match &req.background {
        Background::Vehicle { seed, exterior, interior } => vehicle_gradient(w, h, seed, exterior.as_deref(), interior.as_deref(), None),
        Background::Generic { seed } => generic_gradient(w, h, seed),
        Background::Linear { angle, start, end } => linear_gradient(w, h, *angle, *start, *end),
        Background::Image { image } => {
            let img = slice_image(arena, image)?;
            let rgb = if img.channels == 3 { img } else { drop_alpha(&img) };
            if rgb.width == w && rgb.height == h { rgb } else { cover_fit(&rgb, w, h) }
        }
    };
    if let Some(s) = &req.spotlight {
        apply_spotlight(&mut canvas, s.cx, s.cy, s.dim);
    }
    let color = glow_color(req.glow_color.as_deref().unwrap_or("white"))?;
    let radius = req.glow_radius.unwrap_or_else(|| spec::f64_at(&["glow", "radius"]) as usize);
    let intensity = req.glow_intensity.unwrap_or_else(|| spec::f64_at(&["glow", "intensity"]));
    let bilinear = req.resample.as_deref() == Some("bilinear");

    for car in &req.cars {
        if car.alpha <= 0.0 { continue; }
        let src = slice_image(arena, &car.image)?;
        if src.channels != 4 { return Err("cars must be RGBA".into()); }
        let (cw, ch) = ((car.w.round() as usize).max(1), (car.h.round() as usize).max(1));
        let scaled = if cw == src.width && ch == src.height { src }
            else if bilinear { resize_bilinear(&src, cw, ch) } else { resize_lanczos(&src, cw, ch) };
        let (x, y) = (car.x.round() as i64, car.y.round() as i64);
        if req.glow {
            let (halo, pad) = make_glow_layer(&scaled, color, radius, intensity);
            paste_alpha(&mut canvas, &faded(&halo, car.alpha), x - pad as i64, y - pad as i64);
        }
        paste_alpha(&mut canvas, &faded(&scaled, car.alpha), x, y);
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

/// The general entry point both bindings expose: `op` selects the
/// operation, the arena carries any images. Image results come back as
/// raw bytes with their shape; scalar results as JSON.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    ComposeHero(crate::compose::ComposeRequest),
    RenderFrame(FrameRequest),
    Resize { image: Slice, width: usize, height: usize, #[serde(default)] bilinear: bool },
    LinearGradient { width: usize, height: usize, angle: f64, start: [u8; 3], end: [u8; 3] },
    DimStrength { background: Slice, car: Slice },
    DetectWindow { border: Slice },
    ResolveCollision { border: Slice, car: Slice, x: i64, y: i64 },
    VehicleGradientColors { exterior: Option<String>, interior: Option<String>, #[serde(default)] sample: Option<Slice> },
}

pub enum OpResult { Image(Image), Json(String) }

#[derive(Serialize)]
struct Scalar<T: Serialize> { value: T }

pub fn call(op_json: &str, arena: &[u8]) -> Result<OpResult, String> {
    let op: Op = serde_json::from_str(op_json).map_err(|e| format!("bad op: {e}"))?;
    Ok(match op {
        Op::ComposeHero(req) => OpResult::Image(crate::compose::compose_hero(&req, arena)?),
        Op::RenderFrame(req) => OpResult::Image(render_frame(&req, arena)?),
        Op::Resize { image, width, height, bilinear } => {
            let img = slice_image(arena, &image)?;
            OpResult::Image(if bilinear { resize_bilinear(&img, width, height) } else { resize_lanczos(&img, width, height) })
        }
        Op::LinearGradient { width, height, angle, start, end } => OpResult::Image(linear_gradient(width, height, angle, start, end)),
        Op::DimStrength { background, car } => {
            let bg = slice_image(arena, &background)?;
            let car = slice_image(arena, &car)?;
            OpResult::Json(serde_json::to_string(&Scalar { value: compute_dim_strength(&bg, &car) }).unwrap())
        }
        Op::DetectWindow { border } => {
            let b = slice_image(arena, &border)?;
            let (l, t, r, bt) = detect_window(&b)?;
            OpResult::Json(serde_json::to_string(&Scalar { value: [l, t, r, bt] }).unwrap())
        }
        Op::ResolveCollision { border, car, x, y } => {
            let b = slice_image(arena, &border)?;
            let c = slice_image(arena, &car)?;
            OpResult::Json(serde_json::to_string(&Scalar { value: resolve_collision(&b, &c, x, y) }).unwrap())
        }
        Op::VehicleGradientColors { exterior, interior, sample } => {
            let s = match sample { Some(s) => Some(slice_image(arena, &s)?), None => None };
            let (a, b) = crate::palette::vehicle_gradient_colors(exterior.as_deref(), interior.as_deref(), s.as_ref());
            OpResult::Json(serde_json::to_string(&Scalar { value: [a, b] }).unwrap())
        }
    })
}

#[allow(dead_code)]
fn _unused(i: &Image) -> Image { crop(i, 0, 0, 1, 1) }
