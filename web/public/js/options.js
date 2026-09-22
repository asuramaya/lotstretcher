/* Processing options, kept at parity with the CLI and server surfaces.
 *
 * Names and defaults deliberately track their counterparts so the two
 * surfaces stay comparable:
 *
 *   heroFormats   <- cli.py --hero-format / HERO_STILL_FORMATS
 *   videoFormats  <- cli.py --video-format / VIDEO_FORMATS
 *   strictCutouts <- cli.py --no-strict-cutouts (inverted)
 *   glow*         <- cli.py --no-glow / --glow-color / --glow-radius
 *                    / --glow-intensity
 *   cutType       <- server ImageSubmission.cut_type
 *   sceneId       <- server ImageSubmission.scene_id
 *   interiors     <- cli.py --no-interiors
 *   photoSort     <- cli.py --no-photo-sort
 *
 * Anything the browser cannot do is absent rather than present and
 * inert: no --upscale (SwinIR/Real-ESRGAN are far too heavy for a tab),
 * no --frame/--border/--background (those need an asset library, which
 * is Tier 1), no --nvenc, no scraping flags. */

/* From imaging/compose/pipeline.py::HERO_STILL_FORMATS. */
export const HERO_FORMATS = {
  square:   { size: [1254, 1254], label: 'Square',   note: 'Marketplace, Facebook feed' },
  portrait: { size: [1080, 1350], label: 'Portrait', note: 'Instagram and Facebook feed' },
  vertical: { size: [1080, 1920], label: 'Story',    note: 'Stories, Reels, TikTok' },
};

/* From imaging/compose/hero_video.py::VIDEO_FORMATS. */
export const VIDEO_FORMATS = {
  square:     { size: [1254, 1254], label: 'Square',     note: 'Marketplace, Facebook feed' },
  vertical:   { size: [1080, 1920], label: 'Vertical',   note: 'Reels, Stories, TikTok, Shorts' },
  horizontal: { size: [1920, 1080], label: 'Horizontal', note: 'YouTube, landscape feed' },
};

/* server/processing.py::CUT_TYPES. "blur" is deliberately omitted rather
 * than accepted-and-ignored: the server takes it for request-shape
 * compatibility and maps it to "complete", which is a documented gap
 * there. Offering a control here that silently does something else would
 * be worse than not offering it. */
export const CUT_TYPES = {
  complete: 'Cut out and compose',
  none: 'Sort only, no cutouts',
};

export const GLOW_COLORS = ['white', 'blue', 'gold', 'red'];

export const DEFAULTS = {
  heroFormats: ['square'],
  videoFormats: [],
  cutType: 'complete',

  photoSort: true,
  interiors: true,

  /* The quality gates. Inverted from the CLI's --no-strict-cutouts so
   * the safe value is the truthy one; off means compose everything the
   * matte produces, however badly it went. */
  strictCutouts: true,

  spotlight: true,
  glow: false,
  glowColor: 'white',
  glowRadius: 24,
  glowIntensity: 0.75,

  /* Backdrop source. 'vehicle' measures the car's own paint (the CLI and
   * server default); 'generic' is the seeded hue-band gradient used when
   * there is no colour to read. */
  backdrop: 'vehicle',

  margin: 0.06,          // compose/hero.py margin_frac
  threads: 0,            // 0 = auto (capped at MAX_THREADS)
};

const KEY = 'lotstretcher.options';

/* Options persist per device.
 *
 * This is settings, not content: it holds no photo and nothing derived
 * from one, so it is exactly the per-viewer convenience browser storage
 * is for. Every access is wrapped because storage throws in a private
 * window and comes back empty after a site-data clear. */
export function loadOptions() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    // Merge over defaults so a new option added later does not arrive
    // undefined for anyone who already has a saved blob.
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveOptions(options) {
  try { localStorage.setItem(KEY, JSON.stringify(options)); } catch { /* ignore */ }
}

export function resetOptions() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return { ...DEFAULTS };
}

/* A one-line summary for the header, so the current configuration is
 * visible without opening the pane. */
export function summarise(o) {
  const bits = [];
  bits.push(o.heroFormats.map((f) => HERO_FORMATS[f]?.label || f).join(' + ') || 'no stills');
  if (o.videoFormats.length) bits.push(`${o.videoFormats.length} video`);
  if (o.cutType === 'none') bits.push('sort only');
  if (!o.strictCutouts) bits.push('gates off');
  if (o.glow) bits.push(`${o.glowColor} glow`);
  return bits.join(' · ');
}

/* The equivalent CLI invocation for the current options.
 *
 * Shown in the UI because the two surfaces are the same pipeline, and
 * someone who outgrows the tab should be able to see exactly what to run
 * instead. It also keeps this file honest: a control with no CLI
 * counterpart is immediately obvious here. */
export function toCliFlags(o) {
  const flags = [];
  for (const f of o.heroFormats) flags.push(`--hero-format ${f}`);
  for (const f of o.videoFormats) flags.push(`--video-format ${f}`);
  if (!o.videoFormats.length) flags.push('--no-video');
  if (o.cutType === 'none') flags.push('--no-hero');
  if (!o.photoSort) flags.push('--no-photo-sort');
  if (!o.interiors) flags.push('--no-interiors');
  if (!o.strictCutouts) flags.push('--no-strict-cutouts');
  if (o.glow) {
    if (o.glowColor !== DEFAULTS.glowColor) flags.push(`--glow-color ${o.glowColor}`);
    if (o.glowRadius !== DEFAULTS.glowRadius) flags.push(`--glow-radius ${o.glowRadius}`);
    if (o.glowIntensity !== DEFAULTS.glowIntensity) flags.push(`--glow-intensity ${o.glowIntensity}`);
  } else {
    flags.push('--no-glow');
  }
  return `lotstretcher ./photos ${flags.join(' ')}`.replace(/\s+/g, ' ').trim();
}
