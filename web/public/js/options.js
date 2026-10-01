/* Processing options: every Studio control's value, keyed as in
 * shared/pipeline-spec.json's controls block (which names each one's
 * CLI flag), plus the shapes to make and the cut type. Defaults are the
 * spec's, so the browser and a bare CLI command start from the same. */

import { get, formats as specFormats } from './spec.js';

/* The shapes, from the spec (src/lotstretcher/spec.py reads the same). */
export let HERO_FORMATS = {};
export let VIDEO_FORMATS = {};

/* Called once after loadSpec(). Everything above is empty until then,
 * so nothing can read a stale default by accident. */
export function initFromSpec() {
  HERO_FORMATS = Object.fromEntries(
    Object.entries(specFormats('heroStillFormats'))
      .map(([k, f]) => [k, { size: f.size, label: f.label, note: f.note }]));
  VIDEO_FORMATS = Object.fromEntries(
    Object.entries(specFormats('videoFormats'))
      .map(([k, f]) => [k, { size: f.size, label: f.label, note: f.note, budgetMb: f.budgetMb }]));
  for (const group of get('controls', 'groups')) {
    for (const control of group.controls) DEFAULTS[control.key] = control.default;
  }
  DEFAULTS.heroFormats = [...(get('heroStillFormats', 'browserDefault') || [get('heroStillFormats', 'default')])];
  /* A clip only where the browser can encode one in hardware. */
  const clip = get('videoFormats', 'browserDefault') || [];
  DEFAULTS.videoFormats = (typeof VideoEncoder !== 'undefined') ? [...clip] : [];
}

/* Filled from the spec by initFromSpec; cutType 'none' is the server's
 * classify-only mode (sort the photos, compose nothing). */
export const DEFAULTS = { heroFormats: ['square'], videoFormats: [], cutType: 'complete' };

const KEY = 'lotstretcher.options';

/* Options persist per device.
 *
 * This is settings, not content: it holds no photo and nothing derived
 * from one, so it is exactly the per-viewer convenience browser storage
 * is for. Every access is wrapped because storage throws in a private
 * window and comes back empty after a site-data clear. */
export function loadOptions() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    // A stored blob with no still format would produce nothing; the run
    // used to paper over it with a silent fallback to square.
    if (!saved.heroFormats?.length) saved.heroFormats = [...DEFAULTS.heroFormats];
    // Merge over defaults so a new option added later does not arrive
    // undefined for anyone who already has a saved blob.
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

/* The options without the images in them: what goes into the JSON
 * blob, and what a server receives. The user's own background and frame
 * are canvases held by the app and remembered in IndexedDB. */
export function serialisable(options) {
  const out = {};
  for (const [k, v] of Object.entries(options || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
}

export function saveOptions(options) {
  try { localStorage.setItem(KEY, JSON.stringify(serialisable(options))); } catch { /* ignore */ }
}

export function resetOptions() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return { ...DEFAULTS };
}
