//! C ABI for the native build. src/lotstretcher/core.py loads the
//! cdylib with ctypes; no build tool beyond cargo is involved.
//!
//! Every call takes a JSON request and a byte arena and returns a
//! buffer the caller frees with ls_free. Errors come back as a
//! NUL-terminated message in the same buffer with `ok` = 0.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};

#[repr(C)]
pub struct LsBuffer {
    pub ptr: *mut u8,
    pub len: usize,
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub ok: c_int,
}

fn into_buffer(result: Result<crate::Image, String>) -> LsBuffer {
    match result {
        Ok(img) => {
            let mut v = img.data.into_boxed_slice();
            let b = LsBuffer { ptr: v.as_mut_ptr(), len: v.len(), width: img.width, height: img.height, channels: img.channels, ok: 1 };
            std::mem::forget(v);
            b
        }
        Err(msg) => {
            let mut v = format!("{msg}\0").into_bytes().into_boxed_slice();
            let b = LsBuffer { ptr: v.as_mut_ptr(), len: v.len(), width: 0, height: 0, channels: 0, ok: 0 };
            std::mem::forget(v);
            b
        }
    }
}

/// # Safety
/// `request` is a NUL-terminated UTF-8 string; `arena` points at `arena_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn ls_compose_hero(request: *const c_char, arena: *const u8, arena_len: usize) -> LsBuffer {
    let req = match CStr::from_ptr(request).to_str() {
        Ok(s) => s,
        Err(_) => return into_buffer(Err("request is not UTF-8".into())),
    };
    let arena = if arena.is_null() { &[][..] } else { std::slice::from_raw_parts(arena, arena_len) };
    into_buffer(crate::compose::compose_json(req, arena))
}

/// # Safety
/// `arena` points at `arena_len` readable bytes of an RGBA cutout.
#[no_mangle]
pub unsafe extern "C" fn ls_vehicle_gradient_colors(exterior: *const c_char, interior: *const c_char,
                                                     arena: *const u8, arena_len: usize, width: usize, height: usize,
                                                     out: *mut u8) -> c_int {
    let ext = if exterior.is_null() { None } else { CStr::from_ptr(exterior).to_str().ok() };
    let inr = if interior.is_null() { None } else { CStr::from_ptr(interior).to_str().ok() };
    let sample = if arena.is_null() || arena_len == 0 {
        None
    } else {
        crate::Image::from_vec(width, height, 4, std::slice::from_raw_parts(arena, arena_len).to_vec()).ok()
    };
    let (a, b) = crate::palette::vehicle_gradient_colors(ext, inr, sample.as_ref());
    let out = std::slice::from_raw_parts_mut(out, 6);
    out[..3].copy_from_slice(&a);
    out[3..].copy_from_slice(&b);
    1
}

/// # Safety
/// `buf` came from this library.
#[no_mangle]
pub unsafe extern "C" fn ls_free(buf: LsBuffer) {
    if !buf.ptr.is_null() && buf.len > 0 {
        drop(Box::from_raw(std::slice::from_raw_parts_mut(buf.ptr, buf.len)));
    }
}

/// # Safety
/// `border` points at width*height*4 readable bytes; `out` at 4 writable i64s.
#[no_mangle]
pub unsafe extern "C" fn ls_detect_window(border: *const u8, width: usize, height: usize, out: *mut i64) -> c_int {
    let img = match crate::Image::from_vec(width, height, 4, std::slice::from_raw_parts(border, width * height * 4).to_vec()) {
        Ok(i) => i,
        Err(_) => return 0,
    };
    match crate::window::detect_window(&img) {
        Ok((l, t, r, b)) => {
            let o = std::slice::from_raw_parts_mut(out, 4);
            o.copy_from_slice(&[l, t, r, b]);
            1
        }
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn ls_version() -> u32 { 2 }
