/* Post copy for each platform: a port of facebook_post.py (the long
 * Marketplace post) and social_post.py (Threads and Instagram).
 *
 * This file used to be its own algorithm, with seeded openers and
 * closers the CLI never had. Two generators for one job is the drift
 * the whole surface exists to remove, so it is now the same logic as
 * the Python, line for line where the languages allow, and
 * tests/test_copy_parity.py runs both on the same vehicles and compares
 * the finished text. Anything editorial (what leads, what gets dropped
 * when the budget runs out, which tags) is decided once, in one place,
 * and that place is documented in the Python modules.
 *
 * Deterministic, no model, no key, no network. Nothing here invents a
 * claim: every value is a scraped, stickered or typed field; the only
 * decisions are ordering and what to drop.
 *
 * `dealer` is the app's stand-in for dealer_config: { name, greeting,
 * address, city_tags }. The CLI always has a greeting and an address from
 * its config; here they may be unset, and an unset line is omitted rather
 * than printed blank. */

const THREADS_LIMIT = 500;
const INSTAGRAM_VISIBLE = 125;
const DELIVERY_MILEAGE_CEILING = 100;
const MAX_HASHTAGS = 14;
const MAX_TAG_LENGTH = 28;

const BODY_TYPE_TAGS = {
  'suv': 'SUV',
  'sport utility': 'SUV',
  'truck': 'Truck',
  'pickup': 'Truck',
  'crew cab pickup': 'Truck',
  'sedan': 'Sedan',
  'coupe': 'Coupe',
  'convertible': 'Convertible',
  'hatchback': 'Hatchback',
  'van': 'Van',
  'cargo van': 'WorkVan',
  'minivan': 'Minivan',
  'wagon': 'Wagon',
};

const INCENTIVE_KEYWORDS = ['price includes', 'rebate', 'incentive', 'discount', 'cash allowance'];

const PLATFORMS = ['facebook', 'instagram', 'threads'];

/* ---------- small ports of Python formatting ---------------------- */

/* Python's f"{n:,}" for an integer. */
const commas = (n) => Math.trunc(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

/* Python's f"{x:,.0f}": round half to even, then commas. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
const commas0f = (x) => commas(roundHalfEven(x));

/* float(str(text).replace(",", "").replace("$", "").lstrip("+")) or null. */
function toFloat(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).replace(/,/g, '').replace(/\$/g, '').replace(/^\++/, '').trim();
  if (s === '' || !/^[-]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const lower = (s) => String(s || '').trim().toLowerCase();

export function vehicleTitle(v) {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ').trim();
}

/* ---------- pricing (facebook_post.py) ------------------------------ */

export function resolveDisplayPrice(v) {
  if (lower(v.condition) !== 'new') return v.display_price ?? null;
  const stickerMsrp = v.sticker?.pricing?.total_msrp;
  if (stickerMsrp) return stickerMsrp;
  for (const row of v.pricing_rows || []) {
    if (String(row.label || '').trim().toUpperCase() === 'MSRP') return row.text ?? null;
  }
  return v.display_price ?? null;
}

export function resolveOriginalMsrpComparison(v) {
  if (lower(v.condition) === 'new') return null;
  const stickerMsrp = v.sticker?.pricing?.total_msrp;
  if (!stickerMsrp) return null;
  const current = resolveDisplayPrice(v);
  const msrpNum = toFloat(stickerMsrp);
  const currentNum = toFloat(current);
  if (msrpNum === null || currentNum === null) return null;
  if (msrpNum <= currentNum) return null;
  return `$${commas0f(msrpNum)}`;
}

function looksLikeIncentiveDisclosure(text) {
  const l = text.toLowerCase();
  return text.includes('$') && INCENTIVE_KEYWORDS.some((k) => l.includes(k));
}

function fordQrLink(vin) {
  return `http://v.ford.com/?v=${vin}&c=1&s=1`;
}

function resolveMoreDetailsLink(v) {
  if (lower(v.make) !== 'ford') return null;
  if (!(v.sticker && v.vin)) return null;
  return fordQrLink(v.vin);
}

function featureKey(feature) {
  return String(feature).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* Python: int(float(...)) with a ValueError fallback to the raw text. */
function pricePhrase(resolved) {
  const n = toFloat(resolved);
  if (n === null) return String(resolved);
  return `$${commas(n)}`;
}

/* ---------- the Marketplace post (facebook_post.py) ----------------- */

export function buildFacebookPost(v, dealer = {}) {
  const lines = [];
  const seen = new Set();
  const newFeatures = (feats) => {
    const out = [];
    for (const f of feats || []) {
      const key = featureKey(f);
      if (key && !seen.has(key)) { seen.add(key); out.push(f); }
    }
    return out;
  };

  const conditionWord = String(v.condition || '').trim();
  const headline = `${conditionWord.toLowerCase() === 'new' ? 'New ' : ''}${v.title || 'Vehicle'}`.trim();

  if (dealer.greeting) lines.push(dealer.greeting);
  lines.push(headline);
  if (dealer.address) lines.push(dealer.address);
  lines.push('');

  const resolved = resolveDisplayPrice(v);
  if (resolved) lines.push(`Price: ${pricePhrase(resolved)}`);
  else lines.push('Price: Call for Price');
  const originalMsrp = resolveOriginalMsrpComparison(v);
  if (originalMsrp) lines.push(`Original MSRP: ${originalMsrp}`);
  if (v.mileage !== null && v.mileage !== undefined) lines.push(`Mileage: ${commas(v.mileage)} mi`);
  if (v.vin) lines.push(`VIN: ${v.vin}`);
  if (v.stock_number) lines.push(`Stock #: ${v.stock_number}`);
  lines.push('');

  const specs = [];
  if (v.exterior_color_factory) specs.push(`Exterior: ${v.exterior_color_factory}`);
  if (v.interior_color) specs.push(`Interior: ${v.interior_color}`);
  if (v.engine) specs.push(`Engine: ${v.engine}`);
  if (v.transmission) specs.push(`Transmission: ${v.transmission}`);
  if (v.drivetrain) specs.push(`Drivetrain: ${v.drivetrain}`);
  if (v.mpg_city || v.mpg_highway) {
    specs.push(`MPG: ${mpgPhrase(v)}`);
  } else if (v.ev_mpge_combined) {
    specs.push(`MPGe: ${v.ev_mpge_combined} combined`);
  }
  if (v.ev_battery_range) specs.push(`EV Range: ${v.ev_battery_range} mi`);
  if (v.cab_style) specs.push(`Cab: ${v.cab_style}`);
  if (v.box_length) specs.push(`Bed length: ${v.box_length}`);
  if (specs.length) { lines.push(...specs); lines.push(''); }

  const isNew = lower(v.condition) === 'new';
  if (v.dealer_description && !(isNew && looksLikeIncentiveDisclosure(v.dealer_description))) {
    lines.push(v.dealer_description.trim());
    lines.push('');
  }

  const stickerEquipment = v.sticker?.equipment || {};
  if (Object.keys(stickerEquipment).length) {
    for (const [key, label] of [
      ['exterior', 'Exterior'],
      ['interior', 'Interior'],
      ['functional_tech', 'Functional & Tech'],
      ['safety_security', 'Safety & Security'],
    ]) {
      const feats = newFeatures(stickerEquipment[key]);
      if (!feats.length) continue;
      lines.push(`${label}:`);
      for (const f of feats) lines.push(`- ${f}`);
      lines.push('');
    }
    const optional = newFeatures(v.sticker.optional_equipment);
    if (optional.length) {
      lines.push('Optional Equipment:');
      for (const f of optional) lines.push(`- ${f}`);
      lines.push('');
    }
    const warranties = v.sticker.warranties;
    if (warranties && warranties.length && lower(v.make) === 'ford') {
      lines.push('Factory Warranties:');
      for (const w of warranties) lines.push(`- ${w}`);
      lines.push('');
    }
  } else if (v.main_features && v.main_features.length) {
    const feats = newFeatures(v.main_features);
    if (feats.length) {
      lines.push('Features:');
      for (const f of feats) lines.push(`- ${f}`);
      lines.push('');
    }
  } else if (v.features_structured && Object.keys(v.features_structured).length) {
    const feats = Object.values(v.features_structured).flatMap((group) => newFeatures(group));
    if (feats.length) {
      lines.push('Features:');
      for (const f of feats) lines.push(`- ${f}`);
      lines.push('');
    }
  }

  if (v.carfax_one_owner) { lines.push('CARFAX 1-Owner'); lines.push(''); }

  const more = resolveMoreDetailsLink(v);
  if (more) lines.push(`More details: ${more}`);

  return lines.join('\n').trim() + '\n';
}

function mpgPhrase(v) {
  return [v.mpg_city && `${v.mpg_city} city`, v.mpg_highway && `${v.mpg_highway} hwy`]
    .filter(Boolean).join('/');
}

/* ---------- hashtags (social_post.py) -------------------------------- */

/* Python's str.isupper(): at least one cased character, none lowercase. */
const isUpper = (s) => /[A-Z]/.test(s) && !/[a-z]/.test(s);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function tag(text) {
  const parts = String(text || '').match(/[A-Za-z0-9]+/g);
  if (!parts) return null;
  const joined = parts.length === 1 ? parts[0] : parts.map((p) => (isUpper(p) ? p : capitalize(p))).join('');
  return joined.length <= MAX_TAG_LENGTH ? joined : null;
}

export function buildHashtags(v, dealer = {}, limit = MAX_HASHTAGS) {
  const tags = [];
  const add = (value) => {
    const t = tag(value);
    if (t && !tags.includes(t)) tags.push(t);
  };

  if (v.make && v.model) {
    add(`${v.make} ${v.model}`);
    if (v.trim) add(`${v.make} ${v.model} ${v.trim}`);
    if (v.year) add(`${v.year} ${v.make} ${v.model}`);
  }
  add(v.make);

  const body = lower(v.body_type);
  if (body) {
    const keys = Object.keys(BODY_TYPE_TAGS).sort((a, b) => b.length - a.length);
    const matched = keys.find((k) => body.includes(k));
    add(matched ? BODY_TYPE_TAGS[matched] : body);
  }

  const condition = lower(v.condition);
  if (condition.startsWith('cert')) add('CertifiedPreOwned');
  else if (condition === 'new') add('NewCar');
  else if (condition) add('UsedCars');

  for (const cityTag of dealer.city_tags || []) add(cityTag);
  for (const generic of ['CarsForSale', 'ForSale', 'CarDealership']) add(generic);

  return tags.slice(0, limit).map((t) => `#${t}`);
}

/* ---------- Threads and Instagram (social_post.py) ------------------- */

function headline(v) {
  const prefix = lower(v.condition) === 'new' ? 'New ' : '';
  return `${prefix}${v.title || 'Vehicle'}`.trim();
}

function showableMileage(v) {
  if (v.mileage === null || v.mileage === undefined || v.mileage < DELIVERY_MILEAGE_CEILING) return null;
  return v.mileage;
}

function hook(v) {
  const parts = [headline(v)];
  const resolved = resolveDisplayPrice(v);
  if (resolved) parts.push(pricePhrase(resolved));
  const line = parts.join(' — ');
  const mileage = showableMileage(v);
  if (mileage !== null) {
    const withMiles = `${line} — ${commas(mileage)} mi`;
    if (withMiles.length <= INSTAGRAM_VISIBLE) return withMiles;
  }
  return line;
}

const TRIM_ORDER = ['stock', 'vin', 'drivetrain', 'engine', 'color', 'carfax', 'mileage'];

function cityState(addr) {
  const parts = String(addr || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const st = parts[2].split(/\s+/)[0];
    return `${parts[1]}, ${st}`;
  }
  if (parts.length === 2) return `${parts[0]}, ${parts[1]}`;
  return addr || '';
}

export function buildThreadsPost(v, dealer = {}, limit = THREADS_LIMIT) {
  const h = hook(v);
  const cta = [dealer.greeting, dealer.address ? cityState(dealer.address) : ''].filter(Boolean).join(' ');

  const optional = {};
  const mileage = showableMileage(v);
  if (mileage !== null && !h.includes(`${commas(mileage)} mi`)) optional.mileage = `${commas(mileage)} miles`;
  if (v.exterior_color_factory) optional.color = String(v.exterior_color_factory);
  if (v.engine) optional.engine = String(v.engine);
  if (v.drivetrain) optional.drivetrain = String(v.drivetrain);
  if (v.carfax_one_owner) optional.carfax = 'CARFAX 1-Owner';
  if (v.vin) optional.vin = `VIN ${v.vin}`;
  if (v.stock_number) optional.stock = `Stock #${v.stock_number}`;

  let keep = ['mileage', 'carfax', 'color', 'engine', 'drivetrain', 'vin', 'stock'].filter((k) => k in optional);

  const assemble = (keys, tags) => {
    const body = keys.map((k) => optional[k]).join(' · ');
    const blocks = [h];
    if (body) blocks.push(body);
    if (cta) blocks.push(cta);
    if (tags.length) blocks.push(tags.join(' '));
    return blocks.join('\n\n');
  };

  let tags = buildHashtags(v, dealer, 6);
  for (const drop of TRIM_ORDER) {
    if (assemble(keep, tags).length <= limit) break;
    keep = keep.filter((k) => k !== drop);
  }
  while (tags.length && assemble(keep, tags).length > limit) tags = tags.slice(0, -1);
  let text = assemble(keep, tags);
  if (text.length > limit) {
    // Python: text[:limit].rsplit(" ", 1)[0].rstrip(" ·—\n")
    const cut = text.slice(0, limit);
    const i = cut.lastIndexOf(' ');
    text = (i >= 0 ? cut.slice(0, i) : cut).replace(/[ ·—\n]+$/, '');
  }
  return text + '\n';
}

export function buildInstagramCaption(v, dealer = {}) {
  const blocks = [hook(v)];

  const detail = [];
  const mileage = showableMileage(v);
  if (mileage !== null) detail.push(`Mileage: ${commas(mileage)} mi`);
  if (v.exterior_color_factory) detail.push(`Exterior: ${v.exterior_color_factory}`);
  if (v.interior_color) detail.push(`Interior: ${v.interior_color}`);
  if (v.engine) detail.push(`Engine: ${v.engine}`);
  if (v.transmission) detail.push(`Transmission: ${v.transmission}`);
  if (v.drivetrain) detail.push(`Drivetrain: ${v.drivetrain}`);
  if (v.mpg_city || v.mpg_highway) detail.push(`MPG: ${mpgPhrase(v)}`);
  else if (v.ev_mpge_combined) detail.push(`MPGe: ${v.ev_mpge_combined} combined`);
  if (v.ev_battery_range) detail.push(`EV range: ${v.ev_battery_range} mi`);
  if (v.carfax_one_owner) detail.push('CARFAX 1-Owner');
  if (v.stock_number) detail.push(`Stock #${v.stock_number}`);
  if (detail.length) blocks.push(detail.join('\n'));

  const contact = [dealer.greeting, dealer.address].filter(Boolean).join('\n');
  if (contact) blocks.push(contact);
  blocks.push(buildHashtags(v, dealer).join(' '));
  return blocks.join('\n\n') + '\n';
}

/* ---------- entry point ---------------------------------------------- */

export function buildPost(vehicle, platform, { dealer = null } = {}) {
  const v = vehicle || {};
  const d = dealer || {};
  if (platform === 'facebook') return buildFacebookPost(v, d);
  if (platform === 'instagram') return buildInstagramCaption(v, d);
  return buildThreadsPost(v, d);
}

export function buildAllPosts(vehicle, opts) {
  return Object.fromEntries(PLATFORMS.map((p) => [p, buildPost(vehicle, p, opts)]));
}

export { PLATFORMS };
