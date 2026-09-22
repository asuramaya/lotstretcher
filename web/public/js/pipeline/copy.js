/* Post copy for each platform.
 *
 * Deterministic templates, no model, no key, no network -- the Tier 0
 * equivalent for text. Tier 2 (an LLM with the user's own API key)
 * rewrites these; it does not replace the need for them, because the
 * default path has to work with nothing configured.
 *
 * Variety is seeded per vehicle rather than random, for the same reason
 * the backdrops are: a rerun should reproduce, and "every post opens
 * with the same sentence" is what makes a feed look automated. */

const PLATFORMS = ['facebook', 'instagram', 'threads'];

function pick(list, seed, salt = 0) {
  let h = 2166136261 >>> 0;
  const s = String(seed) + '|' + salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return list[h % list.length];
}

const OPENERS = [
  'Just landed.',
  'New arrival.',
  'Fresh on the lot.',
  'Now available.',
  'Just in.',
];

const CLOSERS = [
  'Come take a look.',
  'Stop by for a test drive.',
  'Message us to set up a drive.',
  'Ask us anything.',
  'Available now — reach out.',
];

export function vehicleTitle(v) {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ').trim();
}

function formatPrice(price) {
  if (price === null || price === undefined || price === '') return null;
  const n = typeof price === 'number' ? price : Number(String(price).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function detailLines(v) {
  const out = [];
  if (v.mileage) {
    const n = Number(String(v.mileage).replace(/[^0-9]/g, ''));
    if (Number.isFinite(n) && n > 0) out.push(`${n.toLocaleString('en-US')} miles`);
  }
  if (v.exterior_color) out.push(`${v.exterior_color} exterior`);
  if (v.interior_color) out.push(`${v.interior_color} interior`);
  if (v.drivetrain) out.push(v.drivetrain);
  if (v.transmission) out.push(v.transmission);
  if (v.engine) out.push(v.engine);
  return out;
}

function hashtags(v) {
  const tags = ['#' + String(v.make || '').replace(/\W/g, '')];
  if (v.model) tags.push('#' + String(v.model).replace(/\W/g, ''));
  if (v.make && v.model) tags.push('#' + String(v.make + v.model).replace(/\W/g, ''));
  tags.push('#carsofinstagram', '#newcar', '#dealership');
  return tags.filter((t) => t.length > 1);
}

/* Build copy for one platform. The differences are real ones -- a
 * Facebook post can carry a spec list and a long body, Instagram leans
 * on hashtags, and Threads has a 500-character ceiling that a long spec
 * list will blow straight through. */
export function buildPost(vehicle, platform, { dealer = null } = {}) {
  const v = vehicle || {};
  const title = vehicleTitle(v) || 'This vehicle';
  const seed = v.vin || v.stock_number || title;
  const opener = pick(OPENERS, seed, 1);
  const closer = pick(CLOSERS, seed, 2);
  const price = formatPrice(v.price);
  const details = detailLines(v);

  if (platform === 'facebook') {
    const lines = [`${opener} ${title}.`];
    if (price) lines.push('', price);
    if (details.length) lines.push('', ...details.map((d) => `• ${d}`));
    if (v.vin) lines.push('', `VIN: ${v.vin}`);
    if (v.stock_number) lines.push(`Stock #: ${v.stock_number}`);
    if (dealer?.name) lines.push('', dealer.name);
    if (dealer?.phone) lines.push(dealer.phone);
    lines.push('', closer);
    return lines.join('\n');
  }

  if (platform === 'instagram') {
    const lines = [`${opener} ${title}${price ? ` — ${price}` : ''}.`];
    if (details.length) lines.push('', details.slice(0, 4).join(' · '));
    lines.push('', closer);
    if (dealer?.name) lines.push('', dealer.name);
    lines.push('', hashtags(v).join(' '));
    return lines.join('\n');
  }

  // Threads: hard 500-character limit. Build shortest-first and stop
  // adding once the next piece would not fit, rather than truncating
  // mid-word at the end.
  const head = `${opener} ${title}${price ? ` — ${price}` : ''}.`;
  let body = head;
  for (const d of details.slice(0, 3)) {
    const next = `${body}\n${d}`;
    if (next.length + closer.length + 2 > 500) break;
    body = next;
  }
  return `${body}\n\n${closer}`.slice(0, 500);
}

export function buildAllPosts(vehicle, opts) {
  return Object.fromEntries(PLATFORMS.map((p) => [p, buildPost(vehicle, p, opts)]));
}

export { PLATFORMS };
