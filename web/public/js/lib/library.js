/* The studio library: the stock backgrounds and frames the app offers.
 *
 * Two sources, one list. The site ships its own library under studio/
 * (built by web/build-studio.py from assets/manifest.json), so "Stock"
 * composes on this device on lotstretcher.org with nothing behind it. A
 * self-hosted server adds whatever else its assets/ holds, such as a
 * dealer's private frames; those are composed by the server, since only
 * it has the file. An entry says which it is (`local`), and that is the
 * whole difference the rest of the app sees.
 *
 * Names are the manifest's: the "American Flag" tile and the CLI's
 * --background "American Flag" find the same file by the same string. */

import { isSelfHosted } from '../host.js';

const EMPTY = () => ({ backgrounds: [], borders: [], videos: [], audio: [], fonts: [] });
let lib = null;
const images = new Map();   // "kind/name" -> canvas | null (loading) | undefined

function serverEntry(kind, e) {
  const name = encodeURIComponent(e.value);
  return {
    ...e,
    local: false,
    // The server draws its own picture of the asset at any size; the
    // preview wants it near its own size, the tile small.
    src: `assets/thumb/${kind}/${name}?size=1024`,
    thumb: `assets/thumb/${kind}/${name}?size=192`,
  };
}

export async function loadLibrary() {
  if (lib) return lib;
  lib = EMPTY();
  try {
    const res = await fetch('studio/manifest.json', { cache: 'no-store' });
    if (res.ok) {
      const studio = await res.json();
      for (const f of studio.fonts || []) {
        lib.fonts.push({ name: f.name, src: `studio/${f.file}`, license: f.license ? `studio/${f.license}` : null });
        // The same file the core draws with, as a page font too, so a
        // font's name can be shown in its own face. Fetched on first
        // use, not here.
        try {
          if (typeof FontFace !== 'undefined' && document?.fonts) document.fonts.add(new FontFace(f.name, `url(studio/${f.file})`));
        } catch { /* no page fonts: the names show in the UI font */ }
      }
      for (const kind of ['backgrounds', 'borders']) {
        for (const e of studio[kind] || []) {
          // A hosted entry names where it lives (a CDN with CORS open
          // to the site); it composes here all the same.
          const src = e.url || `studio/${e.file}`;
          lib[kind].push({
            value: e.name, label: e.name, tags: e.tags || [], local: true, category: e.category || null,
            src, thumb: src, width: e.width, height: e.height,
          });
        }
      }
    }
  } catch { /* no studio folder: the list is whatever the server offers */ }
  if (isSelfHosted()) {
    try {
      const res = await fetch('assets', { cache: 'no-store' });
      if (res.ok) {
        const server = await res.json();
        for (const kind of Object.keys(lib)) {
          for (const e of server[kind] || []) {
            // The site's copy wins a name clash: it composes here.
            if (lib[kind].some((x) => x.value === e.value)) continue;
            lib[kind].push(kind === 'backgrounds' || kind === 'borders' ? serverEntry(kind, e) : { ...e, local: false });
          }
        }
      }
    } catch { /* the server's list is a bonus, not a requirement */ }
  }
  return lib;
}

export function library() {
  return lib || EMPTY();
}

export function entry(kind, name) {
  return library()[kind]?.find((e) => e.value === name) || null;
}

/* Is this stock asset one the browser can compose with itself? */
export function isLocal(kind, name) {
  return !!entry(kind, name)?.local;
}

/* The asset as a canvas, fetched once. `onReady` fires when a fetch in
 * flight lands, so a preview can redraw; the return is null until then. */
export function imageNow(kind, name, onReady) {
  const e = entry(kind, name);
  if (!e) return null;
  const key = `${kind}/${name}`;
  if (images.has(key)) return images.get(key);
  images.set(key, null);
  image(kind, name).then(() => onReady?.());
  return null;
}

export async function image(kind, name) {
  const e = entry(kind, name);
  if (!e) return null;
  const key = `${kind}/${name}`;
  const have = images.get(key);
  if (have) return have;
  try {
    const r = await fetch(e.src);
    if (!r.ok) throw new Error(String(r.status));
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    images.set(key, c);
    return c;
  } catch {
    images.delete(key);
    return null;
  }
}
