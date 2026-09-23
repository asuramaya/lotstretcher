/* Handing a composition to a self-hosted server.
 *
 * Six controls (upscale, photo backdrop, frame, border, music, GPU
 * encode) are real capabilities of a self-hosted install that a browser
 * cannot do alone. This is the handoff the Options pane used to say was
 * missing.
 *
 * WHAT IS SENT: the CUTOUT, never the source photograph. Matting already
 * happened on the device, so the original image stays there. Only the
 * cut-out vehicle travels, and only when the user asks for something
 * this server can do and a browser cannot. On lotstretcher.org none of
 * this is reachable, because there is no server to reach.
 *
 * The body is effectively the CLI flag set: the control values serialise
 * straight across because every control in the spec carries the flag it
 * maps to. */

import { isSelfHosted } from '../host.js';
import { loadLibrary, library, isLocal } from './library.js';

/* Controls that can only be honoured by a server. Derived from the spec
 * rather than listed here, so adding one to the spec is enough. */
export function serverOnlyKeys(specGet) {
  const keys = [];
  for (const group of specGet('controls', 'groups')) {
    for (const control of group.controls) {
      const surfaces = control.surfaces || ['browser', 'cli', 'server'];
      if (!surfaces.includes('browser')) keys.push(control.key);
    }
  }
  return keys;
}

/* Does this run need the server?
 *
 * Only when the user actually switched one of those controls on. A
 * self-hosted user who changes nothing still composes locally, which is
 * faster and keeps the round trip out of the common path. */
export function needsServer(options, specGet) {
  if (!isSelfHosted()) return false;
  const on = (value) => value !== undefined && value !== null && value !== false && value !== '';
  if (serverOnlyKeys(specGet).some((key) => on(options[key]))) return true;
  // A stock frame or backdrop the site ships composes here; one only
  // the server's library holds goes to the server. The Frame picker's
  // own values are "none" and "custom"; anything else names a frame.
  if (options.border && !['none', 'custom'].includes(options.border) && !isLocal('borders', options.border)) return true;
  if (options.backdrop === 'asset' && !isLocal('backgrounds', options.background)) return true;
  /* A browser-capable select can still hold one choice the browser
   * cannot honour, and picking it is what sends the run to the server. */
  for (const group of specGet('controls', 'groups')) {
    for (const control of group.controls) {
      const choice = (control.choices || []).find((c) => c.value === options[control.key]);
      if (choice?.requires) return true;
    }
  }
  return false;
}

/* The asset library: the site's own studio plus whatever a self-hosted
 * server adds. See lib/library.js. */
export const loadAssets = loadLibrary;
export const assets = library;

/* Ask the server to read a vehicle page. Returns the same record shape
 * the bookmarklet's normaliser produces (scrape.Vehicle), so the caller
 * fills the form the same way whichever route the listing came in by. */
export async function scrapeOnServer(url, { signal } = {}) {
  const res = await fetch('scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

/* Library management on a self-hosted server. Each of these is a thing
 * a process with the folder can do and a browser cannot; the Library
 * pane offers them only when the host reports the capability. */
async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

export const libraryOps = {
  async status() {
    const res = await fetch('library/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  },
  /* Rebuild one vehicle's bundle with the app's current control values:
   * the same rebuild the `recompose` CLI does. Returns a job to poll. */
  recompose(v, options) {
    return postJson(`library/${encodeURIComponent(v.bucket)}/${encodeURIComponent(v.folder)}/recompose`, { options });
  },
  /* Fetch the vehicle's page again and run the whole pipeline: the
   * `lotstretcher <url> --force` of the Library pane. */
  rescrape(v, options) {
    return postJson(`library/${encodeURIComponent(v.bucket)}/${encodeURIComponent(v.folder)}/rescrape`, { options });
  },
  delist(v) {
    return postJson(`library/${encodeURIComponent(v.bucket)}/${encodeURIComponent(v.folder)}/delist`);
  },
  /* For good. The server demands the folder name back as confirmation. */
  remove(v) {
    return postJson(`library/${encodeURIComponent(v.bucket)}/${encodeURIComponent(v.folder)}/delete`, { confirm: v.folder });
  },
  async runs(limit = 500) {
    const res = await fetch(`library/runs?limit=${limit}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()).runs;
  },
  sync() { return postJson('library/sync'); },
  async job(id) {
    const res = await fetch(`jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  },
  /* Poll until the job settles. */
  async wait(id, onTick, intervalMs = 1500) {
    for (;;) {
      const job = await this.job(id);
      onTick?.(job);
      if (job.status !== 'running') return job;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  },
};

/* Compose one cutout on the server.
 *
 * Returns { blob, warnings }. Warnings are things the server could not
 * honour, such as a border that no longer exists in its library; they
 * arrive on a header because the body is the image. Dropping them would
 * turn a control into something that quietly does nothing, which is the
 * failure this whole surface keeps being careful about.
 */
export async function composeOnServer(cutoutCanvas, options, { signal } = {}) {
  const blob = await new Promise((resolve) => {
    if (cutoutCanvas.convertToBlob) resolve(cutoutCanvas.convertToBlob({ type: 'image/png' }));
    else cutoutCanvas.toBlob(resolve, 'image/png');
  });

  const form = new FormData();
  form.append('cutout', blob, 'cutout.png');
  form.append('options', JSON.stringify(options));

  const res = await fetch('compose', { method: 'POST', body: form, signal });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(`server could not compose: ${detail}`);
  }

  const warningHeader = res.headers.get('X-Lotstretcher-Warning') || '';
  return {
    blob: await res.blob(),
    warnings: warningHeader ? warningHeader.split('; ').filter(Boolean) : [],
  };
}
