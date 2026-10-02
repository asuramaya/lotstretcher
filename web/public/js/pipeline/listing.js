/* Reading a listing on the device: the browser's answer to
 * `lotstretcher <VDP url>`.
 *
 * The CLI scrapes a vehicle page with a headless browser; a browser on
 * lotstretcher.org cannot read another site's page (and the page sits
 * behind a bot challenge that a plain fetch never passes), so the same
 * reader runs here on a SAVED copy of the page or its pasted source: no
 * network, nothing leaves the device. The address itself is read by
 * pipeline/vin.js, which needs no page at all.
 *
 * The reader is the core's (core/src/listing.rs), the code the CLI's
 * scrape.normalize_vehicle calls; tests/test_listing_parity.py holds both
 * builds to the records the Python gave before it was deleted. */

import { call } from '../core.js';
import { get as specGet } from '../spec.js';

/* A listed dealer's vehicle page, read through the site's /api/vdp route
 * (web/src/worker.js), which fetches it from the dealer platform's origin
 * host: the record, with the dealer's own address kept as its url. Null
 * when the host is not one the route reads (spec listing.dealers) or the
 * route is not there (the dev server, a self-hosted server); a refusal
 * from the route throws its reason. */
export async function fetchListing(url) {
  let page;
  try { page = new URL(url); } catch { return null; }
  const dealers = specGet('listing', 'dealers');
  if (!dealers.hosts[page.hostname.toLowerCase()] || !new RegExp(dealers.vdpPath).test(page.pathname)) return null;
  let res;
  try { res = await fetch(`/api/vdp?u=${encodeURIComponent(page.href)}`); } catch { return null; }
  if (res.status === 404 && !(res.headers.get('content-type') || '').includes('json')) return null;
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `the page could not be read (${res.status})`);
  const record = recordFromHtml(await res.text(), page.href);
  return describesVehicle(record) ? record : null;
}

/* The Vehicle record (the CLI dataclass's own field names) a page's
 * HTML describes. With no `url`, the page's canonical address is used. */
export function recordFromHtml(html, url = null) {
  return call({ op: 'listing_record', html: String(html || ''), url });
}

/* Whether the page held a vehicle at all: the analytics blob or a
 * schema.org Car node gives at least one of these. */
export function describesVehicle(record) {
  return !!(record && (record.vin || record.title || record.photo_urls.length));
}
