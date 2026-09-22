/* Vehicle-derived backdrop colors.
 *
 * A direct port of imaging/palette.py. This is the Tier 0 default
 * background: no API key, no asset library, no network call, and nothing
 * to download. It derives a two-stop gradient from the vehicle's own
 * paint, so every post gets a different backdrop that still belongs to
 * its car.
 *
 * That "different every time" property is the entire point. A single
 * shared backdrop image is what previously got posts flagged.
 *
 * Kept deliberately faithful to the Python, including the comments that
 * explain non-obvious constants -- if one side changes, the other has to
 * change with it, and a reader needs to be able to diff them. */

/* Base color words, matched longest-first so "dark blue" does not hit a
 * shorter substring first. Values are muted on purpose: these become a
 * BACKDROP, and a fully saturated primary behind a car reads as a
 * clip-art collage. */
export const COLOR_WORDS = {
  black: [26, 26, 30], white: [232, 233, 236], silver: [188, 190, 195],
  platinum: [198, 200, 204], gray: [124, 127, 132], grey: [124, 127, 132],
  charcoal: [62, 64, 69], graphite: [78, 81, 86], carbonized: [88, 91, 96],
  gunmetal: [84, 88, 94], slate: [98, 106, 118], steel: [110, 122, 138],
  navy: [26, 42, 88], blue: [38, 84, 168], teal: [30, 118, 128],
  turquoise: [48, 150, 156], aqua: [60, 150, 160], cyan: [50, 150, 170],
  green: [40, 112, 72], olive: [98, 104, 60], lime: [120, 160, 60],
  red: [168, 34, 44], maroon: [108, 30, 46], burgundy: [100, 28, 48],
  crimson: [152, 28, 48], ruby: [150, 30, 52], rose: [180, 90, 105],
  pink: [198, 110, 140], purple: [96, 60, 142], violet: [104, 66, 150],
  orange: [206, 108, 38], amber: [198, 140, 46], gold: [176, 144, 70],
  yellow: [214, 184, 56], bronze: [136, 98, 60], copper: [166, 100, 58],
  brown: [92, 64, 46], espresso: [72, 52, 42], chestnut: [110, 70, 50],
  tan: [188, 160, 124], beige: [196, 178, 148], sand: [196, 180, 150],
  stone: [168, 164, 154], cream: [218, 208, 186], ivory: [222, 214, 196],
};

const WORDS_BY_LENGTH = Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length);

/* Where backdrop colors are allowed to land. Cutouts are overwhelmingly
 * white/silver/grey vehicles, so a light backdrop flattens them; every
 * sampled color is compressed into this value band regardless of how
 * bright the paint actually is. Hue survives, which is what carries
 * "this is that vehicle's color". */
const BACKDROP_VALUE_MIN = 0.10;
const BACKDROP_VALUE_MAX = 0.52;
const MIN_STOP_SEPARATION = 0.14;
const NEUTRAL_SATURATION_CEILING = 0.10;
const MATCHING_HUE_SHIFT = 0.055;
const NEUTRAL_TINT_HUE = 0.60;
const NEUTRAL_TINT_SATURATION = 0.30;
const BACKDROP_SATURATION_RANGE = [0.28, 0.78];

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  s = Math.min(1, Math.max(0, s));
  v = Math.min(1, Math.max(0, v));
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/* RGB for the first base color word in a marketing name, or null if the
 * name is pure branding. "Avalanche" and "Carbonized" are both real
 * examples of names with no color word in them at all. */
export function parseColorName(name) {
  if (!name) return null;
  const lowered = String(name).toLowerCase();
  for (const word of WORDS_BY_LENGTH) {
    if (lowered.includes(word)) return COLOR_WORDS[word];
  }
  return null;
}

/* The vehicle's paint color, measured off a cutout.
 *
 * Takes the median of the BRIGHTER half of the opaque pixels, not of all
 * of them: a cutout is maybe a third glass, tire and shadow, and a plain
 * median drags any paint color toward near-black. Median rather than
 * mean so remaining dark trim and specular highlights do not pull it
 * either way. */
export function sampleCutoutColor(imageData) {
  const { data } = imageData;
  const vals = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 200) vals.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (vals.length < 50) return null;

  const value = vals.map((c) => Math.max(c[0], c[1], c[2]));
  const sorted = [...value].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  let bright = vals.filter((_, i) => value[i] >= p50);
  if (bright.length < 20) bright = vals;

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return [0, 1, 2].map((ch) => Math.round(median(bright.map((c) => c[ch]))));
}

function toBackdrop(rgb) {
  let [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  if (s > NEUTRAL_SATURATION_CEILING) {
    const [lo, hi] = BACKDROP_SATURATION_RANGE;
    s = Math.min(Math.max(s, lo), hi);
  }
  v = BACKDROP_VALUE_MIN + v * (BACKDROP_VALUE_MAX - BACKDROP_VALUE_MIN);
  return [h, s, v];
}

/* (exteriorStop, interiorStop) as backdrop-safe RGB.
 *
 * Exterior falls back to measuring the cutout when its name carries no
 * color word. Interior has no equivalent fallback -- there is no
 * interior cutout to measure -- and defaults to near-black, which is
 * what the overwhelming majority of them actually are. */
export function vehicleGradientColors(exterior, interior, cutoutImageData = null) {
  let ext = parseColorName(exterior);
  if (!ext && cutoutImageData) ext = sampleCutoutColor(cutoutImageData);
  if (!ext) ext = COLOR_WORDS.steel;

  const inr = parseColorName(interior) || COLOR_WORDS.black;

  let [h1, s1, v1] = toBackdrop(ext);
  let [h2, s2, v2] = toBackdrop(inr);

  /* Neutrality is judged on the SOURCE, not on s1/s2: those have already
   * been clamped up into BACKDROP_SATURATION_RANGE, so the stock "black"
   * swatch (a 13%-saturated blue-black) came out at 0.28 and was
   * mistaken for a real color -- which sent black-on-black down the
   * rotate-hue path, where the shift is invisible at near-black value. */
  const srcNeutral = Math.max(
    rgbToHsv(ext[0], ext[1], ext[2])[1],
    rgbToHsv(inr[0], inr[1], inr[2])[1],
  ) <= NEUTRAL_SATURATION_CEILING * 1.5;

  /* A grey-on-black vehicle (very common) lands both stops within a few
   * percent of each other, which renders as a flat field -- push them
   * apart around their midpoint so there is always a visible ramp. */
  if (Math.abs(v1 - v2) < MIN_STOP_SEPARATION) {
    const mid = (v1 + v2) / 2, half = MIN_STOP_SEPARATION / 2;
    [v1, v2] = v1 >= v2 ? [mid + half, mid - half] : [mid - half, mid + half];
    v1 = Math.min(Math.max(v1, BACKDROP_VALUE_MIN), BACKDROP_VALUE_MAX);
    v2 = Math.min(Math.max(v2, BACKDROP_VALUE_MIN), BACKDROP_VALUE_MAX);
  }

  /* Exterior and interior the same color (black-on-black is the single
   * most common combination) would give a single-hue ramp: the flattest
   * and least distinctive backdrop we produce, which is a problem when
   * the whole point is that no two posts share one. */
  if (Math.abs(((h1 - h2 + 0.5) % 1.0) - 0.5) < 0.02 && Math.abs(s1 - s2) < 0.05) {
    if (srcNeutral) {
      /* Tint the LIGHTER stop. A hue is invisible at near-black values,
       * so tinting the dark end of a black-on-black pair does nothing --
       * measured (40,40,56)->(21,18,26), still effectively monochrome. */
      if (v1 >= v2) { h1 = NEUTRAL_TINT_HUE; s1 = NEUTRAL_TINT_SATURATION; }
      else          { h2 = NEUTRAL_TINT_HUE; s2 = NEUTRAL_TINT_SATURATION; }
    } else {
      h2 += MATCHING_HUE_SHIFT;
    }
  }

  return [hsvToRgb(h1, s1, v1), hsvToRgb(h2, s2, v2)];
}
