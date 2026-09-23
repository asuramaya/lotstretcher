/* Text on the still: the browser side of core/src/text.rs, the twin of
 * imaging/text.py. The core rasterises and places the words; this
 * module fetches the studio font once and turns the Text controls plus
 * the vehicle record into the overlay plan for one canvas size. */

import * as core from '../core.js';
import { library } from './library.js';

export const DEFAULT_FONT = 'Lato Bold';
const loaded = new Set();
const loading = new Map();
const bytes = new Map();     // name -> Uint8Array, for a worker's own core

/* Fetch and load a studio font once. Resolves to the name, or throws
 * when the studio has no such font. */
export async function ensureFont(name = DEFAULT_FONT) {
  if (loaded.has(name)) return name;
  if (loading.has(name)) return loading.get(name);
  const p = (async () => {
    const entry = (library().fonts || []).find((f) => f.name === name);
    if (!entry) throw new Error(`the studio has no font named ${name}`);
    const r = await fetch(entry.src);
    if (!r.ok) throw new Error(`${r.status} loading ${entry.src}`);
    const data = new Uint8Array(await r.arrayBuffer());
    core.loadFont(name, data);
    bytes.set(name, data);
    loaded.add(name);
    return name;
  })();
  loading.set(name, p);
  try { return await p; } finally { loading.delete(name); }
}

export function fontReady(name = DEFAULT_FONT) { return loaded.has(name); }

/* The loaded fonts' bytes, by name: what a worker with its own core
 * needs to draw the same text. */
export function loadedFonts() { return Object.fromEntries(bytes); }

/* The Text controls (app keys) as the core's plan fields; the same
 * mapping as imaging/text.py::text_options. */
export function textOptions(o) {
  return {
    title: o.titleMode || 'none',
    custom_title: o.titleText || null,
    price_badge: !!o.priceBadge,
    line: o.textLine || null,
    position: o.textPosition || 'bl',
    color: o.textColor || 'white',
    size: o.textSize != null ? Number(o.textSize) : 0.05,
  };
}

export function wantsText(text) {
  return text.title !== 'none' || !!text.price_badge || !!text.line;
}

/* The Text controls and the vehicle as one compose field, with the font
 * loaded, or null when no text is asked for (so a run without text
 * never fetches the font). The core plans the words inside the frame's
 * window itself. */
export async function textRequest(vehicle, text) {
  if (!wantsText(text)) return null;
  const font = await ensureFont(text.font || DEFAULT_FONT);
  return { ...text, font, vehicle: vehicle || {} };
}

/* The same without waiting: null until the font has landed, and
 * `onReady` fires once it has so a preview can redraw. */
export function textRequestNow(vehicle, text, onReady) {
  if (!wantsText(text)) return null;
  const font = text.font || DEFAULT_FONT;
  if (!fontReady(font)) {
    ensureFont(font).then(() => onReady?.()).catch((e) => console.warn('studio font', e));
    return null;
  }
  return { ...text, font, vehicle: vehicle || {} };
}

/* Overlays for one canvas, or [] when no text is asked for, so a run
 * without text never fetches the font. */
export async function planOverlays(width, height, vehicle, text) {
  if (!wantsText(text)) return [];
  const font = await ensureFont(text.font || DEFAULT_FONT);
  return core.overlayPlan(width, height, vehicle, { ...text, font });
}

/* The same, without waiting: [] until the font has landed, and
 * `onReady` fires once it has so a preview can redraw. */
export function planOverlaysNow(width, height, vehicle, text, onReady) {
  if (!wantsText(text)) return [];
  const font = text.font || DEFAULT_FONT;
  if (!fontReady(font)) {
    ensureFont(font).then(() => onReady?.()).catch((e) => console.warn('studio font', e));
    return [];
  }
  return core.overlayPlan(width, height, vehicle, { ...text, font });
}
