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
    font: o.textFont || DEFAULT_FONT,
    badge_size: o.badgeSize != null ? Number(o.badgeSize) : 0.85,
    title_style: pieceStyle(o, 'title'),
    badge_style: pieceStyle(o, 'badge'),
    subtitle_style: pieceStyle(o, 'subtitle'),
    title: o.titleMode || 'none',
    custom_title: o.titleText || null,
    price_badge: !!o.priceBadge,
    subtitle: o.subtitle || null,
    position: o.textPosition || 'bl',
    color: o.textColor || 'white',
    size: o.textSize != null ? Number(o.textSize) : 0.05,
    case: o.textCase || 'as-is',
    boxed: !!o.textBoxed,
    shadow: o.textShadow == null ? true : !!o.textShadow,
    subtitle_size: o.subtitleSize != null ? Number(o.subtitleSize) : 0.62,
  };
}

export const PIECES = ['title', 'subtitle', 'badge'];
const PIECE_LEVERS = ['font', 'position', 'color', 'case', 'box'];

/* One piece's own levers (titleFont, titlePosition, ...) as the core's
 * PieceStyle: only what departs from the shared lever; "same", "" and
 * null all mean the shared one. The twin of imaging/text.py::piece_style. */
export function pieceStyle(o, piece) {
  const out = {};
  for (const lever of PIECE_LEVERS) {
    const v = o[`${piece}${lever[0].toUpperCase()}${lever.slice(1)}`];
    if (v == null || v === '' || v === 'same') continue;
    if (lever === 'box') out.boxed = v === 'on' || v === true;
    else out[lever] = v;
  }
  return out;
}

/* Every font the plan draws with: the shared one and each piece's own. */
export function fontsIn(text) {
  const names = [text.font || DEFAULT_FONT];
  for (const p of PIECES) {
    const own = text[`${p}_style`]?.font;
    if (own && !names.includes(own)) names.push(own);
  }
  return names;
}

async function ensureFonts(text) {
  await Promise.all(fontsIn(text).map((n) => ensureFont(n)));
  return text.font || DEFAULT_FONT;
}

function fontsReady(text, onReady) {
  const missing = fontsIn(text).filter((n) => !fontReady(n));
  if (!missing.length) return true;
  Promise.all(missing.map((n) => ensureFont(n))).then(() => onReady?.()).catch((e) => console.warn('studio font', e));
  return false;
}

/* The app's frame controls as the core's border_style, or null: the
 * same mapping as imaging/text.py::frame_style. */
export function frameStyle(o) {
  if (o.border !== 'line') return null;
  const num = (k, d) => (o[k] != null ? Number(o[k]) : d);
  return { kind: 'line', color: o.frameColor || 'white', weight: num('frameWeight', 0.008), inset: num('frameInset', 0.035), radius: num('frameRadius', 0.02) };
}

/* The app's spotlight controls as what the core takes: false when off,
 * true when on with the measured dim, else {strength, spread} with the
 * levers set. The twin of imaging/text.py::spotlight_style. */
export function spotlightStyle(o) {
  if (o.spotlight === false) return false;
  const out = {};
  if (o.spotStrength != null && o.spotStrength !== '') out.strength = Number(o.spotStrength);
  if (o.spotSpread != null && o.spotSpread !== '') out.spread = Number(o.spotSpread);
  return Object.keys(out).length ? out : true;
}

/* The app's shadow controls as the core's `shadow` field, or null: the
 * same mapping as imaging/text.py::shadow_style. */
export function shadowStyle(o) {
  if (!o.shadow) return null;
  return { strength: o.shadowStrength != null ? Number(o.shadowStrength) : 0.5 };
}

/* The app's reflection controls as the core's `reflection` field, or
 * null: the same mapping as imaging/text.py::reflection_style. */
export function reflectionStyle(o) {
  if (!o.reflection) return null;
  return { strength: o.reflectionStrength != null ? Number(o.reflectionStrength) : 0.35 };
}

export function wantsText(text) {
  return text.title !== 'none' || !!text.price_badge || !!text.subtitle;
}

/* The Text controls and the vehicle as one compose field, with the font
 * loaded, or null when no text is asked for (so a run without text
 * never fetches the font). The core plans the words inside the frame's
 * window itself. */
export async function textRequest(vehicle, text) {
  if (!wantsText(text)) return null;
  const font = await ensureFonts(text);
  return { ...text, font, vehicle: vehicle || {} };
}

/* The same without waiting: null until the font has landed, and
 * `onReady` fires once it has so a preview can redraw. */
export function textRequestNow(vehicle, text, onReady) {
  if (!wantsText(text)) return null;
  if (!fontsReady(text, onReady)) return null;
  return { ...text, font: text.font || DEFAULT_FONT, vehicle: vehicle || {} };
}

/* Overlays for one canvas, or [] when no text is asked for, so a run
 * without text never fetches the font. */
export async function planOverlays(width, height, vehicle, text) {
  if (!wantsText(text)) return [];
  const font = await ensureFonts(text);
  return core.overlayPlan(width, height, vehicle, { ...text, font });
}

/* The same, without waiting: [] until the font has landed, and
 * `onReady` fires once it has so a preview can redraw. */
export function planOverlaysNow(width, height, vehicle, text, onReady) {
  if (!wantsText(text)) return [];
  if (!fontsReady(text, onReady)) return [];
  return core.overlayPlan(width, height, vehicle, { ...text, font: text.font || DEFAULT_FONT });
}
