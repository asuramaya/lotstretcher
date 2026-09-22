/* What the app is running against.
 *
 * ONE APP, TWO HOSTS. The same web/public is served by lotstretcher.org
 * (static, on a CDN) and by the self-hosted server. There is no second
 * build and no forked "server edition": a fix lands in both because they
 * are the same files.
 *
 * What differs is CAPABILITIES. Self-hosted has a Python process behind
 * it, so it can scrape, reach a filesystem, batch, and use a GPU. The
 * app asks the host what it can do and unlocks accordingly, which keeps
 * the gated features in the same source as everything else instead of
 * splitting the codebase to hold them.
 *
 * Deliberately capability-shaped, not edition-shaped: the app asks "can
 * I scrape?", never "am I the paid version?". Adding a capability then
 * never means teaching the client about a new tier. */

/* The static host. Everything a browser can do alone, nothing that needs
 * a process. This is also the safe default when the probe fails: a
 * missing answer must never unlock something. */
const STATIC_HOST = {
  host: 'static',
  scrape: false,
  inventorySync: false,
  batch: false,
  filesystem: false,
  windowStickerFetch: false,   // CORS-dependent, so not guaranteed
  upscale: false,
  nvenc: false,
  outDir: null,
  servingWebApp: true,
};

let caps = null;

/* Ask the host. A 404 is the expected answer on the CDN, not an error:
 * static hosting has no /capabilities, which is itself the answer. */
export async function loadCapabilities() {
  if (caps) return caps;
  try {
    const res = await fetch('capabilities', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    // Merge over the static baseline so a host that omits a key gets the
    // locked-down value rather than undefined.
    caps = { ...STATIC_HOST, ...body };
  } catch {
    caps = { ...STATIC_HOST };
  }
  return caps;
}

export function can(feature) {
  if (!caps) return STATIC_HOST[feature] ?? false;
  return caps[feature] ?? false;
}

export function host() {
  return caps?.host ?? 'static';
}

export function isSelfHosted() {
  return host() === 'self-hosted';
}

export function capabilities() {
  return caps ? { ...caps } : { ...STATIC_HOST };
}

/* Why a feature is unavailable, taken from the shared spec so the
 * explanation lives with the rest of the parity data rather than being
 * written twice. */
export function whyUnavailable(feature, specGet) {
  try {
    const reasons = specGet('browserUnsupported');
    if (reasons[feature]) return reasons[feature];
  } catch { /* spec not loaded */ }
  return 'Available when you run lotstretcher on your own machine.';
}
