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

export async function loadCore() {
  if (mod) return mod;
  if (loading) return loading;
  loading = (async () => {
    try {
      const m = await import('../core/lotstretcher_core.js');
      await m.default();
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
export function whyUnavailable() { return failure ? String(failure.message || failure) : null; }
export function version() { return mod ? mod.version() : null; }

/* Pack RGBA/RGB ImageData objects into one arena and describe each. */
function arena(images) {
  let total = 0;
  for (const img of images) total += img.data.length;
  const buf = new Uint8Array(total);
  const slices = [];
  let offset = 0;
  for (const img of images) {
    buf.set(img.data, offset);
    slices.push({ offset, len: img.data.length, width: img.width, height: img.height, channels: img.channels || 4 });
    offset += img.data.length;
  }
  return { buf, slices };
}

/* Compose one hero. `cars` are ImageData (RGBA), hero first. Returns
 * an ImageData of the RGB canvas expanded to RGBA for putImageData. */
export function composeHero(cars, width, height, background, {
  layout = 'single', spotlight = true, glow = false, glowColor = null,
  glowRadius = null, glowIntensity = null, marginFrac = null, backgroundImage = null, border = null,
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
  };
  if (border) { width = border.width; height = border.height; }
  const rgb = mod.compose_hero(JSON.stringify(req), buf);
  const out = new ImageData(width, height);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out.data[j] = rgb[i]; out.data[j + 1] = rgb[i + 1]; out.data[j + 2] = rgb[i + 2]; out.data[j + 3] = 255;
  }
  return out;
}

export function vehicleGradientColors(exterior, interior, sample) {
  if (!mod) throw new Error('core not loaded; await loadCore() first');
  const v = mod.vehicle_gradient_colors(exterior ?? undefined, interior ?? undefined,
    sample ? sample.data : new Uint8Array(0), sample ? sample.width : 0, sample ? sample.height : 0);
  return [[v[0], v[1], v[2]], [v[3], v[4], v[5]]];
}
