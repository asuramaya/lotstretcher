/* Window sticker parsing, in the browser.
 *
 * The CLI shells out to poppler (`pdftotext -bbox`) for this. A browser
 * cannot, so pdf.js supplies the same thing: text items with positions.
 * The parsing itself is the core's (core/src/sticker.rs), the same code
 * the CLI's words go through, and so is reading the record as the
 * vehicle's fields (sticker_fields.rs); this module only produces the
 * words.
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
  // The flat facts (year, model, the engine as a person writes it, the
  // total as msrp) are the core's (sticker_fields.rs), as the CLI's are.
  // The sticker's total is what the car cost NEW, so it is kept as msrp
  // and the form decides (stickerPriceApplies) whether it is the price.
  return { ...rec, raw: { wordCount: ws.length }, ...call({ op: 'sticker_fields', record: rec }).fields };
}

/* Map a parsed sticker onto the app's vehicle fields.
 * Only fills what the sticker actually knows, so it never blanks a value
 * the user typed. */
export function stickerToVehicle(sticker) {
  return call({ op: 'sticker_fields', record: sticker }).vehicle;
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
