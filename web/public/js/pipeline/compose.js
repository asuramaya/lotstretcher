/* Hero composition: gradient backdrop + adaptive spotlight + cutout.
 *
 * Ports compose/background.py, compose/layout.py::compute_placement()
 * and the frameless path of compose/hero.py. Frameless is the whole v1
 * story: a border is an ASSET, and Tier 0 ships no assets at all.
 *
 * Deliberately NOT ported yet: multi-car layouts (quad/conveyor/corners),
 * borders, glow. They need an asset library, which is Tier 1. */

import { CANVAS } from '../config.js';
import { makeCanvas, ctxOf, coverFit } from '../lib/imageio.js';
import { vehicleGradientColors, hsvToRgb } from './palette.js';

/* Deterministic PRNG, seeded from a string.
 *
 * Seeded rather than free-random on purpose: the same vehicle+photo
 * always regenerates the same backdrop, so a rerun is a no-op and a
 * reported problem can actually be reproduced. Variety across posts
 * comes from the seed differing per photo, not from the clock.
 *
 * NOTE: this is mulberry32, not Python's Mersenne Twister. Output is
 * deterministic within the browser client but is NOT bit-identical to
 * the CLI's for the same seed. The two surfaces produce equally valid
 * backdrops, not the same one. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* Hue bands the fully-generated gradients sample from, as (lo, hi) in
 * HSV hue units (may exceed 1.0 and wrap). Deliberately NOT the full hue
 * circle: unconstrained hue lands on yellow-greens and mustards often
 * enough to look like a bug rather than a choice, and every one of these
 * has to be postable without a human checking it first. */
const GRADIENT_HUE_BANDS = [
  [0.55, 0.70],   // blue -> indigo
  [0.45, 0.55],   // teal -> cyan
  [0.92, 1.04],   // crimson -> red
  [0.74, 0.86],   // violet -> magenta
  [0.02, 0.08],   // rust -> warm orange
  [0.58, 0.62],   // steel blue
];

const GRADIENT_BUILD_MAX = 320;

/* A linear gradient at `angle` degrees (0 = left-to-right, increasing
 * counter-clockwise), interpolated start -> end.
 *
 * Every pixel is projected onto the angle's direction vector and
 * normalised over that projection's own min/max, so the full color range
 * lands corner-to-corner at ANY angle. Projecting onto a fixed axis
 * instead compresses the ramp into the middle on diagonals and leaves
 * flat bands in the corners.
 *
 * Built small and upscaled: a linear ramp is smooth by definition, so
 * there is no detail to lose, and building it at full size was the
 * single biggest per-frame cost after the spotlight. */
export function makeLinearGradient(w, h, angle, start, end) {
  const scale = Math.max(w, h) / GRADIENT_BUILD_MAX;
  const bw = scale > 1 ? Math.max(2, Math.round(w / scale)) : w;
  const bh = scale > 1 ? Math.max(2, Math.round(h / scale)) : h;

  const theta = (angle * Math.PI) / 180;
  const dx = Math.cos(theta), dy = -Math.sin(theta);

  let min = Infinity, max = -Infinity;
  for (const [x, y] of [[0, 0], [bw - 1, 0], [0, bh - 1], [bw - 1, bh - 1]]) {
    const p = x * dx + y * dy;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const span = max - min || 1;

  const small = makeCanvas(bw, bh);
  const sctx = ctxOf(small, { willReadFrequently: true });
  const img = sctx.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const t = ((x * dx + y * dy) - min) / span;
      const i = (y * bw + x) * 4;
      img.data[i]     = start[0] + (end[0] - start[0]) * t;
      img.data[i + 1] = start[1] + (end[1] - start[1]) * t;
      img.data[i + 2] = start[2] + (end[2] - start[2]) * t;
      img.data[i + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);

  if (bw === w && bh === h) return small;
  const out = makeCanvas(w, h);
  const octx = ctxOf(out);
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, w, h);
  return out;
}

/* A gradient built from THIS vehicle's own colors. Only the angle and
 * the stop order are random -- the colors are the car's, so the backdrop
 * reinforces it instead of being arbitrary decoration. */
export function vehicleGradient(w, h, seed, exterior, interior, cutoutImageData) {
  const rand = mulberry32(hashSeed(String(seed)));
  let [start, end] = vehicleGradientColors(exterior, interior, cutoutImageData);
  const angle = rand() * 360;
  if (rand() < 0.5) [start, end] = [end, start];
  return makeLinearGradient(w, h, angle, start, end);
}

/* A gradient with no vehicle input at all -- used when we have neither a
 * color name nor a cutout to measure. Both stops stay dark-to-midtone;
 * these sit behind cutouts that are overwhelmingly white/silver/grey, so
 * a light backdrop would flatten the vehicle against it. */
export function genericGradient(w, h, seed) {
  const rand = mulberry32(hashSeed(String(seed)));
  const [lo, hi] = GRADIENT_HUE_BANDS[Math.floor(rand() * GRADIENT_HUE_BANDS.length)];
  const h1 = lo + rand() * (hi - lo);
  const h2 = h1 + (rand() * 0.12 - 0.06);
  let dark = hsvToRgb(h1, 0.35 + rand() * 0.37, 0.10 + rand() * 0.12);
  let light = hsvToRgb(h2, 0.40 + rand() * 0.40, 0.45 + rand() * 0.27);
  if (rand() < 0.5) [dark, light] = [light, dark];
  return makeLinearGradient(w, h, rand() * 360, dark, light);
}

const luminance = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;

/* How hard to dim the background so the car reads as brighter, computed
 * from measured contrast rather than a fixed constant -- a silver car on
 * an already-dark background needs no help; a gray car on a bright gray
 * background needs a lot.
 *
 * `bgRegion` is the patch that will sit directly behind the car, not the
 * whole canvas: that is the contrast that actually decides whether the
 * vehicle separates from what is around it. */
export function computeDimStrength(bgRegionData, carData, margin = 35, minDim = 0.35) {
  let carSum = 0, alphaSum = 0;
  for (let i = 0; i < carData.data.length; i += 4) {
    const a = carData.data[i + 3] / 255;
    if (a > 0) {
      carSum += luminance(carData.data[i], carData.data[i + 1], carData.data[i + 2]) * a;
      alphaSum += a;
    }
  }
  if (alphaSum < 1) return 1.0;
  const carLum = carSum / alphaSum;

  let bgSum = 0, n = 0;
  for (let i = 0; i < bgRegionData.data.length; i += 4) {
    bgSum += luminance(bgRegionData.data[i], bgRegionData.data[i + 1], bgRegionData.data[i + 2]);
    n++;
  }
  const bgLum = bgSum / Math.max(1, n);

  const target = carLum - margin;
  if (bgLum <= target || bgLum <= 0) return 1.0;
  return Math.min(1.0, Math.max(minDim, target > 0 ? target / bgLum : minDim));
}

/* Radial spotlight dim: full brightness within innerFrac of `center`,
 * fading to `dim` by outerFrac, flat beyond.
 *
 * Reads as light falling on the car rather than a flat filter over the
 * frame -- the car pops because the ground around it visibly darkens.
 * Radii are fractions of the distance from `center` to the farthest
 * corner, not of width/height, which measure the wrong thing when the
 * center is off-canvas-center. */
export function applySpotlight(canvas, cx, cy, dim, innerFrac = 0.28, outerFrac = 0.85) {
  if (dim >= 1.0) return canvas;

  const w = canvas.width, h = canvas.height;
  const ctx = ctxOf(canvas, { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);

  let maxDist = 0;
  for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const d = Math.hypot(cx - px, cy - py);
    if (d > maxDist) maxDist = d;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.hypot(x - cx, y - cy) / maxDist;
      let t = (dist - innerFrac) / (outerFrac - innerFrac);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const smooth = t * t * (3 - 2 * t);      // smoothstep, no hard ring
      const f = 1.0 - smooth * (1.0 - dim);
      const i = (y * w + x) * 4;
      img.data[i] *= f; img.data[i + 1] *= f; img.data[i + 2] *= f;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* Scale `car` to fit `box` minus a margin, centred horizontally.
 * Split out from drawing so the placement is known before the dim and
 * spotlight passes, which need to know where the car will sit. */
export function computePlacement(car, box, marginFrac = 0.06, anchor = 'center') {
  const [bl, bt, br, bb] = box;
  const availW = (br - bl) * (1 - 2 * marginFrac);
  const availH = (bb - bt) * (1 - 2 * marginFrac);
  const scale = Math.min(availW / car.width, availH / car.height);
  const w = Math.max(1, Math.round(car.width * scale));
  const h = Math.max(1, Math.round(car.height * scale));
  const x = bl + Math.floor((br - bl - w) / 2);
  const y = anchor === 'bottom'
    ? bb - Math.round((bb - bt) * marginFrac) - h
    : bt + Math.floor((bb - bt - h) / 2);
  return { x, y, w, h };
}

/* Compose one hero image. `cutout` is a cropped RGBA canvas. */
export function composeHero(cutout, {
  width = CANVAS,
  height = CANVAS,
  seed = 'lotstretcher',
  exterior = null,
  interior = null,
  background = null,          // a canvas/bitmap to use instead of a gradient
  spotlight = true,
  marginFrac = 0.06,
  generic = false,
} = {}) {
  const canvas = makeCanvas(width, height);
  const ctx = ctxOf(canvas, { willReadFrequently: true });

  // The cutout's own pixels are what the palette measures when the
  // vehicle's color name is missing or is pure branding.
  const cutCtx = ctxOf(cutout, { willReadFrequently: true });
  const cutData = cutCtx.getImageData(0, 0, cutout.width, cutout.height);

  let bg;
  if (background) bg = coverFit(background, width, height);
  else if (generic) bg = genericGradient(width, height, seed);
  else bg = vehicleGradient(width, height, seed, exterior, interior, cutData);
  ctx.drawImage(bg, 0, 0);

  const place = computePlacement(cutout, [0, 0, width, height], marginFrac, 'center');

  if (spotlight) {
    const region = ctx.getImageData(place.x, place.y, place.w, place.h);
    // Measure the car at its PLACED size so the two luminances are
    // comparable; measuring the full-res cutout against a small
    // background patch compares different things.
    const scaled = makeCanvas(place.w, place.h);
    ctxOf(scaled).drawImage(cutout, 0, 0, place.w, place.h);
    const scaledData = ctxOf(scaled, { willReadFrequently: true })
      .getImageData(0, 0, place.w, place.h);

    const dim = computeDimStrength(region, scaledData);
    applySpotlight(canvas, place.x + place.w / 2, place.y + place.h / 2, dim);
  }

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cutout, place.x, place.y, place.w, place.h);
  return canvas;
}
