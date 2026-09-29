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
