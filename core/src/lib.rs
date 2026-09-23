//! lotstretcher-core: one implementation of the image math, for both
//! surfaces.
//!
//! The Python pipeline and the browser client used to carry their own
//! ports of the compositing (gradient backdrop, adaptive spotlight,
//! placement, glow), held together by a shared spec and parity tests.
//! This crate is that math written once. The CLI and server load it as
//! a native cdylib through ctypes (src/lotstretcher/core.py); the browser
//! loads the same source compiled to wasm32 (web/public/js/core.js).
//!
//! Only pure functions over byte buffers live here. Models stay in ONNX
//! Runtime on both sides; file IO, JSON records and HTTP stay in the
//! hosts. Every constant comes from shared/pipeline-spec.json, embedded
//! at build time, so a number changed there changes here.

pub mod spec;
pub mod par;
pub mod prng;
pub mod hsv;
pub mod palette;
pub mod resize;
pub mod gradient;
pub mod spotlight;
pub mod layout;
pub mod glow;
pub mod window;
pub mod compose;
pub mod frame;
pub mod carousel;
pub mod spin;
pub mod interior;
pub mod mask;
pub mod sticker;
pub mod copy;
pub mod text;

#[cfg(not(target_arch = "wasm32"))]
pub mod ffi;
#[cfg(feature = "wasm")]
pub mod wasm;

/// An 8-bit image buffer: `channels` is 1 (L), 3 (RGB) or 4 (RGBA),
/// row-major, no padding. The hosts hand these in as plain bytes.
#[derive(Clone, Debug)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub data: Vec<u8>,
}

impl Image {
    pub fn new(width: usize, height: usize, channels: usize) -> Self {
        Image { width, height, channels, data: vec![0; width * height * channels] }
    }
    pub fn from_vec(width: usize, height: usize, channels: usize, data: Vec<u8>) -> Result<Self, String> {
        if data.len() != width * height * channels {
            return Err(format!("buffer is {} bytes, expected {}x{}x{}", data.len(), width, height, channels));
        }
        Ok(Image { width, height, channels, data })
    }
}
