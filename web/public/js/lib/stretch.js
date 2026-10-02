/* Stretch: the lot, stretched. An easter egg with no use at all. The
 * cutout's nose and tail stay as they are and the middle is pulled out
 * like a limousine's, then the still is composed again with the run's
 * own look, so the backdrop, title and price are all still right. */

import { makeCanvas, ctxOf } from './imageio.js';

/* Each press of the button goes one further; past the last it snaps back. */
export const STRETCHES = [1, 1.5, 2.25, 3.4, 5];

/* How much of each end is left alone: the wheels and the lights. */
const END = 0.32;

export function stretchCutout(cutout, k) {
  const w = cutout.width, h = cutout.height;
  const end = Math.round(w * END);
  const mid = w - 2 * end;
  const long = Math.round(mid * k);
  const out = makeCanvas(2 * end + long, h);
  const ctx = ctxOf(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cutout, 0, 0, end, h, 0, 0, end, h);
  ctx.drawImage(cutout, end, 0, mid, h, end, 0, long, h);
  ctx.drawImage(cutout, end + mid, 0, end, h, end + long, 0, end, h);
  return out;
}

/* What the button says next. */
export function stretchLabel(i) {
  if (i === 0) return 'Stretch';
  return i === STRETCHES.length - 1 ? 'Unstretch' : 'Stretch more';
}
