/* What a VIN says on its own, decoded on this device from the spec's
 * tables: whether it is well formed (the check digit), the model year,
 * the manufacturer (the first three characters) and the country. Model
 * and trim are encoded per manufacturer and are not here; a listing
 * address carries them in its slug, which fromUrl reads. Nothing is
 * fetched and nothing leaves the device.
 *
 * The twin of lotstretcher/vin.py; tests/test_vin_parity.py holds the
 * two to the same answers. */

import { get } from '../spec.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function normalize(text) {
  return String(text || '').toUpperCase().replace(/O/g, '0').replace(/I/g, '1').replace(/Q/g, '0').replace(/[^A-Z0-9]/g, '');
}

export function checkDigit(vin) {
  const table = get('vin', 'transliteration');
  const weights = get('vin', 'weights');
  let total = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    let v;
    if (ch >= '0' && ch <= '9') v = Number(ch);
    else if (ch in table) v = table[ch];
    else return null;
    total += v * weights[i];
  }
  const r = total % 11;
  return r === 10 ? 'X' : String(r);
}

export function modelYear(vin) {
  const codes = get('vin', 'yearCodes');
  const start = get('vin', 'yearCycleStart');
  const i = codes.indexOf(vin[9]);
  if (i < 0) return null;
  let year = start + i;
  if (/[A-Z]/.test(vin[6]) || !'12345'.includes(vin[0])) year += 30;
  return year;
}

export function decode(text) {
  const vin = normalize(text);
  const out = { vin, valid: false, year: null, make: null, country: null, warnings: [] };
  if (vin.length !== 17) { out.warnings.push(`A VIN has 17 characters; this has ${vin.length}.`); return out; }
  const expected = checkDigit(vin);
  if (expected === null) { out.warnings.push('That is not a VIN: it holds a character a VIN cannot.'); return out; }
  out.valid = expected === vin[8];
  if (!out.valid) out.warnings.push("The VIN's check digit does not match; one character is probably mistyped.");
  out.year = modelYear(vin);
  const make = (get('vin', 'wmi') || {})[vin.slice(0, 3)] ?? null;
  out.country = (get('vin', 'countries') || {})[vin[0]] ?? null;
  if (make === null) out.warnings.push(`The manufacturer code ${vin.slice(0, 3)} is not one the app knows; type the make.`);
  else if (Array.isArray(make)) {
    // One manufacturer, several brands: the address's slug decides.
    out.makes = [...make];
    out.warnings.push(`That manufacturer code is ${make.join(' or ')}; pick the make.`);
  } else out.make = make;
  return out;
}

const capitalize = (w) => (w.length > 3 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toUpperCase());

export function fromUrl(url) {
  const out = { url, vin: null, year: null, make: null, model: null, slug: null };
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return out; }
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const up = parts[i].toUpperCase();
    if (VIN_RE.test(up) && checkDigit(up) !== null) {
      out.vin = up;
      if (i + 1 < parts.length) out.slug = parts[i + 1];
      break;
    }
  }
  if (out.slug === null) {
    for (const part of [...parts].reverse()) {
      if (/\b(19|20)\d\d\b/.test(part.replace(/-/g, ' '))) { out.slug = part; break; }
    }
  }
  if (out.slug) Object.assign(out, parseSlug(out.slug));
  return out;
}

const CONDITION_WORDS = ['new', 'used', 'certified', 'pre', 'owned', 'preowned', 'cpo'];

/* year, make, model from a slug like Used-2024-Ford-F--250SD-Tomball-TX:
 * a doubled dash is a literal hyphen in a name, a leading condition
 * word is skipped, and the city before a two-letter state is dropped. */
export function parseSlug(slug) {
  let words = slug.replace(/--/g, '\0').split('-').filter(Boolean).map((w) => w.replace(/\0/g, '-').replace(/_/g, ' '));
  while (words.length && CONDITION_WORDS.includes(words[0].toLowerCase())) words = words.slice(1);
  const out = { year: null, make: null, model: null };
  if (words.length && /^(19|20)\d\d$/.test(words[0])) { out.year = Number(words[0]); words = words.slice(1); }
  if (!words.length) return out;
  out.make = capitalize(words[0]);
  let rest = words.slice(1);
  // A dealer's slug ends in its city and state: drop both when the last
  // word is a state code (a two-letter model such as NX sits earlier).
  if (rest.length >= 3 && /^[A-Za-z]{2}$/.test(rest[rest.length - 1])) rest = rest.slice(0, -2);
  // An all-lower-case slug is capitalised word by word.
  if (rest.length) out.model = rest.map((w) => (w === w.toLowerCase() && /[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return out;
}

/* What the app fills from a pasted address or VIN, in the
 * scrape.Vehicle shape the form reads. */
export function recordFromText(text) {
  text = String(text || '').trim();
  const isUrl = /^https?:\/\//i.test(text);
  const u = isUrl ? fromUrl(text) : { url: null, vin: null, year: null, make: null, model: null };
  const d = (u.vin || !isUrl) ? decode(u.vin || text) : null;
  const v = {
    url: u.url, vin: d && d.vin.length === 17 ? d.vin : null,
    year: u.year || (d ? d.year : null), make: u.make || (d ? d.make : null),
    model: u.model, trim: null, warnings: [], photo_urls: [], video_urls: [], pricing_rows: [],
  };
  if (d) {
    v.warnings.push(...d.warnings);
    if (d.make && u.make && d.make.toLowerCase() !== u.make.toLowerCase()) v.warnings.push(`The VIN says ${d.make}; the address says ${u.make}.`);
  }
  if (isUrl && !u.vin) v.warnings.push('No VIN in that address; only what its words say was read.');
  v.title = [v.year, v.make, v.model].filter(Boolean).join(' ') || null;
  return v;
}
