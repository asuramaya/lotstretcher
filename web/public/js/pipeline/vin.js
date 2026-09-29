/* What a VIN says on its own, decoded on this device from the spec's
 * tables: whether it is well formed (the check digit), the model year,
 * the manufacturer (the first three characters) and the country. Model
 * and trim are encoded per manufacturer and are not here; a listing
 * address carries them in its slug. Nothing is fetched and nothing
 * leaves the device.
 *
 * The decoder is the core's (core/src/vin.rs), the same code the CLI's
 * lotstretcher/vin.py calls; tests/test_vin_parity.py holds both builds
 * to one reference. */

import { call } from '../core.js';

/* {vin, valid, year, make, country, warnings}, plus `makes` when one
 * manufacturer code spans brands. */
export function decode(text) {
  return call({ op: 'vin_decode', text: String(text || '') });
}

export function normalize(text) { return decode(text).vin; }

/* What the app fills from a pasted address or VIN, in the
 * scrape.Vehicle shape the form reads. */
export function recordFromText(text) {
  return call({ op: 'vin_record', text: String(text || '') });
}
