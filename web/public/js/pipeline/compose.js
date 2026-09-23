/* Hero composition: a thin host over the Rust core (../core.js).
 *
 * This file used to carry its own gradient, palette, spotlight and
 * placement code, a port of the Python that drifted from it in small
 * ways (a different seeded generator, for one). All of that is in the
 * core now, and this function only packs canvases into bytes and
 * unpacks the result. The same request produces the same bytes on the
 * server. */

import { CANVAS } from '../config.js';
import { makeCanvas, ctxOf, coverFit } from '../lib/imageio.js';
import * as core from '../core.js';

/* Compose one hero image. `cutout` is a cropped RGBA canvas. */
export function composeHero(cutout, {
  width = CANVAS,
  height = CANVAS,
  seed = 'lotstretcher',
  exterior = null,
  interior = null,
  background = null,          // a canvas/bitmap to use instead of a gradient
  spotlight = true,
  marginFrac = null,
  generic = false,
  glow = false,
  glowColor = null,
  glowRadius = null,
  glowIntensity = null,
  border = null,              // an RGBA canvas/ImageData of a frame, fitted to the format
  borderFit = null,           // fit | fill | stretch; the core's default is fit
  overlays = [],              // ready-placed text, painted last
  text = null,                // the Text controls + vehicle (lib/text.js::textRequest); planned in the window
  borderStyle = null,         // a frame the core draws to fit (lib/text.js::frameStyle), when no border image
} = {}) {
  const cutData = ctxOf(cutout, { willReadFrequently: true }).getImageData(0, 0, cutout.width, cutout.height);
  let borderData = null;
  if (border) {
    borderData = border instanceof ImageData ? border
      : ctxOf(border, { willReadFrequently: true }).getImageData(0, 0, border.width, border.height);
  }
  let bg;
  let backgroundImage = null;
  if (background) {
    const fitted = coverFit(background, width, height);
    backgroundImage = ctxOf(fitted, { willReadFrequently: true }).getImageData(0, 0, width, height);
    bg = { kind: 'image' };
  } else if (generic) {
    bg = { kind: 'generic', seed: String(seed) };
  } else {
    bg = { kind: 'vehicle', seed: String(seed), exterior: exterior || null, interior: interior || null };
  }
  const out = core.composeHero([cutData], width, height, bg, {
    layout: 'single', spotlight, glow, glowColor, glowRadius, glowIntensity, marginFrac, backgroundImage,
    border: borderData, borderFit, overlays, text, borderStyle,
  });
  const canvas = makeCanvas(width, height);
  ctxOf(canvas).putImageData(out, 0, 0);
  return canvas;
}
