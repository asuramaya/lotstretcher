//! wasm-bindgen surface for the browser. Built with
//! `wasm-pack build --target web --features wasm` into web/public/core/.

use wasm_bindgen::prelude::*;

/// Composed RGB bytes for the request, or a thrown Error.
#[wasm_bindgen]
pub fn compose_hero(request: &str, arena: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::compose::compose_json(request, arena).map(|img| img.data).map_err(|e| JsError::new(&e))
}

/// [r,g,b, r,g,b] for the exterior and interior stops.
#[wasm_bindgen]
pub fn vehicle_gradient_colors(exterior: Option<String>, interior: Option<String>, sample: &[u8], width: usize, height: usize) -> Vec<u8> {
    let img = if sample.is_empty() { None } else { crate::Image::from_vec(width, height, 4, sample.to_vec()).ok() };
    let (a, b) = crate::palette::vehicle_gradient_colors(exterior.as_deref(), interior.as_deref(), img.as_ref());
    let mut out = a.to_vec();
    out.extend_from_slice(&b);
    out
}

#[wasm_bindgen]
pub fn version() -> u32 { 1 }
