/* Image decode, resize and tensor conversion.
 *
 * Everything goes through ImageBitmap + OffscreenCanvas where available:
 * createImageBitmap decodes off the main thread, which is the difference
 * between a scroll that stutters on every photo and one that does not. */

import { NORM_MEAN, NORM_STD } from '../config.js';

/* Duck-typed rather than `instanceof Blob`.
 *
 * instanceof is realm-sensitive: a File picked in one window and handed
 * to code running in another (an iframe, a popup) fails the check
 * against the *local* Blob constructor, falls through to the URL branch,
 * and fetches the string "[object File]" -- which surfaces as a
 * baffling 404 on a file the user definitely selected. */
const isBlob = (v) => v && typeof v === 'object'
  && typeof v.arrayBuffer === 'function' && typeof v.size === 'number';

export async function decode(source) {
  // A Blob/File decodes directly. A URL needs fetching first so that a
  // CORS failure surfaces as a clear error rather than a tainted canvas
  // later, at composite time, where the cause is much harder to see.
  if (isBlob(source)) return createImageBitmap(source);

  const res = await fetch(source, { mode: 'cors' });
  if (!res.ok) throw new Error(`${res.status} fetching image`);
  return createImageBitmap(await res.blob());
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function ctxOf(canvas, opts = {}) {
  return canvas.getContext('2d', { willReadFrequently: false, ...opts });
}

/* Draw `bitmap` into a w*h canvas, stretching to fill.
 * Both models take a fixed square, and the CLIP-era pipeline resized
 * without preserving aspect too, so this matches what they were trained
 * and distilled on. Do not "fix" this to letterbox -- it would shift the
 * input distribution away from the training data. */
export function resizeTo(bitmap, w, h) {
  const c = makeCanvas(w, h);
  const ctx = ctxOf(c);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c;
}

export function imageDataOf(canvas) {
  return ctxOf(canvas, { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
}

/* RGBA bytes -> NCHW float32, ImageNet-normalised.
 * Layout must be [1,3,H,W] planar, not interleaved -- an interleaved
 * tensor runs perfectly happily and returns confident nonsense. */
export function toTensorNCHW(imageData, size) {
  const { data } = imageData;
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[i]         = (data[p]     / 255 - NORM_MEAN[0]) / NORM_STD[0];
    out[n + i]     = (data[p + 1] / 255 - NORM_MEAN[1]) / NORM_STD[1];
    out[2 * n + i] = (data[p + 2] / 255 - NORM_MEAN[2]) / NORM_STD[2];
  }
  return out;
}

export function softmax(logits) {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let sum = 0;
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) { out[i] = Math.exp(logits[i] - max); sum += out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

export async function canvasToBlob(canvas, type = 'image/png', quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/* Cover-fit, matching compose/background.py::fit_background() --
 * scale to fill, crop the overflow, centred. */
export function coverFit(src, w, h) {
  const c = makeCanvas(w, h);
  const ctx = ctxOf(c);
  const scale = Math.max(w / src.width, h / src.height);
  const dw = src.width * scale, dh = src.height * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return c;
}
