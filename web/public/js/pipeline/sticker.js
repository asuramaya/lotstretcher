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

/* Page 1's text as positioned words, top-down. */
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
   * every label rule here matches word by word, so a run-shaped token
   * never equals "BASE". Split runs into words and estimate each word's
   * x by its share of the run, which puts the browser and the CLI on the
   * same data shape. Proportional-by-character is approximate for a
   * proportional font, but only needs to be good enough to order words
   * and to tell columns apart. */
  const out = [];
  const runs = [];
  for (const item of content.items) {
    const raw = (item.str || '');
    if (!raw.trim()) continue;
    runs.push({
      text: raw.trim(),
      x: item.transform[4],
      y: viewport.height - item.transform[5],
      w: item.width || 0,
      h: item.height || 0,
    });
    const y = viewport.height - item.transform[5];   // flip to top-down
    const x0 = item.transform[4];
    const total = item.width || 0;
    const perChar = raw.length ? total / raw.length : 0;

    let at = 0;
    for (const token of raw.split(/(\s+)/)) {
      if (token.trim()) {
        out.push({
          text: token,
          x: x0 + at * perChar,
          y,
          w: token.length * perChar,
          h: item.height || 0,
        });
      }
      at += token.length;
    }
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  return { words: out, runs, width: viewport.width, height: viewport.height, pages: doc.numPages };
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
function valueBelow(runs, label, { maxDrop = 26, xSlack = 40 } = {}) {
  /* Operates on RUNS, not words.
   *
   * A colour name is laid out as ONE text run, so the run directly under
   * the label already IS the whole value. Reassembling it from split
   * words needs a gap threshold, and no single threshold works: tight
   * truncates "Azure Gray Metallic Tc" to "Azure Gray Metallic", loose
   * swallows the next column's "121\" Wheelbase". Estimated per-word
   * widths are not accurate enough to separate those two cases, and the
   * run boundary answers it exactly. */
  const hit = runs.find((r) => r.text.toUpperCase() === label);
  if (!hit) return null;
  const below = runs
    .filter((r) => r.y > hit.y + 1 && r.y < hit.y + maxDrop && Math.abs(r.x - hit.x) < xSlack)
    .sort((a, b) => a.y - b.y);
  return below.length ? below[0].text.trim() : null;
}

/* ---------- pricing ----------
 * INCLUDED ON THIS VEHICLE (left) and PRICE INFORMATION (right) are
 * side-by-side columns that frequently land on the SAME visual row, so a
 * label anchored at the row's start misses any price whose row also
 * carries left-column text. Match the label as a subsequence ANYWHERE in
 * the row, then take the first money token AFTER the match rather than
 * the last one in the row, which could belong to a different label
 * further right. Same reasoning as imaging/sticker.py::_parse_pricing. */
const MONEY_EXACT = /^\$?[\d,]+\.\d{2}$/;

function findLabel(row, labelWords) {
  const upper = row.map((w) => w.text.toUpperCase());
  for (let i = 0; i <= upper.length - labelWords.length; i++) {
    let hit = true;
    for (let j = 0; j < labelWords.length; j++) {
      if (upper[i + j] !== labelWords[j]) { hit = false; break; }
    }
    if (hit) return i + labelWords.length;
  }
  return null;
}

function moneyAfter(rs, labelWords) {
  for (const row of rs) {
    const start = findLabel(row, labelWords);
    if (start === null) continue;
    for (const w of row.slice(start)) {
      if (MONEY_EXACT.test(w.text)) return w.text.startsWith('$') ? w.text : `$${w.text}`;
    }
  }
  return null;
}

function parsePricing(rs) {
  const out = {};
  const base = moneyAfter(rs, ['BASE', 'PRICE']);
  if (base) out.base_price = base;
  const dest = moneyAfter(rs, ['DESTINATION', '&', 'DELIVERY']);
  if (dest) out.destination_and_delivery = dest;
  const totalOpts = moneyAfter(rs, ['TOTAL', 'VEHICLE', '&', 'OPTIONS/OTHER']);
  if (totalOpts) out.total_vehicle_and_options = totalOpts;
  const msrp = moneyAfter(rs, ['TOTAL', 'MSRP']);
  if (msrp) out.total_msrp = msrp;
  return out;
}

/* ---------- standard equipment grid ----------
 * Four labelled columns. Each item is assigned to whichever column
 * header it sits closest to horizontally, which survives a layout whose
 * column x positions differ from the one the CLI was tuned against. */
const EQUIP_COLUMNS = [
  ['EXTERIOR', 'exterior'],
  ['INTERIOR', 'interior'],
  ['FUNCTIONAL', 'functional_tech'],
  ['SAFETY/SECURITY', 'safety_security'],
];

function parseEquipmentGrid(runs, rs) {
  const gridHeader = rs.find((r) => {
    const t = rowText(r).toUpperCase();
    return t.includes('STANDARD') && t.includes('EQUIPMENT');
  });
  if (!gridHeader) return {};

  const top = gridHeader[0].y;
  const anchors = [];
  for (const [label, key] of EQUIP_COLUMNS) {
    const head = label.split('/')[0];
    const hit = runs.find((r) => r.y > top && r.y < top + 40
      && r.text.toUpperCase().startsWith(head));
    if (hit) anchors.push({ key, x: hit.x, y: hit.y });
  }
  if (anchors.length < 2) return {};

  const bodyTop = Math.max(...anchors.map((a) => a.y)) + 4;
  /* Bound on the next section header, found in the RUNS: a word-row
   * search misses it whenever that row also carries sidebar text, and
   * the fallback height then swept in everything below the grid. */
  const endRun = runs.find((r) => r.y > bodyTop
    && /^(OPTIONAL\s+EQUIPMENT|INCLUDED\s+ON\s+THIS)/i.test(r.text));
  const bottom = endRun ? endRun.y - 2 : bodyTop + 220;

  const out = {};
  for (const a of anchors) out[a.key] = [];

  /* The grid's RIGHT EDGE, which nearest-anchor alone cannot supply.
   *
   * A fuel-economy sidebar sits to the right of the four columns at the
   * same y ("combined city/hwy", "26", "$1,000 more in fuel costs"...).
   * Nearest-anchor assigns every line of it to SAFETY/SECURITY, because
   * that is the closest of the four, and the column came back with 33
   * items where the CLI finds 6. The columns are evenly pitched, so one
   * pitch past the last of them is where the grid stops. */
  const xs = anchors.map((a) => a.x).sort((p, q) => p - q);
  const pitch = xs.length > 1
    ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1)
    : Infinity;
  const rightEdge = xs[xs.length - 1] + pitch;

  /* Row pitch, measured rather than assumed: it differs between sticker
   * templates and drives the gap test that ends each column. */
  const firstCol = runs
    .filter((r) => r.y > bodyTop && r.y < bottom && r.x >= xs[0] - 8 && r.x < xs[0] + pitch - 8)
    .map((r) => r.y)
    .sort((a2, b2) => a2 - b2);
  const deltas = [];
  for (let i = 1; i < firstCol.length; i++) {
    const d = firstCol[i] - firstCol[i - 1];
    if (d > 0) deltas.push(d);
  }
  deltas.sort((a2, b2) => a2 - b2);
  const rowPitch = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 10;

  /* Each cell is its OWN run, so column assignment is just "which header
   * is this run under". No gap splitting: estimated word widths are not
   * accurate enough, and splitting on them either cut items in half or
   * merged three columns into one line. */
  /* EACH COLUMN ENDS ON ITS OWN, not on a shared y.
   *
   * On a real Ford sticker the SAFETY/SECURITY column runs out after six
   * items and starts a WARRANTY block beneath it, while the other three
   * columns keep listing equipment for another seven rows. Bounding the
   * whole grid at the first such header is what the CLI does, and it
   * silently drops those rows: measured on this sticker, 14 real
   * exterior items reported as 7.
   *
   * So each column is walked down its own x band and terminated by
   * whichever comes first: a section header, or a vertical gap clearly
   * larger than the row pitch. */
  const SECTION_WORDS = /^(WARRANTY|INCLUDED ON THIS|PRICE INFORMATION|OPTIONAL|SOLD TO|FUEL ECONOMY)/i;

  for (const a of anchors) {
    const band = runs
      .filter((r) => r.y > bodyTop && r.y < bottom
        && r.x >= a.x - 8 && r.x < a.x + pitch - 8
        && r.text.replace(/^[\s.\u2022\u00b7-]+/, '').trim().length >= 3)
      .sort((m, n) => m.y - n.y || m.x - n.x);

    let previousY = null;
    for (const r of band) {
      const text = r.text.replace(/^[\s.\u2022\u00b7-]+/, '').trim();
      if (SECTION_WORDS.test(text)) break;
      // A gap of more than twice the row pitch means this column's list
      // has ended and something else has started under it.
      if (previousY !== null && r.y - previousY > rowPitch * 2) break;
      previousY = r.y;
      out[a.key].push(displayCase(text));
    }
  }
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

/* ---------- optional equipment ----------
 * Bounded on the right by the PRICE INFORMATION column, because a line
 * can carry a "NO CHARGE" suffix well past where its label ends, and
 * bounded below by SOLD TO, the next real header in the same band.
 * Filtering WORDS by that band before grouping matters: a row that
 * merely starts in-band still pulls in same-y sidebar text otherwise. */
function parseOptionalEquipment(all, rs) {
  const header = rs.find((r) => {
    const u = r.map((w) => w.text.toUpperCase());
    return u.includes('OPTIONAL') && u.some((t) => t.includes('EQUIPMENT'));
  });
  if (!header) return [];
  const top = header[0].y;

  const soldTo = rs.find((r) => r[0].text.toUpperCase() === 'SOLD'
    && r[1] && r[1].text.toUpperCase() === 'TO');
  const bottom = soldTo ? soldTo[0].y : top + 150;

  /* The PRICE INFORMATION column is the right bound. Find it by the word
   * pair ANYWHERE in its row: after run-splitting, that row usually
   * starts with left-column text, so anchoring at r[0] finds nothing and
   * the bound silently becomes Infinity, which is what let the price
   * column bleed into these lines. */
  let xEnd = Infinity;
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i].text.toUpperCase() === 'PRICE'
        && all[i + 1].text.toUpperCase() === 'INFORMATION') {
      xEnd = all[i].x - 5;
      break;
    }
  }

  const items = [];
  for (const r of rows(all.filter((w) => w.y > top && w.y < bottom && w.x < xEnd))) {
    const text = rowText(r).replace(/^[.\s_]+/, '').replace(/[\s_]+$/, '').trim();
    if (!text || text.length < 4) continue;
    // Boilerplate the sticker prints in this band that is not equipment.
    if (/NO CHARGE|NOT RATED|CALCULATE|PERSONALIZED|COMPARE VEHICLES|MODEL YEAR/i.test(text)) continue;
    items.push(displayCase(text));
  }
  return items;
}

/* ---------- warranties ---------- */
function parseWarranties(rs) {
  const out = [];
  for (const r of rs) {
    const t = rowText(r);
    // "3-Year / 36,000-Mile Bumper-to-Bumper" and friends.
    if (/\d+[-\s]?Year\s*\/\s*[\d,]+[-\s]?Mile/i.test(t)) out.push(displayCase(t));
  }
  return out;
}

/* Parse a Ford-template window sticker.
 *
 * `source` is a URL string or an ArrayBuffer. Every field is optional:
 * a sticker that parses only half way is still worth more than typing
 * it all by hand, so nothing here throws on a missing field. */
export async function parseSticker(source) {
  const { words: ws, runs: rn, height } = await words(source);
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
    const extLabel = rn.find((w) => w.text.toUpperCase() === 'EXTERIOR' && w.y > top && w.y < bottom);
    const leftEdge = extLabel ? extLabel.x - 12 : Infinity;

    const block = rows(all.filter((w) => w.y > top + 1 && w.y < bottom && w.x < leftEdge));
    if (block.length) out.model_line = titleCase(rowText(block[0]));

    for (const r of block.slice(1)) {
      const text = rowText(r);
      const upper = text.toUpperCase();
      if (/^\d{4}\b/.test(text)) out.trim_drivetrain = titleCase(text);
      else if (upper.includes('PASSENGER')) out.seating = titleCase(text);
      else if (upper.includes('ENGINE') || /\bECOBOOST\b/.test(upper)) out.engine = displayCase(text);
      else if (upper.includes('TRANSMISSION') || /\bAUTO\b|\bMANUAL\b/.test(upper)) out.transmission = displayCase(text);
    }
  }

  const ext = valueBelow(rn, 'EXTERIOR');
  if (ext) out.exterior_color = titleCase(ext);
  const int = valueBelow(rn, 'INTERIOR');
  if (int) out.interior_color = titleCase(int);

  out.pricing = parsePricing(rs);
  // The number a shopper means by "the price" is the total MSRP.
  out.price = out.pricing.total_msrp || out.pricing.base_price || null;

  out.equipment = parseEquipmentGrid(rn, rs);
  out.optional_equipment = parseOptionalEquipment(all, rs);
  out.warranties = parseWarranties(rs);

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
    if (!sticker[from]) continue;
    let value = String(sticker[from]);
    // Colours reach the form AND the post copy, so expand the sticker's
    // abbreviations once here rather than letting the two disagree.
    if (from.endsWith('_color')) value = displayCase(value);
    else value = value.replace(/^\$/, '').replace(/,/g, '');
    v[to] = value;
  }
  if (v.price) v.price = v.price.replace(/\.00$/, '');
  return v;
}

export { loadPdfjs };
