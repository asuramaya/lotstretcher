/* What the run asks the core about its shots (core/src/select.rs), and
 * the crop the classifiers see: the same choices the CLI's photos.py and
 * imaging/select.py make. */

import { call as coreCall } from '../core.js';
import { makeCanvas, ctxOf } from '../lib/imageio.js';

/* `source` with `top` and `bottom` rows cut off, or `source` itself when
 * there is nothing to cut. */
export function cropRows(source, top, bottom) {
  const h = source.height - top - bottom;
  if ((!top && !bottom) || h < 1) return source;
  const c = makeCanvas(source.width, h);
  ctxOf(c).drawImage(source, 0, top, source.width, h, 0, 0, source.width, h);
  return c;
}

/* A cutout's same-shot signature, from the core (select.rs::
 * shot_signature, the one the CLI's photos.py checks): a difference hash
 * of the cut-out car over mid grey, and its aspect. Kept on the canvas,
 * since every later shot is checked against it. */
function cutoutSignature(canvas) {
  if (!canvas) return null;
  if (!canvas.signature) {
    const pixels = ctxOf(canvas, { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    canvas.signature = coreCall({ op: 'shot_signature', image: { $image: 0 } }, [pixels]);
  }
  return canvas.signature;
}
/* The earlier photo this cutout repeats (a re-save, a resized copy), by
 * the spec's select.sameShot bounds, or null. */
export function sameShotAs(canvas, earlier) {
  const signature = cutoutSignature(canvas);
  const kept = earlier.filter((q) => q.cutout);
  if (!signature || !kept.length) return null;
  const i = coreCall({ op: 'same_shot', signature, earlier: kept.map((q) => cutoutSignature(q.cutout)) });
  return i === null ? null : kept[i];
}

/* The run's shots in the CLI's order, decided by the core
 * (core/src/select.rs, the code imaging/select.py calls): the lead,
 * which is the bundle's hero.png and the post's cover, is the most
 * confident shot of the first angle in the spec's heroPriority; the rest
 * walk round the car front to rear, each angle's most confident first;
 * angles the order does not know come last. */
const shotsOf = (photos) => photos.map((p, i) => ({ name: String(i), angle: p.angle || '', confidence: p.angleConf || 0 }));
export function walkaround(photos) {
  return coreCall({ op: 'select_shots', mode: 'walkaround', shots: shotsOf(photos) }).shots.map((s) => photos[Number(s.name)]);
}

/* The clip's order, as the CLI's vehicle_pipeline picks it (core
 * select.rs): every shot by walkaround, reseated so the first frame is
 * the conveyor still and the last hands back to it. */
export function clipOrder(photos) {
  const shots = shotsOf(photos);
  const pairs = coreCall({ op: 'select_shots', mode: 'carousel_all', shots }).shots.map((s) => ({ name: s.name, angle: s.angle }));
  return coreCall({ op: 'select_shots', mode: 'conveyor_start', shots, pairs }).shots.map((s) => photos[Number(s.name)]);
}
