/* lotstretcher.org's one route that is not a file: /api/vdp?u=<a dealer's
 * vehicle page>. The browser cannot read another site's page, and a
 * dealer's public host answers a plain fetch with a Cloudflare challenge;
 * the dealer platform's own origin host serves the same page without
 * one. This fetches it from there and hands back the text, which the
 * browser reads with the core's listing_record, the reader the CLI uses.
 *
 * Stateless and narrow: only hosts in the spec (listing.dealers.hosts),
 * only the vehicle-page path (listing.dealers.vdpPath), GET only, a size
 * cap, ten minutes of edge cache. Nothing about the visitor is kept or
 * sent on. Every other path is a static file, served without this script
 * (wrangler.jsonc: run_worker_first). */

import spec from '../public/spec/pipeline-spec.json';

const DEALERS = spec.listing.dealers;
const VDP_PATH = new RegExp(DEALERS.vdpPath);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/* The dealer's page is text to be read, never a page on this site: plain
 * text, no sniffing, and a policy that would block any script regardless. */
const TEXT = {
  'content-type': 'text/plain; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'no-store',
};

function refuse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { ...TEXT, 'content-type': 'application/json; charset=utf-8' },
  });
}

async function vdp(request, ctx) {
  if (request.method !== 'GET') return refuse(405, 'only GET');
  let page;
  try { page = new URL(new URL(request.url).searchParams.get('u') || ''); } catch { return refuse(400, 'not an address'); }
  const origin = DEALERS.hosts[page.hostname.toLowerCase()];
  if (!origin) return refuse(404, `lotstretcher cannot read ${page.hostname} yet`);
  if (!VDP_PATH.test(page.pathname)) return refuse(400, 'not a vehicle page');

  const source = new Request(`https://${origin}${page.pathname}`, { headers: { 'user-agent': UA, accept: 'text/html' } });
  const cache = caches.default;
  let hit = await cache.match(source);
  if (!hit) {
    const got = await fetch(source, { redirect: 'follow' });
    if (got.status === 404 || got.status === 410) return refuse(404, 'the dealer no longer lists this vehicle');
    if (!got.ok) return refuse(502, `the dealer's site answered ${got.status}`);
    const html = await got.text();
    if (html.length > DEALERS.maxBytes) return refuse(502, 'the page is larger than a vehicle page should be');
    hit = new Response(html, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${DEALERS.cacheSeconds}` } });
    ctx.waitUntil(cache.put(source, hit.clone()));
  }
  return new Response(hit.body, { headers: TEXT });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/vdp') return vdp(request, ctx);
    if (pathname.startsWith('/api/')) return refuse(404, 'no such route');
    return env.ASSETS.fetch(request);
  },
};
