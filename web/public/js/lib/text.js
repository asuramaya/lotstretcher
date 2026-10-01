/* Text on the still: the browser side of core/src/text.rs, as
 * imaging/text.py is the CLI's. The core rasterises and places the words; this
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

/* The Studio's control values as every field the core's requests take
 * (text, border_style, spotlight, shadow, reflection, backdrop), decided
 * by the core (core/src/controls.rs), the same mapping the CLI's
 * imaging/text.py asks it for. */
export function styles(o) {
  const plain = {};
  for (const [k, v] of Object.entries(o || {})) if (v === null || typeof v !== 'object' || Array.isArray(v)) plain[k] = v;
  return core.call({ op: 'styles', options: plain });
}

/* The Text controls (app keys) as the core's plan fields. */
export function textOptions(o) { return styles(o).text; }

export const PIECES = ['title', 'subtitle', 'badge'];

/* One piece's own levers (titleFont, titlePosition, ...) as the core's
 * PieceStyle: only what departs from the shared lever. */
export function pieceStyle(o, piece) { return styles(o).text[`${piece}_style`]; }

const facts = (text) => core.call({ op: 'text_facts', text });

/* Every font the plan draws with: the shared one and each piece's own. */
export function fontsIn(text) { return facts(text).fonts; }

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

/* The drawn frame, spotlight, shadow and reflection fields (see styles). */
export function frameStyle(o) { return styles(o).border_style; }
export function spotlightStyle(o) { return styles(o).spotlight; }
export function shadowStyle(o) { return styles(o).shadow; }
export function reflectionStyle(o) { return styles(o).reflection; }

export function wantsText(text) { return facts(text).wants_text; }

/* A lever's number, or null for the spec's default. */
export const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/* The Studio's values as the compositor's options, for a still and for
 * a clip: one mapping for the run, the preview and the look tiles, the
 * backdrop's through the core's (controls.rs: colours only for the
 * coloured kinds, an angle only for the linear ones). The caller adds
 * the size, seed, colours, pictures and text. */
export function stillOptions(o) {
  const s = styles(o);
  const b = s.backdrop;
  return {
    backdrop: b.kind, generic: b.kind === 'generic', backdropColor: b.color, backdropColor2: b.color2, backdropAngle: b.angle,
    spotlight: s.spotlight, marginFrac: numOrNull(o.margin),
    glow: !!o.glow, glowColor: o.glowColor, glowRadius: numOrNull(o.glowRadius), glowIntensity: numOrNull(o.glowIntensity),
    borderFit: o.frameFit, borderStyle: s.border_style, shadow: s.shadow, reflection: s.reflection,
  };
}
export function clipOptions(o) {
  const { borderStyle, borderFit, marginFrac, ...rest } = stillOptions(o);
  return { ...rest, frameStyle: borderStyle, push: numOrNull(o.videoPush), crossfade: numOrNull(o.videoCrossfade), fps: numOrNull(o.videoFps) ?? undefined };
}

/* A stock frame's name, when the Frame picker names one (not none, your
 * own, or the drawn line). */
export function stockFrame(o) { return o.border && !['none', 'custom', 'line'].includes(o.border) ? o.border : null; }

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
