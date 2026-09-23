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

/// [left, top, right, bottom] of an RGBA border's transparent window.
#[wasm_bindgen]
pub fn detect_window(border: &[u8], width: usize, height: usize) -> Result<Vec<i32>, JsError> {
    let img = crate::Image::from_vec(width, height, 4, border.to_vec()).map_err(|e| JsError::new(&e))?;
    let (l, t, r, b) = crate::window::detect_window(&img).map_err(|e| JsError::new(&e))?;
    Ok(vec![l as i32, t as i32, r as i32, b as i32])
}

/// The general entry point (see frame.rs::Op). Returns a JS object
/// {kind: "image", width, height, channels, data} or {kind: "json", text}.
#[wasm_bindgen]
pub fn call(op: &str, arena: &[u8]) -> Result<JsValue, JsError> {
    let out = js_sys::Object::new();
    match crate::frame::call(op, arena).map_err(|e| JsError::new(&e))? {
        crate::frame::OpResult::Image(img) => {
            js_sys::Reflect::set(&out, &"kind".into(), &"image".into()).ok();
            js_sys::Reflect::set(&out, &"width".into(), &(img.width as u32).into()).ok();
            js_sys::Reflect::set(&out, &"height".into(), &(img.height as u32).into()).ok();
            js_sys::Reflect::set(&out, &"channels".into(), &(img.channels as u32).into()).ok();
            js_sys::Reflect::set(&out, &"data".into(), &js_sys::Uint8Array::from(&img.data[..]).into()).ok();
        }
        crate::frame::OpResult::Json(text) => {
            js_sys::Reflect::set(&out, &"kind".into(), &"json".into()).ok();
            js_sys::Reflect::set(&out, &"text".into(), &text.into()).ok();
        }
    }
    Ok(out.into())
}

#[wasm_bindgen]
pub fn version() -> u32 { 3 }
