/* The Rust core, compiled to wasm32: the same source the CLI and server
 * load natively (core/, loaded by src/lotstretcher/core.py). Compositing
 * runs here now; compose.js is a thin host that packs canvases into a
 * byte arena and unpacks the result.
 *
 * Loaded once, lazily, from core/lotstretcher_core.js (wasm-bindgen's
 * web target, built by web/build-core.sh). `available()` says whether
 * it loaded; the app reports that in About so a failure is visible
 * rather than a silent fallback, of which there is none. */

let mod = null;
let loading = null;
let failure = null;

let threads = 0;

/* `source` is optional: the wasm bytes (or a Response/URL) for code
 * running outside a page, such as the parity tests under node, which
 * cannot fetch the module relative to this file.
 *
 * Two builds ship. The threaded one (core-threads/, rayon over web
 * workers) is used when the page is cross-origin isolated, which the
 * app already needs for ORT's threads; it spreads every row loop in
 * the core across the cores. Anything else, including node and a page
 * served without the isolation headers, gets the plain build, which
 * produces the same bytes on one thread. */
export async function loadCore(source) {
  if (mod) return mod;
  if (loading) return loading;
  loading = (async () => {
    // The threaded build is not shipped yet: its wasm memory is not
    // created shared, so the pool's workers refuse it (DataCloneError
    // on the Memory). Until the build is fixed the loader never tries
    // it; the plain build is complete on its own.
    const THREADED_BUILD = false;
    const wantThreads = THREADED_BUILD && source === undefined && typeof window !== 'undefined'
      && self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    if (wantThreads) {
      try {
        const m = await import('../core-threads/lotstretcher_core.js');
        await m.default();
        const n = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2));
        await m.initThreadPool(n);
        threads = n;
        mod = m;
        return m;
      } catch (e) {
        console.warn('threaded core unavailable, using the plain build:', e);
      }
    }
    try {
      const m = await import('../core/lotstretcher_core.js');
      await m.default(source === undefined ? undefined : { module_or_path: source });
      mod = m;
      return m;
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function available() { return mod !== null; }
/* How many worker threads the core runs on; 0 for the plain build. */
export function threadCount() { return threads; }
export function whyUnavailable() { return failure ? String(failure.message || failure) : null; }
export function version() { return mod ? mod.version() : null; }

/* Pack RGBA/RGB ImageData objects into one arena and describe each. A
 * number is the id of an image the core already holds (see retain) and
 * travels as that id, with no bytes. */
function arena(images) {
  let total = 0;
  for (const img of images) if (typeof img !== 'number') total += img.data.length;
  const buf = new Uint8Array(total);
  const slices = [];
  let offset = 0;
  for (const img of images) {
    if (typeof img === 'number') { slices.push({ retained: img }); continue; }
    buf.set(img.data, offset);
    slices.push({ offset, len: img.data.length, width: img.width, height: img.height, channels: img.channels || 4 });
    offset += img.data.length;
  }
  return { buf, slices };
}

/* Keep an image inside the core and get its id: every op then takes the
 * id wherever it takes an image, and its pixels never cross into wasm
 * memory again. Pair with release; a clip's worth of scaled cars is a
 * few tens of MB. */
/* A font's bytes, kept in the core under a name. They travel through
 * the arena as a one-row single-channel image, the shape it carries. */
export function loadFont(name, bytes) {
  const carrier = { width: bytes.length, height: 1, channels: 1, data: bytes };
  return call({ op: 'load_font', name, data: { $image: 0 } }, [carrier]);
}

/* Text overlays for one canvas from the vehicle and the Text controls
 * (core/src/text.rs::plan). The font must be loaded first. */
export function overlayPlan(width, height, vehicle, text) {
  return call({ op: 'overlay_plan', width, height, vehicle: vehicle || {}, ...text });
}

export function retain(image) { return call({ op: 'retain', image: { $image: 0 } }, [image]); }
export function release(id) { return call({ op: 'release', id }); }
export function releaseAll() { return call({ op: 'release_all' }); }

/* Compose one hero. `cars` are ImageData (RGBA), hero first. Returns
 * an ImageData of the RGB canvas expanded to RGBA for putImageData. */
export function composeHero(cars, width, height, background, {
  layout = 'single', spotlight = true, glow = false, glowColor = null,
  glowRadius = null, glowIntensity = null, marginFrac = null, backgroundImage = null, border = null,
  borderFit = null, overlays = [], text = null,
} = {}) {
  if (!mod) throw new Error('core not loaded; await loadCore() first');
  const images = [...cars];
  const bg = { ...background };
  let bgIndex = null;
  let borderIndex = null;
  if (bg.kind === 'image') {
    if (!backgroundImage) throw new Error("background kind 'image' needs backgroundImage");
    bgIndex = images.length;
    images.push(backgroundImage);
  }
  if (border) { borderIndex = images.length; images.push(border); }
  const { buf, slices } = arena(images);
  if (bgIndex !== null) bg.image = slices[bgIndex];
  const req = {
    width, height, background: bg, cars: slices.slice(0, cars.length), layout, spotlight, glow,
    glow_color: glowColor, glow_radius: glowRadius, glow_intensity: glowIntensity, margin_frac: marginFrac,
    border: borderIndex !== null ? slices[borderIndex] : null,
    border_fit: borderFit, overlays, text,
  };
  const rgb = mod.compose_hero(JSON.stringify(req), buf);
  const out = new ImageData(width, height);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out.data[j] = rgb[i]; out.data[j + 1] = rgb[i + 1]; out.data[j + 2] = rgb[i + 2]; out.data[j + 3] = 255;
  }
  return out;
}

/* The general entry point. `op` is an object with an `op` field (see
 * core/src/frame.rs::Op); ImageData values it refers to are passed in
 * `images` and referenced as {$image: i}. Image results come back as
 * {width, height, channels, data}; scalar results as their value. */
export function call(op, images = []) {
  if (!mod) throw new Error('core not loaded; await loadCore() first');
  const { buf, slices } = arena(images);
  const bind = (node) => {
    if (Array.isArray(node)) return node.map(bind);
    if (node && typeof node === 'object') {
      if ('$image' in node) return slices[node.$image];
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = bind(v);
      return out;
    }
    return node;
  };
  const res = mod.call(JSON.stringify(bind(op)), buf);
  if (res.kind === 'json') return JSON.parse(res.text).value;
  return res;
}

/* An RGB core image as ImageData, for putImageData. */
export function toImageData(res) {
  const out = new ImageData(res.width, res.height);
  if (res.channels === 4) { out.data.set(res.data); return out; }
  for (let i = 0, j = 0; i < res.data.length; i += 3, j += 4) {
    out.data[j] = res.data[i]; out.data[j + 1] = res.data[i + 1]; out.data[j + 2] = res.data[i + 2]; out.data[j + 3] = 255;
  }
  return out;
}

/* One video frame. `cars` are {image: ImageData, x, y, w, h, alpha},
 * optionally with mix: {image: ImageData, t} to dissolve the car toward
 * another same-sized image before it is pasted. */
export function renderFrame(cars, width, height, background, {
  border = null, spotlight = null, glow = false, glowColor = null, glowRadius = null,
  glowIntensity = null, resample = 'lanczos', backgroundImage = null, overlays = [],
} = {}) {
  const images = cars.map((c) => c.image);
  const bg = { ...background };
  const op = {
    op: 'render_frame', width, height, background: bg,
    cars: cars.map((c, i) => ({ image: { $image: i }, x: c.x, y: c.y, w: c.w, h: c.h, alpha: c.alpha ?? 1 })),
    glow, glow_color: glowColor, glow_radius: glowRadius, glow_intensity: glowIntensity, resample,
    rgba: true, overlays,
  };
  cars.forEach((c, i) => {
    if (c.mix) { op.cars[i].mix = { image: { $image: images.length }, t: c.mix.t }; images.push(c.mix.image); }
  });
  if (bg.kind === 'image') { bg.image = { $image: images.length }; images.push(backgroundImage); }
  if (border) { op.border = { $image: images.length }; images.push(border); }
  if (spotlight) op.spotlight = spotlight;
  return toImageData(call(op, images));
}

export function vehicleGradientColors(exterior, interior, sample) {
  if (!mod) throw new Error('core not loaded; await loadCore() first');
  const v = mod.vehicle_gradient_colors(exterior ?? undefined, interior ?? undefined,
    sample ? sample.data : new Uint8Array(0), sample ? sample.width : 0, sample ? sample.height : 0);
  return [[v[0], v[1], v[2]], [v[3], v[4], v[5]]];
}

/* An interior photo, neutralised and lifted by the core (the CLI's
 * bundle/interior treatment): a canvas or bitmap in, a canvas of the
 * same size out. Nothing is cropped or composited. */
export function enhanceInterior(source) {
  const w = source.width; const h = source.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const out = call({ op: 'enhance_interior', image: { $image: 0 } }, [ctx.getImageData(0, 0, w, h)]);
  ctx.putImageData(toImageData(out), 0, 0);
  return c;
}
