/* Reading a listing on the device: the browser's answer to
 * `lotstretcher <VDP url>`.
 *
 * The CLI scrapes a vehicle page with a headless browser and reads the
 * analytics blob DealerInspire embeds (scrape.py::normalize_vehicle). A
 * browser on lotstretcher.org cannot read another site's page (and the
 * page sits behind a bot challenge that a plain fetch never passes), so
 * the same reader runs here on a SAVED copy of the page or its pasted
 * source: no network, nothing leaves the device. The address itself is
 * read by pipeline/vin.js, which needs no page at all.
 *
 * normalizeListing() is a port of normalize_vehicle(), and
 * tests/test_listing_parity.py runs both on one fixture and compares
 * them field for field. */

import { get } from '../spec.js';

/* ---------- small ports of scrape.py helpers ---------------------- */

function nonzero(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isNaN(n) ? true : n !== 0;
}

function g(d, ...path) {
  let cur = d;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = cur[key];
  }
  return cur === undefined ? null : cur;
}

function cleanHtmlText(text) {
  if (!text) return text || null;
  let t = String(text).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const ta = typeof document !== 'undefined' ? document.createElement('textarea') : null;
  if (ta) { ta.innerHTML = t; t = ta.value; }
  else t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

export function upsizeImageUrl(url) {
  const { resizePattern, target } = get('listing', 'photoUrl');
  const re = new RegExp(resizePattern);
  return re.test(url) ? url.replace(re, target) : url;
}

/* ---------- normalisation ------------------------------------------ */

/* The record the CLI's Vehicle dataclass would hold, from the same
 * sources: the analytics payload, a schema.org Car node, and the Carfax
 * widget's link. Keys are the dataclass's own names so the parity test
 * can compare directly. */
export function normalizeListing({ url, payload, ldCar, carfaxUrl }) {
  const p = payload || {};
  const v = { url: url || null, warnings: [], pricing_rows: [], photo_urls: [], video_urls: [] };

  if (!payload) {
    v.warnings.push('Could not find embedded vehicle data blob; '
      + 'falling back to schema.org data only, most fields will be empty.');
  }

  v.vin = p.vin || g(ldCar, 'vehicleIdentificationNumber');
  v.stock_number = p.stockNumber ?? null;
  v.year = p.year ? String(p.year) : null;
  v.make = p.make ?? null;
  v.model = p.model ?? null;
  v.trim = p.trim ?? null;

  const certs = p.certifications || {};
  const certified = !!(certs.certifiedByManufacturer || certs.certifiedByDealer);
  if (p.used === false) v.condition = 'New';
  else if (p.used === true) v.condition = certified ? 'Certified Pre-Owned' : 'Used';
  else {
    const conditions = p.conditions_array || [];
    v.condition = conditions.length ? conditions[conditions.length - 1] : null;
  }
  v.vehicle_status = p.vehicleStatus ?? null;
  v.mileage = p.mileage ?? null;

  const titleBits = [v.year, v.make, v.model, v.trim].filter(Boolean);
  v.title = titleBits.join(' ') || g(ldCar, 'name');

  const colors = g(p, 'visual', 'colors') || {};
  v.exterior_color_factory = g(colors, 'exterior', 'factory') || g(ldCar, 'color');
  v.exterior_color_generic = g(colors, 'exterior', 'generic');
  v.interior_color = g(colors, 'interior', 'factory');

  const specs = p.specifications || {};
  v.engine = specs.engine || g(ldCar, 'vehicleEngine', 'name');
  const transmission = specs.transmission_new || specs.transmission;
  v.transmission = transmission ? String(transmission).trim() : (transmission ?? null);
  v.drivetrain = specs.drivetrain ?? null;
  v.fuel_type = specs.fuelType || g(ldCar, 'fuelType');
  v.mpg_city = null;
  v.mpg_highway = null;
  if (nonzero(specs.mpgCityLow) || nonzero(specs.mpgCityHigh)) {
    const [lo, hi] = [specs.mpgCityLow, specs.mpgCityHigh];
    v.mpg_city = lo === hi ? lo : `${lo}-${hi}`;
  }
  if (nonzero(specs.mpgHighwayLow) || nonzero(specs.mpgHighwayHigh)) {
    const [lo, hi] = [specs.mpgHighwayLow, specs.mpgHighwayHigh];
    v.mpg_highway = lo === hi ? lo : `${lo}-${hi}`;
  }
  const bodyTypes = specs.vehicleType || [];
  v.body_type = bodyTypes.length ? bodyTypes.join(', ') : (g(ldCar, 'bodyType ') || g(ldCar, 'bodyType'));
  v.ev_battery_range = p.evBatteryRange ?? null;
  v.ev_mpge_combined = p.evMpgCombined ?? null;
  v.cab_style = p.cabStyle || null;
  v.box_length = p.boxLength ?? null;

  v.display_price = p.displayPrice || p.price || null;
  if (!nonzero(v.display_price)) v.display_price = null;
  for (const row of p.flattened_pricing || []) {
    const pr = row.pricing || {};
    if (pr.Label && pr.Text) v.pricing_rows.push({ label: pr.Label, text: pr.Text });
  }

  v.dealer_description = cleanHtmlText(p.dealerDescription || g(ldCar, 'description'));
  v.dealer_comments = cleanHtmlText(p.dealerComments) || null;

  const features = p.features || {};
  v.main_features = features.mainFeatures || [];
  v.features_structured = features.featuresStructured || {};
  v.options = p.options || [];
  v.tags = p.tags || [];

  const loc = p.location || {};
  v.dealer_name = loc.name ?? null;
  let cityStateZip = [loc.city, loc.state].filter(Boolean).join(', ');
  if (loc.zipCode) cityStateZip = `${cityStateZip} ${loc.zipCode}`.trim();
  const addrBits = [loc.address1, loc.address2].filter(Boolean).concat(cityStateZip ? [cityStateZip] : []);
  v.dealer_address = addrBits.length ? addrBits.join(', ') : null;
  v.dealer_phone = loc.contactNumber ?? null;

  const visual = p.visual || {};
  let combined = visual.combinedPhotos;
  if (!combined || !combined.length) combined = (visual.dealerPhotos || []).concat(visual.stockPhotos || []);
  const seen = new Set();
  for (const photo of combined) {
    const src = photo && typeof photo === 'object' ? photo.source : null;
    if (src && !seen.has(src)) { seen.add(src); v.photo_urls.push(upsizeImageUrl(src)); }
  }
  if (!v.photo_urls.length) {
    const img = g(p, 'visual', 'image', 'source') || g(ldCar, 'image');
    if (img) v.photo_urls.push(upsizeImageUrl(img));
  }
  for (const vid of visual.dealerVideos || []) {
    if (vid && typeof vid === 'object' && vid.source) v.video_urls.push(vid.source);
    else if (typeof vid === 'string') v.video_urls.push(vid);
  }

  v.window_sticker_url = g(p, 'expando', 'WindowStickerUrl') || null;
  v.carfax_url = carfaxUrl || null;
  const haystacks = v.main_features.concat(
    Object.values(v.features_structured).flat());
  v.carfax_one_owner = haystacks.some((t) => typeof t === 'string' && /\b1[\s-]*owner\b/i.test(t));

  if (!v.photo_urls.length) v.warnings.push('No photos found for this vehicle.');
  if (!v.window_sticker_url) v.warnings.push('No window sticker URL found (common for used vehicles).');
  if (!v.display_price) v.warnings.push('No price found.');
  return v;
}

/* ---------- the hand-off encoding ---------------------------------- */

/* base64url of UTF-8 JSON. Fragments may hold a few hundred KB in every
 * current browser; a trimmed payload is well under 50. */
/* ---------- reading a page ------------------------------------------ */

/* The JSON object embedded at `marker`, by matching balanced braces: a
 * port of scrape.py::extract_balanced_json. Regex cannot match nested
 * JSON, so this scans from the first '{' after the marker, tracking
 * string state, until the braces balance. */
export function extractBalancedJson(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let start = at + marker.length;
  while (start < text.length && text[start] !== '{') start++;
  if (start >= text.length) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/* The payload trimmed to the keys the CLI reads, and the description
 * capped: a page read here carries what the CLI would have used. */
export function trimPayload(P) {
  if (!P) return null;
  const keys = get('listing', 'payloadKeys');
  const maxDesc = get('listing', 'descriptionMaxChars');
  const p = {};
  for (const k of keys) if (P[k] !== undefined) p[k] = P[k];
  if (p.dealerDescription) p.dealerDescription = String(p.dealerDescription).slice(0, maxDesc);
  if (p.visual) {
    const V = p.visual;
    const t = (x) => (Array.isArray(x) ? x.map((i) => (i && i.source ? { source: i.source } : i)) : x);
    p.visual = {
      colors: V.colors, image: V.image, combinedPhotos: t(V.combinedPhotos),
      dealerPhotos: t(V.dealerPhotos), stockPhotos: t(V.stockPhotos), dealerVideos: t(V.dealerVideos),
    };
  }
  return p;
}

/* A raw listing record from a page's HTML, read from a saved copy of
 * the listing (File > Save Page As, or the page source pasted in). No
 * network: the page's own text is read on this device. */
export function recordFromHtml(html, url = null) {
  const marker = get('listing', 'analyticsMarker');
  const analytics = extractBalancedJson(html, marker);
  const payload = analytics && analytics.vdp_gtm_payload ? trimPayload(analytics.vdp_gtm_payload) : null;
  let ldCar = null;
  const doc = typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(html, 'text/html') : null;
  if (doc) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(s.textContent);
        for (const n of (Array.isArray(d) ? d : (d['@graph'] || [d]))) if (n && n['@type'] === 'Car') ldCar = n;
      } catch { /* not JSON */ }
    }
    if (!url) url = doc.querySelector('link[rel="canonical"]')?.href || doc.querySelector('meta[property="og:url"]')?.content || null;
  }
  const carfax = /class="carfax-logo"[^>]*>\s*<a href="([^"]+)"/.exec(html);
  return { url, payload, ldCar, carfaxUrl: carfax ? carfax[1] : null };
}

/* ---------- the bookmarklet ------------------------------------------ */

/* Source for the bookmarklet, bound to the app origin that generated it,
 * so a self-hosted install's bookmarklet opens that install.
 *
 * Self-contained on purpose: it could load a script from the app origin
 * and stay tiny, but dealer sites with a content-security policy would
 * block that, and the collector is small enough to carry. It gathers
 * what normalize_vehicle reads and nothing else: the key list is the
 * spec's, the photo entries are cut to their source URL, and the dealer
 * description is capped. */
