//! Text on a still: a title, a price badge, a dealer line. Rasterised
//! here (fontdue, pure Rust, same glyphs on both hosts) from a font the
//! host loads once, so the browser's preview and the CLI's hero carry
//! the same letters at the same places.
//!
//! Two halves. `plan` turns the vehicle record and the Text controls
//! into overlays with pixel positions for one canvas size, stacking
//! them in the chosen corner. `draw` paints overlays onto a finished
//! composition, over the frame, so text is never hidden by art.

use std::cell::RefCell;
use std::collections::HashMap;

use fontdue::layout::{CoordinateSystem, Layout, LayoutSettings, TextStyle};
use fontdue::{Font, FontSettings};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::copy::{commas0f, resolve_display_price, to_float, opt};
use crate::Image;

thread_local! {
    static FONTS: RefCell<HashMap<String, Font>> = RefCell::new(HashMap::new());
}

pub const DEFAULT_FONT: &str = "Lato Bold";

/// Keep a font under `name`. Loading the same bytes twice is harmless.
pub fn load_font(name: &str, bytes: &[u8]) -> Result<(), String> {
    let font = Font::from_bytes(bytes, FontSettings::default()).map_err(|e| format!("font {name:?}: {e}"))?;
    FONTS.with(|f| { f.borrow_mut().insert(name.to_string(), font); });
    Ok(())
}

pub fn has_font(name: &str) -> bool {
    FONTS.with(|f| f.borrow().contains_key(name))
}

fn with_font<T>(name: &str, f: impl FnOnce(&Font) -> T) -> Result<T, String> {
    FONTS.with(|fonts| {
        let fonts = fonts.borrow();
        let font = fonts.get(name).ok_or_else(|| format!("font {name:?} is not loaded; load_font first"))?;
        Ok(f(font))
    })
}

/// A run of text at `px`, as an alpha mask the size of its layout box
/// (lines wrap at `max_width`). Returns (mask, ascent-adjusted width,
/// height).
pub fn rasterize(font_name: &str, text: &str, px: f32, max_width: Option<f32>) -> Result<Image, String> {
    with_font(font_name, |font| {
        let mut layout = Layout::new(CoordinateSystem::PositiveYDown);
        layout.reset(&LayoutSettings { max_width, ..LayoutSettings::default() });
        layout.append(&[font], &TextStyle::new(text, px, 0));
        let glyphs = layout.glyphs();
        let mut w = 0f32;
        for g in glyphs { w = w.max(g.x + g.width as f32); }
        let h = layout.height().ceil().max(1.0) as usize;
        let w = (w.ceil().max(1.0)) as usize;
        let mut mask = Image::new(w, h, 1);
        for g in glyphs {
            if g.width == 0 || g.height == 0 { continue; }
            let (_, bitmap) = font.rasterize_config(g.key);
            let (gx, gy) = (g.x.round() as i64, g.y.round() as i64);
            for yy in 0..g.height {
                let dy = gy + yy as i64;
                if dy < 0 || dy >= h as i64 { continue; }
                for xx in 0..g.width {
                    let dx = gx + xx as i64;
                    if dx < 0 || dx >= w as i64 { continue; }
                    let d = dy as usize * w + dx as usize;
                    let a = bitmap[yy * g.width + xx];
                    if a > mask.data[d] { mask.data[d] = a; }
                }
            }
        }
        mask
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Pill {
    pub color: [u8; 4],
    pub pad: f64,
    pub radius: f64,
}

/// One piece of text with a pixel position (top-left of its box).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Overlay {
    pub text: String,
    #[serde(default)]
    pub font: Option<String>,
    pub size: f64,
    pub color: [u8; 3],
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub max_width: Option<f64>,
    #[serde(default)]
    pub pill: Option<Pill>,
    #[serde(default)]
    pub shadow: bool,
    /// The box the plan measured (pill included), so a composition can
    /// keep the vehicle out of the text's band without measuring again.
    #[serde(default)]
    pub box_w: f64,
    #[serde(default)]
    pub box_h: f64,
}

/// The rows the overlays occupy, as (top, bottom) in pixels, or None.
pub fn band(overlays: &[Overlay]) -> Option<(f64, f64)> {
    let mut top = f64::MAX;
    let mut bottom = f64::MIN;
    for o in overlays {
        top = top.min(o.y);
        bottom = bottom.max(o.y + o.box_h);
    }
    if top == f64::MAX { None } else { Some((top, bottom)) }
}

fn blend_px(dst: &mut [u8], color: [u8; 3], a: f32) {
    if a <= 0.0 { return; }
    for c in 0..3.min(dst.len()) {
        let v = dst[c] as f32 + (color[c] as f32 - dst[c] as f32) * a;
        dst[c] = v.round().clamp(0.0, 255.0) as u8;
    }
}

fn fill_rounded(canvas: &mut Image, x0: f64, y0: f64, w: f64, h: f64, r: f64, color: [u8; 4]) {
    let ch = canvas.channels;
    let a = color[3] as f32 / 255.0;
    let r = r.min(w / 2.0).min(h / 2.0);
    let (xs, ys) = (x0.floor().max(0.0) as usize, y0.floor().max(0.0) as usize);
    let (xe, ye) = (((x0 + w).ceil() as usize).min(canvas.width), ((y0 + h).ceil() as usize).min(canvas.height));
    for y in ys..ye {
        for x in xs..xe {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            // Distance outside the rounded rectangle, for a soft edge.
            let cx = px.clamp(x0 + r, x0 + w - r);
            let cy = py.clamp(y0 + r, y0 + h - r);
            let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt() - r;
            let cov = (0.5 - d).clamp(0.0, 1.0) as f32;
            let i = (y * canvas.width + x) * ch;
            blend_px(&mut canvas.data[i..i + ch], [color[0], color[1], color[2]], a * cov);
        }
    }
}

fn paint_mask(canvas: &mut Image, mask: &Image, x0: i64, y0: i64, color: [u8; 3], alpha: f32) {
    let ch = canvas.channels;
    for y in 0..mask.height {
        let dy = y0 + y as i64;
        if dy < 0 || dy >= canvas.height as i64 { continue; }
        for x in 0..mask.width {
            let dx = x0 + x as i64;
            if dx < 0 || dx >= canvas.width as i64 { continue; }
            let a = mask.data[y * mask.width + x] as f32 / 255.0 * alpha;
            let i = (dy as usize * canvas.width + dx as usize) * ch;
            blend_px(&mut canvas.data[i..i + ch], color, a);
        }
    }
}

/// Paint overlays onto `canvas` (RGB or RGBA), in order.
pub fn draw(canvas: &mut Image, overlays: &[Overlay]) -> Result<(), String> {
    for o in overlays {
        let font = o.font.as_deref().unwrap_or(DEFAULT_FONT);
        let mask = rasterize(font, &o.text, o.size as f32, o.max_width.map(|m| m as f32))?;
        let (mut x, mut y) = (o.x, o.y);
        if let Some(p) = &o.pill {
            fill_rounded(canvas, x, y, mask.width as f64 + 2.0 * p.pad, mask.height as f64 + 2.0 * p.pad, p.radius, p.color);
            x += p.pad;
            y += p.pad;
        }
        if o.shadow {
            let off = (o.size * 0.05).max(1.0).round() as i64;
            paint_mask(canvas, &mask, x.round() as i64 + off, y.round() as i64 + off, [0, 0, 0], 0.55);
        }
        paint_mask(canvas, &mask, x.round() as i64, y.round() as i64, o.color, 1.0);
    }
    Ok(())
}

/// The Text controls, and the vehicle they describe, for one canvas.
#[derive(Deserialize)]
pub struct PlanRequest {
    pub width: usize,
    pub height: usize,
    #[serde(default)]
    pub vehicle: Value,
    /// "none", "vehicle" (year make model trim) or "custom".
    #[serde(default = "none")]
    pub title: String,
    #[serde(default)]
    pub custom_title: Option<String>,
    #[serde(default)]
    pub price_badge: bool,
    #[serde(default)]
    pub line: Option<String>,
    /// "tl", "tr", "bl", "br" or "bc".
    #[serde(default = "bl")]
    pub position: String,
    /// "white" or "black".
    #[serde(default = "white")]
    pub color: String,
    /// The title's size as a fraction of the canvas height.
    #[serde(default = "size")]
    pub size: f64,
    #[serde(default)]
    pub font: Option<String>,
    /// The window to inset from (a frame's car window), else the canvas.
    #[serde(default)]
    pub window: Option<[i64; 4]>,
    /// The vehicle's paint for colour "paint": from the record's colour
    /// name, else sampled off `sample` (the hero cutout) by the caller.
    #[serde(default)]
    pub accent: Option<[u8; 3]>,
    #[serde(default)]
    pub sample: Option<crate::compose::Slice>,
}

/// The paint an overlay plan colours itself with: the record's exterior
/// colour name when it names a colour, else the cutout's own paint.
pub fn accent_for(vehicle: &Value, sample: Option<&Image>) -> Option<[u8; 3]> {
    let name = opt(vehicle, "exterior_color_factory").or_else(|| opt(vehicle, "exterior_color"));
    crate::palette::parse_color_name(name.as_deref())
        .or_else(|| sample.and_then(crate::palette::sample_cutout_color))
}
/// The same controls without a canvas: what a compose request carries,
/// sized once the request's own canvas and window are known.
#[derive(Deserialize, Clone)]
pub struct TextRequest {
    #[serde(default)]
    pub vehicle: Value,
    #[serde(default = "none")]
    pub title: String,
    #[serde(default)]
    pub custom_title: Option<String>,
    #[serde(default)]
    pub price_badge: bool,
    #[serde(default)]
    pub line: Option<String>,
    #[serde(default = "bl")]
    pub position: String,
    #[serde(default = "white")]
    pub color: String,
    #[serde(default = "size")]
    pub size: f64,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub accent: Option<[u8; 3]>,
}

impl TextRequest {
    pub fn for_canvas(&self, width: usize, height: usize) -> PlanRequest {
        PlanRequest {
            width, height, vehicle: self.vehicle.clone(), title: self.title.clone(),
            custom_title: self.custom_title.clone(), price_badge: self.price_badge, line: self.line.clone(),
            position: self.position.clone(), color: self.color.clone(), size: self.size, font: self.font.clone(),
            window: None, accent: self.accent, sample: None,
        }
    }

    /// Nothing to draw: the compose skips the plan and needs no font.
    pub fn is_empty(&self) -> bool {
        self.title == "none" && !self.price_badge && self.line.as_deref().map_or(true, |l| l.trim().is_empty())
    }
}

fn none() -> String { "none".into() }
fn bl() -> String { "bl".into() }
fn white() -> String { "white".into() }
fn size() -> f64 { 0.05 }

/// The vehicle's title line: year make model trim, whichever are set.
pub fn vehicle_title(v: &Value) -> String {
    ["year", "make", "model", "trim"].iter()
        .filter_map(|k| opt(v, k))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The price the badge shows: the post's own resolved price, with a
/// dollar sign and commas whatever form the listing held it in.
pub fn badge_price(v: &Value) -> Option<String> {
    let raw = resolve_display_price(v)?;
    let t = raw.trim();
    if t.is_empty() { return None; }
    match to_float(t) {
        Some(n) if n > 0.0 => Some(format!("${}", commas0f(n))),
        _ => Some(t.to_string()),
    }
}

/// Overlays for one canvas: the pieces stacked in the chosen corner,
/// title first (largest), then the price badge, then the line. Bottom
/// corners stack upwards so the title stays nearest the vehicle.
pub fn plan(req: &PlanRequest) -> Result<Vec<Overlay>, String> {
    let window = req.window.map(|w| (w[0], w[1], w[2], w[3])).unwrap_or((0, 0, req.width as i64, req.height as i64));
    plan_in(req, window)
}

/// The window with the overlays' band taken off its top or bottom, plus
/// a small gap, so a title never sits across a bumper. The band is at
/// the bottom when its middle is below the canvas's.
pub fn shrink_window(window: (i64, i64, i64, i64), overlays: &[Overlay], height: usize) -> (i64, i64, i64, i64) {
    let mut w = window;
    if let Some((top, bottom)) = band(overlays) {
        let gap = (height as f64 * 0.02).round() as i64;
        let (top, bottom) = (top.floor() as i64, bottom.ceil() as i64);
        if (top + bottom) / 2 > (height as i64) / 2 {
            w.3 = w.3.min(top - gap).max(w.1 + 1);
        } else {
            w.1 = w.1.max(bottom + gap).min(w.3 - 1);
        }
    }
    w
}

/// The plan inside a window (a frame's car window, or the canvas): the
/// stack is inset from the window's edges, never the frame's art.
pub fn plan_in(req: &PlanRequest, window: (i64, i64, i64, i64)) -> Result<Vec<Overlay>, String> {
    let (cw, ch) = (req.width as f64, req.height as f64);
    let (wl, wt) = (window.0.max(0) as f64, window.1.max(0) as f64);
    let (w, h) = ((window.2 as f64).min(cw) - wl, (window.3 as f64).min(ch) - wt);
    if w <= 0.0 || h <= 0.0 { return Err("text window is empty".into()); }
    let font = req.font.clone().unwrap_or_else(|| DEFAULT_FONT.into());
    if !has_font(&font) { return Err(format!("font {font:?} is not loaded; load_font first")); }
    // "paint": the badge takes the vehicle's own colour and the words
    // stay white (black on a pale paint), so the text reads as part of
    // the car rather than a label stuck on it.
    let accent = req.accent.unwrap_or([120, 120, 130]);
    let pale = 0.299 * accent[0] as f64 + 0.587 * accent[1] as f64 + 0.114 * accent[2] as f64 > 170.0;
    let (color, pill_color): ([u8; 3], [u8; 4]) = match req.color.as_str() {
        "black" => ([16, 16, 16], [255, 255, 255, 220]),
        "white" => ([255, 255, 255], [16, 18, 22, 210]),
        "paint" => (if pale { [16, 16, 16] } else { [255, 255, 255] }, [accent[0], accent[1], accent[2], 235]),
        other => return Err(format!("unknown text colour {other:?}; white, black or paint")),
    };
    let base = (req.size * ch).max(8.0);
    let inset = (w.min(h) * 0.045).round();
    let gap = (base * 0.35).round();
    let max_width = w - 2.0 * inset;

    // Each piece: text, size, pill?
    let mut pieces: Vec<(String, f64, Option<Pill>)> = Vec::new();
    let title = match req.title.as_str() {
        "vehicle" => vehicle_title(&req.vehicle),
        "custom" => req.custom_title.clone().unwrap_or_default(),
        "none" => String::new(),
        other => return Err(format!("unknown title mode {other:?}; none, vehicle or custom")),
    };
    if !title.trim().is_empty() { pieces.push((title.trim().to_string(), base, None)); }
    if req.price_badge {
        if let Some(p) = badge_price(&req.vehicle) {
            let px = (base * 0.85).round();
            pieces.push((p, px, Some(Pill { color: pill_color, pad: (px * 0.35).round(), radius: (px * 0.35).round() })));
        }
    }
    if let Some(line) = req.line.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        pieces.push((line.to_string(), (base * 0.62).round(), None));
    }
    if pieces.is_empty() { return Ok(Vec::new()); }

    // Measure, then place from the anchor corner.
    let mut boxes: Vec<(f64, f64)> = Vec::new();
    for (text, px, pill) in &pieces {
        let m = rasterize(&font, text, *px as f32, Some(max_width as f32))?;
        let pad = pill.as_ref().map(|p| 2.0 * p.pad).unwrap_or(0.0);
        boxes.push((m.width as f64 + pad, m.height as f64 + pad));
    }
    let bottom = req.position.starts_with('b');
    let right = req.position.ends_with('r');
    let centre = req.position.ends_with('c');
    if !matches!(req.position.as_str(), "tl" | "tr" | "bl" | "br" | "bc" | "tc") {
        return Err(format!("unknown text position {:?}; tl, tr, bl, br, tc or bc", req.position));
    }
    // The stack reads title, price, line from the top down wherever it
    // sits, so a bottom corner is filled from the last piece upwards.
    let mut items: Vec<_> = pieces.into_iter().zip(boxes).collect();
    if bottom { items.reverse(); }
    let mut out = Vec::new();
    let mut y = if bottom { h - inset } else { inset };
    for ((text, px, pill), (bw, bh)) in items {
        let x = if centre { ((w - bw) / 2.0).round() } else if right { (w - inset - bw).round() } else { inset };
        let top = if bottom { y - bh } else { y };
        out.push(Overlay {
            text, font: Some(font.clone()), size: px, color, x: x + wl, y: (top + wt).round(),
            max_width: Some(max_width), shadow: pill.is_none(), pill, box_w: bw, box_h: bh,
        });
        y = if bottom { top - gap } else { y + bh + gap };
    }
    if bottom { out.reverse(); }
    Ok(out)
}
