/* Background removal.
 *
 * u2net int8 at a fixed 256x256, chosen by measurement over BiRefNet,
 * IS-Net, u2netp and bria-rmbg: 0/150 catastrophic failures on real
 * production photos, composites indistinguishable from BiRefNet at a
 * fraction of the size and time. u2netp, the obvious small alternative,
 * failed catastrophically on 37.3% of the same set -- it is a general
 * salient-object detector and picks the wheel once the body stops
 * dominating the frame.
 *
 * The 256x256 input is FIXED. The alpha is upsampled back to the source
 * resolution afterwards, which is fine because a matte is smooth; what
 * is not fine is a dynamic-axis model, which ORT-web handles badly. */

import { loadModel, getOrt } from './runtime.js';
import { resizeTo, imageDataOf, makeCanvas, ctxOf } from '../lib/imageio.js';
import { available as coreAvailable, call as coreCall, toImageData } from '../core.js';
import { ALPHA_THRESHOLD } from '../config.js';

/* u2net's own normalisation, which is NOT ImageNet's.
 * From rembg's u2net session: the image is divided by its own max, then
 * normalised with these constants. Using ImageNet's here produces a
 * plausible-looking but measurably worse matte. */
const U2NET_MEAN = [0.485, 0.456, 0.406];
const U2NET_STD = [0.229, 0.224, 0.225];

function toU2netTensor(imageData, size) {
  const { data } = imageData;
  const n = size * size;
  const out = new Float32Array(3 * n);

  // Divide by the per-image maximum, matching rembg's preprocessing.
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > max) max = data[i];
    if (data[i + 1] > max) max = data[i + 1];
    if (data[i + 2] > max) max = data[i + 2];
  }
  if (max === 0) max = 1;

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[i]         = (data[p]     / max - U2NET_MEAN[0]) / U2NET_STD[0];
    out[n + i]     = (data[p + 1] / max - U2NET_MEAN[1]) / U2NET_STD[1];
    out[2 * n + i] = (data[p + 2] / max - U2NET_MEAN[2]) / U2NET_STD[2];
  }
  return out;
}

/* Produce an alpha matte for `bitmap`.
 *
 * Returns { alpha, size } where alpha is a Float32Array of size*size in
 * [0,1]. Whether it is good enough is the core's gate (gateCutout), read
 * off the matte stretched to the photo's size. */
export async function matte(bitmap, onProgress, model = 'matte') {
  const { session, spec, inputName } = await loadModel(model, onProgress);
  const ort = getOrt();
  const size = spec.size;

  const data = toU2netTensor(imageDataOf(resizeTo(bitmap, size, size)), size);
  const out = await session.run({ [inputName]: new ort.Tensor('float32', data, [1, 3, size, size]) });

  // u2net exposes 7 side outputs (d0..d6). d0 -- the first, and the only
  // one rembg uses -- is the fused full-resolution prediction.
  const raw = out[session.outputNames[0]].data;

  /* u2net's output is MIN-MAX normalised, not passed through a sigmoid.
   *
   * This is the single easiest thing in the file to get wrong, and it
   * has now been got wrong in both directions. BiRefNet is the model
   * whose predict() applies a sigmoid; u2net and IS-Net rescale by the
   * output's own min/max, exactly as rembg does. Applying a sigmoid here
   * instead yields a uniform ~0.5 field -- a matte where every pixel is
   * "maybe", which shows up as ambiguous=1.0 and coverage=1.0 rather
   * than as an error. */
  const n = size * size;
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < n; i++) {
    if (raw[i] < mi) mi = raw[i];
    if (raw[i] > ma) ma = raw[i];
  }
  const span = (ma - mi) || 1;

  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = (raw[i] - mi) / span;

  return { alpha, size };
}

/* Apply an alpha matte to a bitmap at full source resolution, crop to
 * the visible pixels, and return { canvas, bbox, coverage, matteAlpha }
 * (the stretched matte the gate reads, one byte a pixel).
 *
 * The crop matters downstream: compute_placement() in layout.py expects
 * a cutout already trimmed to its visible pixels, and scales it to fill
 * its box. An uncropped cutout would be scaled by its transparent
 * padding and come out small and off-centre. */
export function applyMatte(bitmap, { alpha, size }) {
  const W = bitmap.width, H = bitmap.height;

  // Upscale the matte to source resolution via the GPU-backed 2D
  // context -- bilinear, and far faster than doing it in JS.
  const mc = makeCanvas(size, size);
  const mctx = ctxOf(mc, { willReadFrequently: true });
  const mimg = mctx.createImageData(size, size);
  for (let i = 0; i < alpha.length; i++) {
    const v = Math.round(alpha[i] * 255);
    const p = i * 4;
    mimg.data[p] = mimg.data[p + 1] = mimg.data[p + 2] = v;
    mimg.data[p + 3] = 255;
  }
  mctx.putImageData(mimg, 0, 0);

  const full = makeCanvas(W, H);
  const fctx = ctxOf(full, { willReadFrequently: true });
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(mc, 0, 0, W, H);
  const mask = fctx.getImageData(0, 0, W, H).data;

  fctx.clearRect(0, 0, W, H);
  fctx.drawImage(bitmap, 0, 0);
  const img = fctx.getImageData(0, 0, W, H);

  // The stretched matte, one byte a pixel, is what the gate reads.
  const matteAlpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { img.data[i * 4 + 3] = mask[i * 4]; matteAlpha[i] = mask[i * 4]; }

  /* The stretched matte is soft for several pixels and carries the old
   * background's colour in that rim (a pale halo on a dark backdrop).
   * The core snaps the edge to the photo and takes the background out
   * of the rim's colour (core/src/matting.rs), as the CLI does. */
  let out = img;
  if (coreAvailable()) {
    try { out = toImageData(coreCall({ op: 'refine_cutout', image: { $image: 0 } }, [img])); } catch { out = img; }
  }

  let minX = W, minY = H, maxX = -1, maxY = -1, opaque = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = out.data[(y * W + x) * 4 + 3];
      if (a > ALPHA_THRESHOLD) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return { canvas: null, bbox: null, coverage: 0, matteAlpha, width: W, height: H };

  fctx.putImageData(out, 0, 0);

  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const cut = makeCanvas(cw, ch);
  ctxOf(cut).drawImage(full, minX, minY, cw, ch, 0, 0, cw, ch);

  return {
    canvas: cut,
    bbox: { x: minX, y: minY, w: cw, h: ch },
    coverage: opaque / (W * H),
    matteAlpha, width: W, height: H,
  };
}

/* Is this cutout good enough to compose? The core's gate (gate.rs), the
 * one the CLI's imaging/cutout.py applies, on the model's matte at the
 * photo's size before any refinement: ambiguous edges, a close-up that
 * fills the frame, a subject too small or a background not separated.
 * Off (`strict` false) keeps only the hard failure, no subject at all.
 * Returns { ok, reason, ambiguous, coverage, fills_frame, bbox }, the
 * reason phrased for a person. */
export function gateCutout(cut, strict = true) {
  if (!cut.matteAlpha) return { ok: false, reason: 'no vehicle found in this photo', fills_frame: false };
  return coreCall({ op: 'cutout_gate', strict, alpha: { $image: 0 } },
    [{ width: cut.width, height: cut.height, channels: 1, data: cut.matteAlpha }]);
}
