//! Mask arithmetic for the wheel money shot (port of the numpy and
//! OpenCV in imaging/wheel.py and photos.py). The models that make the
//! masks are the host's; what is done with a mask is here: its bounds,
//! its connected components (8-connected, as cv2.connectedComponents
//! defaults), the dominance and width gates that say a photo is
//! composed around one wheel, the aspect gate that says the angle is
//! right, the crop to an RGBA cutout, and the duplicate signature.

use serde::Serialize;

use crate::resize::resize_lanczos;
use crate::Image;

#[derive(Serialize)]
pub struct MaskStats {
    pub any: bool,
    /// [left, top, right, bottom], right and bottom exclusive.
    pub bbox: [usize; 4],
    pub pixels: usize,
    pub components: usize,
    pub largest_bbox: [usize; 4],
    pub largest_pixels: usize,
    /// largest / all mask pixels.
    pub dominance: f64,
    /// The largest blob's width over the image width.
    pub largest_width_frac: f64,
    /// Width / height of the largest blob's box.
    pub largest_aspect: f64,
}

fn on(mask: &Image, threshold: u8) -> Vec<bool> {
    let c = mask.channels;
    (0..mask.width * mask.height).map(|i| mask.data[i * c] > threshold).collect()
}

/// Component labels (0 = background), 8-connected, and each label's size.
fn components(bits: &[bool], w: usize, h: usize) -> (Vec<u32>, Vec<usize>) {
    let mut labels = vec![0u32; w * h];
    let mut sizes = vec![0usize];
    let mut stack = Vec::new();
    for start in 0..w * h {
        if !bits[start] || labels[start] != 0 { continue; }
        let id = sizes.len() as u32;
        sizes.push(0);
        labels[start] = id;
        stack.push(start);
        while let Some(i) = stack.pop() {
            sizes[id as usize] += 1;
            let (x, y) = ((i % w) as i64, (i / w) as i64);
            for dy in -1..=1i64 {
                for dx in -1..=1i64 {
                    if dx == 0 && dy == 0 { continue; }
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 { continue; }
                    let j = ny as usize * w + nx as usize;
                    if bits[j] && labels[j] == 0 { labels[j] = id; stack.push(j); }
                }
            }
        }
    }
    (labels, sizes)
}

fn bbox_of(pred: impl Fn(usize) -> bool, w: usize, h: usize) -> ([usize; 4], usize) {
    let (mut l, mut t, mut r, mut b, mut n) = (usize::MAX, usize::MAX, 0, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if pred(y * w + x) {
                n += 1;
                l = l.min(x); t = t.min(y); r = r.max(x + 1); b = b.max(y + 1);
            }
        }
    }
    if n == 0 { ([0, 0, 0, 0], 0) } else { ([l, t, r, b], n) }
}

pub fn mask_stats(mask: &Image, threshold: u8) -> MaskStats {
    let (w, h) = (mask.width, mask.height);
    let bits = on(mask, threshold);
    let (bbox, pixels) = bbox_of(|i| bits[i], w, h);
    if pixels == 0 {
        return MaskStats { any: false, bbox, pixels: 0, components: 0, largest_bbox: bbox, largest_pixels: 0,
                           dominance: 0.0, largest_width_frac: 0.0, largest_aspect: 0.0 };
    }
    let (labels, sizes) = components(&bits, w, h);
    let largest = (1..sizes.len()).max_by_key(|&i| (sizes[i], std::cmp::Reverse(i))).unwrap() as u32;
    let (lb, ln) = bbox_of(|i| labels[i] == largest, w, h);
    MaskStats {
        any: true, bbox, pixels, components: sizes.len() - 1, largest_bbox: lb, largest_pixels: ln,
        dominance: ln as f64 / pixels as f64,
        largest_width_frac: (lb[2] - lb[0]) as f64 / w as f64,
        largest_aspect: (lb[2] - lb[0]) as f64 / (lb[3] - lb[1]) as f64,
    }
}

/// The photo's pixels under the mask as an RGBA cutout cropped to the
/// mask's bounds; with `largest_only`, the mask is first reduced to its
/// largest connected component (a detached fragment would otherwise
/// skew the box the angle gate measures).
pub fn cutout_from_mask(photo: &Image, mask: &Image, threshold: u8, largest_only: bool) -> Result<Option<Image>, String> {
    if photo.width != mask.width || photo.height != mask.height {
        return Err("mask and photo must be one size".into());
    }
    let (w, h) = (photo.width, photo.height);
    let mut bits = on(mask, threshold);
    if !bits.iter().any(|&b| b) { return Ok(None); }
    if largest_only {
        let (labels, sizes) = components(&bits, w, h);
        if sizes.len() > 2 {
            let largest = (1..sizes.len()).max_by_key(|&i| (sizes[i], std::cmp::Reverse(i))).unwrap() as u32;
            for i in 0..w * h { bits[i] = labels[i] == largest; }
        }
    }
    let ([l, t, r, b], _) = bbox_of(|i| bits[i], w, h);
    let (cw, ch) = (r - l, b - t);
    let mut out = Image::new(cw, ch, 4);
    let pc = photo.channels;
    for y in 0..ch {
        for x in 0..cw {
            let si = (t + y) * w + l + x;
            let di = (y * cw + x) * 4;
            out.data[di..di + 3].copy_from_slice(&photo.data[si * pc..si * pc + 3]);
            out.data[di + 3] = if bits[si] { 255 } else { 0 };
        }
    }
    Ok(Some(out))
}

/// Cosine similarity of two images' small normalised signatures: tight
/// crops of the same wheel match almost exactly; different wheels do
/// not come close.
pub fn duplicate_score(a: &Image, b: &Image, size: usize) -> f64 {
    let sig = |img: &Image| -> Vec<f64> {
        let small = resize_lanczos(img, size, size);
        let c = small.channels;
        let v: Vec<f64> = (0..size * size).flat_map(|i| (0..3).map(move |ch| (i, ch)))
            .map(|(i, ch)| small.data[i * c + ch] as f64).collect();
        let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm > 0.0 { v.iter().map(|x| x / norm).collect() } else { v }
    };
    let (sa, sb) = (sig(a), sig(b));
    sa.iter().zip(sb.iter()).map(|(x, y)| x * y).sum()
}
