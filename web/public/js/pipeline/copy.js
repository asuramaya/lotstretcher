/* Post copy for each platform: the long Marketplace post, the Threads
 * post and the Instagram caption, built by the core (core/src/copy.rs),
 * the same code the CLI's facebook_post.py and social_post.py call.
 *
 * This file used to be its own algorithm, then a line-for-line port of
 * the Python held together by a parity test. Two generators for one job
 * is the drift the whole surface exists to remove, so now there is one:
 * anything editorial (what leads, what gets dropped when the budget runs
 * out, which tags) is decided once, in the core, and documented in the
 * Python modules' docstrings.
 *
 * Deterministic, no model, no key, no network. Nothing here invents a
 * claim: every value is a scraped, stickered or typed field; the only
 * decisions are ordering and what to drop.
 *
 * `dealer` is the app's stand-in for dealer_config: { name, greeting,
 * address, city_tags }. The CLI always has a greeting and an address from
 * its config; here they may be unset, and an unset line is omitted rather
 * than printed blank. */

import { call } from '../core.js';

const PLATFORMS = ['facebook', 'instagram', 'threads'];

export function vehicleTitle(v) {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ').trim();
}

/* Every platform's post, plus the hashtags and the audit trail of which
 * condition-dependent branch fired (the CLI writes that into
 * details.json as _facebook_post_notes). */
export function buildPosts(vehicle, { dealer = null } = {}) {
  const d = dealer || {};
  return call({
    op: 'build_posts',
    vehicle: vehicle || {},
    dealer: { greeting: d.greeting || null, address: d.address || null, city_tags: d.city_tags || [] },
  });
}

export function buildPost(vehicle, platform, opts) {
  return buildPosts(vehicle, opts)[platform];
}

export function buildAllPosts(vehicle, opts) {
  const posts = buildPosts(vehicle, opts);
  return Object.fromEntries(PLATFORMS.map((p) => [p, posts[p]]));
}

export function buildHashtags(vehicle, opts) {
  return buildPosts(vehicle, opts).hashtags;
}

export { PLATFORMS };
