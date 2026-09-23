//! A frame the core draws itself: a rounded line inset from the edge,
//! at whatever size the canvas is, so it fits every format exactly
//! where a frame drawn as art fits one. It is used exactly as a border
//! image is (the window inside it, collision against it, on top), so
//! nothing downstream knows the difference.

use serde::Deserialize;

use crate::Image;

#[derive(Deserialize, Clone, Debug)]
pub struct FrameStyle {
    /// "line" is the only kind for now.
    #[serde(default = "line")]
    pub kind: String,
    /// Stroke weight as a fraction of the canvas's shorter side.
    #[serde(default = "weight")]
    pub weight: f64,
    /// Inset from the edge as a fraction of the shorter side.
    #[serde(default = "inset")]
    pub inset: f64,
    /// Corner radius as a fraction of the shorter side.
    #[serde(default = "radius")]
    pub radius: f64,
    /// "white", "black" or "paint" (resolved by the caller to `rgb`).
    #[serde(default = "white")]
    pub color: String,
    #[serde(default)]
    pub rgb: Option<[u8; 3]>,
}
fn line() -> String { "line".into() }
fn weight() -> f64 { 0.008 }
fn inset() -> f64 { 0.035 }
fn radius() -> f64 { 0.02 }
fn white() -> String { "white".into() }

impl FrameStyle {
    pub fn colour(&self) -> Result<[u8; 3], String> {
        Ok(match self.color.as_str() {
            "white" => [255, 255, 255],
            "black" => [16, 16, 16],
            "paint" => self.rgb.unwrap_or([160, 160, 170]),
            other => return Err(format!("unknown frame colour {other:?}; white, black or paint")),
        })
    }
}

/// Signed distance to a rounded rectangle's edge (negative inside).
fn rounded_sd(px: f64, py: f64, x0: f64, y0: f64, x1: f64, y1: f64, r: f64) -> f64 {
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let (hw, hh) = ((x1 - x0) / 2.0 - r, (y1 - y0) / 2.0 - r);
    let (dx, dy) = ((px - cx).abs() - hw, (py - cy).abs() - hh);
    let outside = (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt();
    outside + dx.max(dy).min(0.0) - r
}

/// The frame as a `w`x`h` RGBA image: transparent everywhere but the line.
pub fn draw(w: usize, h: usize, style: &FrameStyle) -> Result<Image, String> {
    if style.kind != "line" { return Err(format!("unknown frame kind {:?}; line", style.kind)); }
    let side = w.min(h) as f64;
    let weight = (style.weight * side).max(1.0);
    let inset = style.inset * side;
    let radius = (style.radius * side).max(0.0);
    let [r, g, b] = style.colour()?;
    let (x0, y0, x1, y1) = (inset, inset, w as f64 - inset, h as f64 - inset);
    let mut out = Image::new(w, h, 4);
    // Only the rows and columns near the line are touched; the interior
    // and the margin stay transparent without a visit.
    let band = weight + 2.0;
    for y in 0..h {
        let py = y as f64 + 0.5;
        let near_row = py < y0 + radius + band || py > y1 - radius - band;
        for x in 0..w {
            let px = x as f64 + 0.5;
            if !near_row && px > x0 + band && px < x1 - band { continue; }
            let d = rounded_sd(px, py, x0, y0, x1, y1, radius).abs() - weight / 2.0;
            let cov = (0.5 - d).clamp(0.0, 1.0);
            if cov <= 0.0 { continue; }
            let i = (y * w + x) * 4;
            out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b;
            out.data[i + 3] = (cov * 255.0).round() as u8;
        }
    }
    Ok(out)
}
