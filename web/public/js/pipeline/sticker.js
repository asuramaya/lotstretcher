/* Window sticker parsing, in the browser.
 *
 * The CLI shells out to poppler (`pdftotext -bbox`) for this. A browser
 * cannot, so pdf.js supplies the same thing: text items with positions.
 * The parsing itself is the core's (core/src/sticker.rs), the same code
 * the CLI's words go through; this module only produces the words and
 * maps the record onto the form.
 *
 * pdf.js is loaded LAZILY, only when someone actually imports a sticker,
 * so the 1.7MB never costs anything to the common path.
 *
 * Coordinates: pdf.js reports PDF user space, where y increases UPWARD
 * from the bottom-left, and the core works top-down in the same points,
 * so y is flipped on ingest. pdf.js's y is a baseline where pdftotext's
 * is a box top; every rule in the parser is relative, so that offset
 * does not matter, but the rows need a looser tolerance (spec
 * sticker.rowToleranceBrowser). */

/* Relative to THIS module (js/pipeline/), so two levels up to the root.
 * One level lands on js/vendor/, which does not exist. */
const PDFJS_URL = '../../vendor/pdfjs/pdf.min.mjs';
const WORKER_URL = 'vendor/pdfjs/pdf.worker.min.mjs';

let pdfjs = null;

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(WORKER_URL, document.baseURI).href;
  return pdfjs;
}

import { call, loadCore } from '../core.js';
import { get as specGet } from '../spec.js';

/* Trim levels, drivetrains and the like are ACRONYMS, not words. Plain
 * title case turns "XLT FWD" into "Xlt Fwd", which then goes straight
 * into a post and reads as a typo to anyone who knows the car. */
const ACRONYMS = new Set([
  'XL', 'XLT', 'SE', 'SEL', 'LT', 'LS', 'LTZ', 'RST', 'ST', 'GT', 'SS', 'SR', 'SR5',
  'EX', 'LX', 'DX', 'SV', 'SL', 'S', 'RS', 'GLS', 'GLE', 'TRD', 'ZR2', 'Z71', 'SLE',
  'SLT', 'XSE', 'XLE', 'FWD', 'AWD', 'RWD', '4WD', '2WD', '4X4', '4X2',
  'V6', 'V8', 'V10', 'TDI', 'GTI', 'ABS', 'LED', 'USB', 'AM/FM', 'MSRP', 'VIN',
  'MPG', 'EPA', 'SYNC', 'AC', 'A/C', 'PHEV', 'EV', 'SUV',
]);

/* Abbreviations the sticker prints that read badly in a post. Kept
 * narrow and only applied to display strings, never to the parsed value
 * the CLI would also produce, so the two stay comparable. */
const EXPANSIONS = [
  [/\bSiriusxm\b/i, 'SiriusXM'],
  [/\bEcoboost\b/i, 'EcoBoost'],
  [/\bAlum\b/i, 'Aluminum'],
  [/\bIncl\b/i, 'Included'],
  [/\bConn\b/i, 'Connected'],
  [/\bTri\s*-?\s*Coat\b/i, 'Tri-Coat'],
  [/\bTc\b/i, 'Tri-Coat'],
  [/\bMet\b/i, 'Metallic'],
  [/\bMetalic\b/i, 'Metallic'],
  [/\bPkg\b/i, 'Package'],
  [/\bW\//i, 'With '],
];

function titleCase(s) {
  return s.toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    // A letter straight after a digit is a unit, not a new word: engine
    // displacements must read "2.0L EcoBoost", never "2.0l".
    .replace(/(\d)([a-z])\b/g, (_, d, c) => d + c.toUpperCase())
    // Restore anything that is an acronym rather than a word.
    .replace(/\b[A-Za-z][A-Za-z0-9/]*\b/g, (w) => (
      ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w
    ));
}

/* Title case, then expand the sticker's own abbreviations. For values
 * shown to a person or dropped into post copy. */
function displayCase(s) {
  let out = titleCase(s);
  for (const [re, to] of EXPANSIONS) out = out.replace(re, to);
  return out;
}

/* Page 1's text as positioned words, top-down, in the core's shape. */
async function words(source) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument(
    typeof source === 'string' ? { url: source } : { data: source },
  ).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  /* pdf.js hands back whole text RUNS, not words: "BASE PRICE" arrives as
   * a single item. The CLI's pdftotext -bbox gives one word per box, and
   * every label rule in the core matches word by word, so a run-shaped
   * token never equals "BASE". Split runs into words and estimate each
   * word's x by its share of the run, which puts the browser and the CLI
   * on the same data shape. Proportional-by-character is approximate for
   * a proportional font, but only needs to be good enough to order words
   * and to tell columns apart. */
  const out = [];
  for (const item of content.items) {
    const raw = (item.str || '');
    if (!raw.trim()) continue;
    const y = viewport.height - item.transform[5];   // flip to top-down
    const x0 = item.transform[4];
    const total = item.width || 0;
    const h = item.height || 0;
    const perChar = raw.length ? total / raw.length : 0;

    let at = 0;
    for (const token of raw.split(/(\s+)/)) {
      if (token.trim()) {
        const x = x0 + at * perChar;
        out.push({ text: token, x0: x, y0: y, x1: x + token.length * perChar, y1: y + h });
      }
      at += token.length;
    }
  }
  return { words: out, width: viewport.width, height: viewport.height, pages: doc.numPages };
}

/* Parse a Ford-template window sticker.
 *
 * `source` is a URL string or an ArrayBuffer. The record is the core's,
 * the same one the CLI writes to window-sticker.json, plus the flat
 * fields the form reads. Every field is optional: a sticker that parses
 * only half way is still worth more than typing it all by hand, so
 * nothing here throws on a missing field. */
export async function parseSticker(source) {
  await loadCore();
  const { words: ws } = await words(source);
  const rec = call({ op: 'parse_sticker', words: ws, y_tol: specGet('sticker').rowToleranceBrowser });
  const out = { ...rec, raw: { wordCount: ws.length } };
  const o = rec.overview || {};
  if (o.vin) out.vin = o.vin;
  if (rec.placeholder) return out;

  if (o.model_line) { out.model_line = o.model_line; out.model = o.model_name || o.model_line; }
  if (o.trim_drivetrain) out.trim_drivetrain = o.trim_drivetrain;
  if (o.seating_capacity) out.seating = o.seating_capacity;
  if (o.engine) out.engine = displayCase(o.engine);
  if (o.transmission) out.transmission = displayCase(o.transmission);
  if (o.exterior_color) out.exterior_color = o.exterior_color;
  if (o.interior_trim) out.interior_color = o.interior_trim;
  if (o.trim) out.trim = o.trim;
  if (o.body_style) out.body_style = o.body_style;
  if (o.drivetrain) out.drivetrain = o.drivetrain;
  /* The sticker's total is what the car cost NEW. It is only the asking
   * price of a new car, so it is kept as msrp and the form decides
   * (stickerPriceApplies) whether it may become the price. */
  out.msrp = rec.pricing.total_msrp || rec.pricing.base_price || null;
  if (out.trim_drivetrain) {
    const first = out.trim_drivetrain.split(/\s+/)[0];
    if (/^\d{4}$/.test(first)) out.year = first;
  }
  return out;
}

/* Map a parsed sticker onto the app's vehicle fields.
 * Only fills what the sticker actually knows, so it never blanks a value
 * the user typed. */
export function stickerToVehicle(sticker) {
  const v = {};
  for (const [from, to] of [
    ['year', 'year'], ['make', 'make'], ['model', 'model'], ['trim', 'trim'],
    ['exterior_color', 'exterior_color'], ['interior_color', 'interior_color'],
    ['vin', 'vin'], ['msrp', 'msrp'],
  ]) {
    if (!sticker[from]) continue;
    let value = String(sticker[from]);
    // Colours reach the form AND the post copy, so expand the sticker's
    // abbreviations once here rather than letting the two disagree.
    if (from.endsWith('_color')) value = displayCase(value);
    else value = value.replace(/^\$/, '').replace(/,/g, '');
    v[to] = value;
  }
  if (v.msrp) v.msrp = v.msrp.replace(/\.00$/, '');
  return v;
}

/* Whether a sticker's MSRP may stand as the asking price: only for a car
 * sold new. Stated condition decides; with none stated, a sticker for
 * this model year or next is taken as a new car, anything older as used
 * (a 2021 sticker on a lot in 2026 is five years of depreciation off). */
export function stickerPriceApplies(condition, year, now = new Date()) {
  const c = String(condition || '').toLowerCase();
  if (c) return c === 'new';
  const y = Number(year);
  return Number.isFinite(y) && y >= now.getFullYear();
}

export { loadPdfjs };
