/* Scene and angle classification.
 *
 * Both are MobileNetV3-small students distilled from the CLIP zero-shot
 * classifiers in imaging/classify.py, at 1/58th the size of CLIP's
 * visual tower. The teacher labels came free: they were already on disk
 * from production runs.
 *
 * Class index order is NOT arbitrary and NOT recoverable from the model
 * file -- it is baked into the trained head. It lives in models/labels.json,
 * which is generated alongside the export. Getting it wrong yields a
 * confident, completely wrong answer with no error. */

import { loadModel, getOrt } from './runtime.js';
import { resizeTo, imageDataOf, toTensorNCHW, softmax } from '../lib/imageio.js';

let labels = null;

export async function loadLabels() {
  if (labels) return labels;
  const res = await fetch('models/labels.json');
  if (!res.ok) throw new Error('models/labels.json missing -- class order is unrecoverable without it');
  labels = await res.json();
  return labels;
}

async function run(key, bitmap, onProgress) {
  const { session, spec, inputName } = await loadModel(key, onProgress);
  const ort = getOrt();
  const size = spec.size;

  const data = toTensorNCHW(imageDataOf(resizeTo(bitmap, size, size)), size);
  const out = await session.run({ [inputName]: new ort.Tensor('float32', data, [1, 3, size, size]) });
  const logits = out[session.outputNames[0]].data;

  const probs = softmax(logits);
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;

  const names = (await loadLabels())[key];
  if (!names || names.length !== probs.length) {
    throw new Error(`label/logit mismatch for ${key}: ${names?.length} labels, ${probs.length} logits`);
  }

  return {
    label: names[best],
    confidence: probs[best],
    scores: Object.fromEntries(names.map((n, i) => [n, probs[i]])),
  };
}

/* Which of {interior, exterior, detail, marketing} this photo is.
 * Runs on EVERY photo, so it is the hot path -- ~29 of a typical 37. */
export const classifyScene = (bitmap, onProgress) => run('scene', bitmap, onProgress);

/* Which of {front, front_3q, side, rear_3q, rear} the vehicle faces.
 * Runs only on exterior shots, and on the CUTOUT rather than the photo:
 * the background is noise for this question, and the students were
 * distilled on cutouts.
 *
 * No horizontal-flip augmentation was used in training, deliberately --
 * flipping turns front_3q into its mirror and scrambles the left/right
 * semantics the label encodes. Do not flip inputs here either. */
export const classifyAngle = (bitmap, onProgress) => run('angle', bitmap, onProgress);
