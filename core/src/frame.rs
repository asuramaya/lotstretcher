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

use std::borrow::Cow;
use std::rc::Rc;

use crate::compose::{slice_image, Background, Slice};
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
    /// A dissolve: the car is Image.blend(image, mix.image, mix.t)
    /// before it is pasted. The spin's cross-fade, without a round
    /// trip through the host for the blended layer.
    #[serde(default)]
    pub mix: Option<Mix>,
}
fn one() -> f64 { 1.0 }

#[derive(Deserialize)]
pub struct Mix { pub image: Slice, pub t: f64 }

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
    /// Return RGBA rather than RGB: what a canvas's putImageData wants,
    /// saved from a per-pixel expansion in JavaScript.
    #[serde(default)]
    pub rgba: bool,
}

/// The car with its alpha scaled; borrowed as is at full opacity, so
/// a retained car is pasted straight from the store with no copy.
fn faded(img: &Image, alpha: f64) -> Cow<'_, Image> {
    if alpha >= 1.0 { return Cow::Borrowed(img); }
    let mut out = img.clone();
    for i in (3..out.data.len()).step_by(4) {
        out.data[i] = (out.data[i] as f64 * alpha.clamp(0.0, 1.0)).round() as u8;
    }
    Cow::Owned(out)
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
            let rgb = if img.channels == 3 { (*img).clone() } else { drop_alpha(&img) };
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
        let mut src = slice_image(arena, &car.image)?;
        if src.channels != 4 { return Err("cars must be RGBA".into()); }
        // The halo can be memoized only for a car drawn exactly as the
        // core holds it: retained, unmixed, already the rectangle's size.
        let mut as_held = car.image.retained;
        if let Some(m) = &car.mix {
            let other = slice_image(arena, &m.image)?;
            src = Rc::new(crate::spin::blend(&src, &other, m.t)?);
            as_held = None;
        }
        let (cw, ch) = ((car.w.round() as usize).max(1), (car.h.round() as usize).max(1));
        let scaled: Rc<Image> = if cw == src.width && ch == src.height { src } else {
            as_held = None;
            if bilinear { Rc::new(resize_bilinear(&src, cw, ch)) } else { Rc::new(resize_lanczos(&src, cw, ch)) }
        };
        let (x, y) = (car.x.round() as i64, car.y.round() as i64);
        if req.glow {
            let (halo, pad) = match as_held {
                Some(id) => crate::compose::glow_cached((id, color, radius, intensity.to_bits()),
                                                        || make_glow_layer(&scaled, color, radius, intensity)),
                None => { let (g, p) = make_glow_layer(&scaled, color, radius, intensity); (Rc::new(g), p) }
            };
            paste_alpha(&mut canvas, &faded(&halo, car.alpha), x - pad as i64, y - pad as i64);
        }
        paste_alpha(&mut canvas, &faded(&scaled, car.alpha), x, y);
    }
    if let Some(b) = &border {
        paste_alpha(&mut canvas, b, 0, 0);
    }
    if req.rgba {
        let mut out = Image::new(canvas.width, canvas.height, 4);
        for i in 0..canvas.width * canvas.height {
            out.data[i * 4..i * 4 + 3].copy_from_slice(&canvas.data[i * 3..i * 3 + 3]);
            out.data[i * 4 + 3] = 255;
        }
        return Ok(out);
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
    /// A border laid onto a canvas of another shape (see compose::fit_border),
    /// and that border's car window on that canvas: what a video host
    /// needs to frame a format the border was not drawn for.
    FitBorder { border: Slice, width: usize, height: usize, #[serde(default)] fit: Option<String> },
    FitWindow { border: Slice, width: usize, height: usize, #[serde(default)] fit: Option<String> },
    ResolveCollision { border: Slice, car: Slice, x: i64, y: i64 },
    VehicleGradientColors { exterior: Option<String>, interior: Option<String>, #[serde(default)] sample: Option<Slice> },
    CarouselPlan(crate::carousel::PlanRequest),
    CarouselFrame { plan: crate::carousel::Plan, t: f64 },
    /// Keep an image in the core; later requests name it as {"retained": id}.
    Retain { image: Slice },
    Release { id: u64 },
    ReleaseAll,
    SpinPlan(crate::spin::SpinPlanRequest),
    SpinFrame { plan: crate::spin::SpinPlan, frame: usize },
    PlaceLayer { image: Slice, width: usize, height: usize, rect: [i64; 4] },
    Blend { a: Slice, b: Slice, t: f64 },
    EnhanceInterior { image: Slice },
    EnhanceExposure { image: Slice, #[serde(default)] target_median: Option<f64>, #[serde(default)] max_lift: Option<f64> },
    WhiteBalance { image: Slice },
    Scrim { image: Slice, #[serde(default)] band_frac: Option<f64> },
    MaskStats { mask: Slice, #[serde(default)] threshold: Option<u8> },
    CutoutFromMask { photo: Slice, mask: Slice, #[serde(default)] threshold: Option<u8>, #[serde(default)] largest_only: bool },
    DuplicateScore { a: Slice, b: Slice, #[serde(default)] size: Option<usize> },
    ParseSticker(crate::sticker::StickerRequest),
    PanelSplitX { words: Vec<crate::sticker::Word>, #[serde(default)] y_tol: Option<f64> },
    BuildPosts(crate::copy::CopyRequest),
    /// A font's bytes, kept under a name; `data` is a 1-channel slice of
    /// the arena (width = byte count, height 1).
    LoadFont { name: String, data: Slice },
    /// Text overlays for one canvas from the vehicle and the Text controls.
    OverlayPlan(crate::text::PlanRequest),
    /// The overlays painted onto an image (RGB or RGBA).
    DrawOverlays { image: Slice, overlays: Vec<crate::text::Overlay> },
}

fn mask_threshold(t: Option<u8>) -> u8 {
    t.unwrap_or_else(|| (spec::f64_at(&["wheel", "maskThreshold"]) * 255.0) as u8)
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
        Op::LoadFont { name, data } => {
            let end = data.offset.checked_add(data.len).filter(|e| *e <= arena.len())
                .ok_or("font bytes lie outside the arena")?;
            crate::text::load_font(&name, &arena[data.offset..end])?;
            OpResult::Json(serde_json::to_string(&Scalar { value: true }).unwrap())
        }
        Op::OverlayPlan(req) => OpResult::Json(serde_json::to_string(&Scalar { value: crate::text::plan(&req)? }).unwrap()),
        Op::DrawOverlays { image, overlays } => {
            let img = slice_image(arena, &image)?;
            let mut out = (*img).clone();
            crate::text::draw(&mut out, &overlays)?;
            OpResult::Image(out)
        }
        Op::FitBorder { border, width, height, fit } => {
            let b = slice_image(arena, &border)?;
            OpResult::Image(crate::compose::fit_border(&b, width, height, fit.as_deref().unwrap_or("fit"))?)
        }
        Op::FitWindow { border, width, height, fit } => {
            let b = slice_image(arena, &border)?;
            let (l, t, r, bt) = crate::compose::fit_window(&b, width, height, fit.as_deref().unwrap_or("fit"))?;
            OpResult::Json(serde_json::to_string(&Scalar { value: [l, t, r, bt] }).unwrap())
        }
        Op::ResolveCollision { border, car, x, y } => {
            let b = slice_image(arena, &border)?;
            let c = slice_image(arena, &car)?;
            OpResult::Json(serde_json::to_string(&Scalar { value: resolve_collision(&b, &c, x, y) }).unwrap())
        }
        Op::CarouselPlan(req) => OpResult::Json(serde_json::to_string(&Scalar { value: crate::carousel::plan(&req, arena)? }).unwrap()),
        Op::CarouselFrame { plan, t } => OpResult::Json(serde_json::to_string(&Scalar { value: crate::carousel::frame(&plan, t) }).unwrap()),
        Op::Retain { image } => {
            let img = slice_image(arena, &image)?;
            let owned = Rc::try_unwrap(img).unwrap_or_else(|rc| (*rc).clone());
            OpResult::Json(serde_json::to_string(&Scalar { value: crate::compose::retain(owned) }).unwrap())
        }
        Op::Release { id } => OpResult::Json(serde_json::to_string(&Scalar { value: crate::compose::release(id) }).unwrap()),
        Op::ReleaseAll => OpResult::Json(serde_json::to_string(&Scalar { value: crate::compose::release_all() }).unwrap()),
        Op::SpinPlan(req) => OpResult::Json(serde_json::to_string(&Scalar { value: crate::spin::plan(&req)? }).unwrap()),
        Op::SpinFrame { plan, frame } => OpResult::Json(serde_json::to_string(&Scalar { value: crate::spin::frame(&plan, frame) }).unwrap()),
        Op::PlaceLayer { image, width, height, rect } => {
            let car = slice_image(arena, &image)?;
            OpResult::Image(crate::spin::place_layer(&car, width, height, rect)?)
        }
        Op::EnhanceInterior { image } => { let img = slice_image(arena, &image)?; OpResult::Image(crate::interior::enhance_interior(&img)) }
        Op::EnhanceExposure { image, target_median, max_lift } => {
            let img = slice_image(arena, &image)?;
            let target = target_median.unwrap_or_else(|| spec::f64_at(&["interior", "targetMedian"])) as f32;
            let lift = max_lift.unwrap_or_else(|| spec::f64_at(&["interior", "maxLift"])) as f32;
            OpResult::Image(crate::interior::enhance_exposure(&img, target, lift))
        }
        Op::WhiteBalance { image } => { let img = slice_image(arena, &image)?; OpResult::Image(crate::interior::correct_white_balance(&img)) }
        Op::Scrim { image, band_frac } => {
            let img = slice_image(arena, &image)?;
            OpResult::Image(crate::interior::scrim(&img, band_frac.unwrap_or_else(|| spec::f64_at(&["interior", "scrimFrac"])) as f32))
        }
        Op::MaskStats { mask, threshold } => {
            let m = slice_image(arena, &mask)?;
            OpResult::Json(serde_json::to_string(&Scalar { value: crate::mask::mask_stats(&m, mask_threshold(threshold)) }).unwrap())
        }
        Op::CutoutFromMask { photo, mask, threshold, largest_only } => {
            let (p, m) = (slice_image(arena, &photo)?, slice_image(arena, &mask)?);
            match crate::mask::cutout_from_mask(&p, &m, mask_threshold(threshold), largest_only)? {
                Some(img) => OpResult::Image(img),
                None => OpResult::Json(serde_json::to_string(&Scalar { value: Option::<u8>::None }).unwrap()),
            }
        }
        Op::DuplicateScore { a, b, size } => {
            let (a, b) = (slice_image(arena, &a)?, slice_image(arena, &b)?);
            let n = size.unwrap_or_else(|| spec::f64_at(&["wheel", "signatureSize"]) as usize);
            OpResult::Json(serde_json::to_string(&Scalar { value: crate::mask::duplicate_score(&a, &b, n) }).unwrap())
        }
        Op::ParseSticker(req) => OpResult::Json(serde_json::to_string(&Scalar { value: crate::sticker::parse_sticker(&req) }).unwrap()),
        Op::PanelSplitX { words, y_tol } => {
            let v = crate::sticker::panel_split_x(
                &words, y_tol.unwrap_or_else(|| spec::f64_at(&["sticker", "rowToleranceCli"])),
                spec::f64_at(&["sticker", "panelSplit", "centerFrac"]), spec::f64_at(&["sticker", "panelSplit", "searchFrac"]),
                spec::f64_at(&["sticker", "panelSplit", "minGap"]));
            OpResult::Json(serde_json::to_string(&Scalar { value: v }).unwrap())
        }
        Op::BuildPosts(req) => OpResult::Json(serde_json::to_string(&Scalar { value: crate::copy::build_posts(&req) }).unwrap()),
        Op::Blend { a, b, t } => {
            let (a, b) = (slice_image(arena, &a)?, slice_image(arena, &b)?);
            OpResult::Image(crate::spin::blend(&a, &b, t)?)
        }
        Op::VehicleGradientColors { exterior, interior, sample } => {
            let s = match sample { Some(s) => Some(slice_image(arena, &s)?), None => None };
            let (a, b) = crate::palette::vehicle_gradient_colors(exterior.as_deref(), interior.as_deref(), s.as_deref());
            OpResult::Json(serde_json::to_string(&Scalar { value: [a, b] }).unwrap())
        }
    })
}

#[allow(dead_code)]
fn _unused(i: &Image) -> Image { crop(i, 0, 0, 1, 1) }
