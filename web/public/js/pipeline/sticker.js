/* Window sticker parsing, in the browser.
 *
 * The CLI shells out to poppler (`pdftotext -bbox`) for this. A browser
 * cannot, so pdf.js supplies the same thing: text items with positions.
 * The parsing logic mirrors imaging/sticker.py.
 *
 * pdf.js is loaded LAZILY, only when someone actually imports a sticker,
 * so the 1.7MB never costs anything to the common path.
 *
 * Coordinates: pdf.js reports PDF user space, where y increases UPWARD
 * from the bottom-left. imaging/sticker.py works top-down. Everything
 * here is converted to top-down on ingest so the two can be compared
 * line for line.
 *
 * Absolute x thresholds are deliberately NOT copied from the Python.
 * Those were tuned against one page size; here the columns are found by
 * locating their labels, which survives a different page geometry. */

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

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/;      // no I, O or Q in a VIN
const MONEY_RE = /\$[\d,]+(?:\.\d{2})?/;

function titleCase(s) {
  return s.toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    // A letter straight after a digit is a unit, not a new word: engine
    // displacements must read "2.0L EcoBoost", never "2.0l".
    .replace(/(\d)([a-z])\b/g, (_, d, c) => d + c.toUpperCase());
}

/* Page 1's text as positioned words, top-down. */
async function words(source) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument(
    typeof source === 'string' ? { url: source } : { data: source },
  ).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const out = [];
  for (const item of content.items) {
    const text = (item.str || '').trim();
    if (!text) continue;
    const x = item.transform[4];
    const y = viewport.height - item.transform[5];   // flip to top-down
    out.push({ text, x, y, w: item.width || 0, h: item.height || 0 });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return { words: out, width: viewport.width, height: viewport.height, pages: doc.numPages };
}

/* Group words into visual rows by y proximity. */
function rows(list, tol = 3) {
  const out = [];
  for (const w of [...list].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0].y - w.y) <= tol) last.push(w);
    else out.push([w]);
  }
  for (const r of out) r.sort((a, b) => a.x - b.x);
  return out;
}

const rowText = (r) => r.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();

function findRow(rs, pred) {
  for (const r of rs) if (pred(r)) return r;
  return null;
}

/* The value printed directly beneath a label, within the label's own
 * column. Used for EXTERIOR / INTERIOR, which sit as a label above their
 * value rather than beside it. */
function valueBelow(all, label, { maxDrop = 26, xSlack = 90 } = {}) {
  const hit = all.find((w) => w.text.toUpperCase() === label);
  if (!hit) return null;
  const below = all
    .filter((w) => w.y > hit.y + 1 && w.y < hit.y + maxDrop && Math.abs(w.x - hit.x) < xSlack)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!below.length) return null;
  const firstY = below[0].y;
  return below.filter((w) => Math.abs(w.y - firstY) <= 3).map((w) => w.text).join(' ').trim();
}

/* Parse a Ford-template window sticker.
 *
 * `source` is a URL string or an ArrayBuffer. Every field is optional:
 * a sticker that parses only half way is still worth more than typing
 * it all by hand, so nothing here throws on a missing field. */
export async function parseSticker(source) {
  const { words: ws, height } = await words(source);
  const rs = rows(ws);
  const all = ws;
  const fullText = ws.map((w) => w.text).join(' ');

  const out = { raw: { wordCount: ws.length } };

  const vin = VIN_RE.exec(fullText);
  if (vin) out.vin = vin[1];

  // Ford's placeholder PDF is a valid, well-formed 200 response that just
  // says to check back later. Detect it by content, not status.
  if (/check back later|has not yet been|not available/i.test(fullText)) {
    out.placeholder = true;
    return out;
  }

  const header = findRow(rs, (r) => {
    const t = rowText(r).toUpperCase();
    return t.includes('VEHICLE') && t.includes('DESCRIPTION');
  });
  const gridHeader = findRow(rs, (r) => {
    const t = rowText(r).toUpperCase();
    return t.includes('STANDARD') && t.includes('EQUIPMENT');
  });

  if (header) {
    const top = header[0].y;
    const bottom = gridHeader ? gridHeader[0].y : top + 0.25 * height;

    // The colour labels mark where the left-hand description block ends.
    const extLabel = all.find((w) => w.text.toUpperCase() === 'EXTERIOR' && w.y > top && w.y < bottom);
    const leftEdge = extLabel ? extLabel.x - 12 : Infinity;

    const block = rows(all.filter((w) => w.y > top + 1 && w.y < bottom && w.x < leftEdge));
    if (block.length) out.model_line = titleCase(rowText(block[0]));

    for (const r of block.slice(1)) {
      const text = rowText(r);
      const upper = text.toUpperCase();
      if (/^\d{4}\b/.test(text)) out.trim_drivetrain = titleCase(text);
      else if (upper.includes('PASSENGER')) out.seating = titleCase(text);
      else if (upper.includes('ENGINE') || /\bECOBOOST\b/.test(upper)) out.engine = titleCase(text);
      else if (upper.includes('TRANSMISSION') || /\bAUTO\b|\bMANUAL\b/.test(upper)) out.transmission = titleCase(text);
    }
  }

  const ext = valueBelow(all, 'EXTERIOR');
  if (ext) out.exterior_color = titleCase(ext);
  const int = valueBelow(all, 'INTERIOR');
  if (int) out.interior_color = titleCase(int);

  // Total MSRP: the money value on the row that names it.
  const msrpRow = findRow(rs, (r) => /TOTAL\s+MSRP|TOTAL\s+VEHICLE/i.test(rowText(r)));
  if (msrpRow) {
    const m = MONEY_RE.exec(rowText(msrpRow));
    if (m) out.price = m[0];
  }

  // Year / trim / drivetrain fall out of "2026 Xlt Fwd".
  if (out.trim_drivetrain) {
    const parts = out.trim_drivetrain.split(/\s+/);
    if (/^\d{4}$/.test(parts[0])) {
      out.year = parts[0];
      if (parts.length > 1) out.trim = parts[1];
      if (parts.length > 2) out.drivetrain = parts.slice(2).join(' ');
    }
  }
  if (out.model_line) out.model = out.model_line;

  // Make is not printed as a field; it is in the page furniture.
  const MAKES = ['FORD', 'LINCOLN', 'CHEVROLET', 'GMC', 'RAM', 'JEEP', 'TOYOTA',
                 'HONDA', 'NISSAN', 'HYUNDAI', 'KIA', 'SUBARU', 'VOLKSWAGEN'];
  const upperAll = fullText.toUpperCase();
  for (const make of MAKES) {
    if (upperAll.includes(make)) { out.make = titleCase(make); break; }
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
    ['vin', 'vin'], ['price', 'price'],
  ]) {
    if (sticker[from]) v[to] = String(sticker[from]).replace(/^\$/, '').replace(/,/g, '');
  }
  if (v.price) v.price = v.price.replace(/\.00$/, '');
  return v;
}

export { loadPdfjs };
