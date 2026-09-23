/* Hero video, rendered and encoded in the tab.
 *
 * This is an HONEST SUBSET of imaging/compose/hero_video.py, not a port
 * of it. That module is 976 lines of music-synced carousel: beat
 * detection against an audio loop, a four-way conveyor morph, GPU
 * compositing, ffmpeg/NVENC encoding. None of that survives contact with
 * a browser, and pretending otherwise would produce something worse than
 * a simpler thing done properly.
 *
 * What IS kept, because it is what makes the CLI's video read as
 * deliberate rather than as a slideshow:
 *
 *   - the backdrop gradient rotating a full turn across the video
 *     (GRADIENT_TURNS = 1.0). A static gradient behind a moving car
 *     reads as a still image with a car twitching on it.
 *   - a slow push on each shot, so no frame is ever static.
 *   - crossfades between shots rather than cuts.
 *
 * What is NOT here and is not pretended: audio, beat sync, the conveyor
 * morph, multi-car layouts. The CLI remains the way to get those.
 *
 * Encoding is WebCodecs, measured at 3-4x realtime during the research
 * loop, with software encode only 16% slower than hardware. */

import { makeCanvas, ctxOf, coverFit } from '../lib/imageio.js';
import * as core from '../core.js';
import { get as specGet } from '../spec.js';

const MUXER_URL = '../../vendor/mp4/mp4-muxer.mjs';

export const DEFAULT_FPS = 30;
export const DEFAULT_DURATION_S = 8;

/* Ported from hero_video.py. */
const GRADIENT_TURNS = 1.0;
const HERO_MARGIN_FRAC = 0.08;
const PUSH_STRENGTH = 0.06;      // how far a shot scales over its dwell
const CROSSFADE_S = 0.5;

/* H.264 codec strings, most capable first.
 *
 * THIS LIST IS THE POINT. A 1254x1254 frame is 6084 macroblocks, and
 * avc1.42001f (Baseline, level 3.1) caps at 3600, so it fails with a
 * bare "config unsupported" that says nothing about levels. Probing a
 * descending list finds the first that the browser will actually accept
 * instead of guessing one and shipping a broken encoder. */
const CODEC_CANDIDATES = [
  'avc1.640034',   // High 5.2
  'avc1.640033',   // High 5.1
  'avc1.4d0034',   // Main 5.2
  'avc1.4d0033',   // Main 5.1
  'avc1.640029',   // High 4.1
  'avc1.42E033',   // Constrained Baseline 5.1
  'avc1.42001f',   // Baseline 3.1 -- only viable for small frames
];

export function isSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/* The first codec this browser will encode at this size.
 * Returns null when none will, which is a real outcome on some devices
 * and has to be reported rather than thrown past. */
export async function pickCodec(width, height, fps = DEFAULT_FPS) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of CODEC_CANDIDATES) {
    const config = {
      codec,
      width,
      height,
      framerate: fps,
      bitrate: bitrateFor(width, height),
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support?.supported) return config;
    } catch { /* try the next one */ }
  }
  return null;
}

/* Roughly matches compute_video_bitrate_kbps()'s budget thinking: enough
 * for a clean gradient and a sharp vehicle edge, not so much that a
 * phone spends a minute writing the file. */
function bitrateFor(width, height) {
  const pixels = width * height;
  return Math.round(Math.min(12e6, Math.max(3e6, pixels * 4.5)));
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

/* An RGBA core image as RGB, for the ops that measure a backdrop. */
function rgbOf(img) {
  if (img.channels === 3) return img;
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) { data[i * 3] = img.data[j]; data[i * 3 + 1] = img.data[j + 1]; data[i * 3 + 2] = img.data[j + 2]; }
  return { width: img.width, height: img.height, channels: 3, data };
}

/* Draw one frame.
 *
 * Shots crossfade, and the backdrop rotates independently of them, so
 * the motion never stops even at a shot boundary. */
/* One frame, every pixel from the core. The choreography (which shot,
 * how far through its dwell, the push and the crossfade) is decided
 * here; the backdrop, spotlight, scaling and compositing are the core's,
 * the same code the CLI's frames come from. */
function hashAngle(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 36000) / 100;
}

/* Scaled cars, resident in the core and memoized on size, as the CLI's
 * are (hero_video.py::_scaled): a pan slides one bitmap and the beat
 * pulse cycles through a handful of integer sizes, so each is resampled
 * once and then pasted by id with no pixels crossing into wasm memory.
 * Bounded; an entry is a few MB. */
const SCALED_MAX = 48;
class ScaledCache {
  constructor() { this.map = new Map(); }
  get(shotId, w, h) {
    const key = `${shotId}:${w}:${h}`;
    let id = this.map.get(key);
    if (id === undefined) {
      if (this.map.size >= SCALED_MAX) {
        const oldest = this.map.keys().next().value;
        core.release(this.map.get(oldest));
        this.map.delete(oldest);
      }
      id = core.retain(core.call({ op: 'resize', image: { $image: 0 }, width: w, height: h, bilinear: true }, [shotId]));
    } else {
      this.map.delete(key); // least recently used first: a hit moves to the back
    }
    this.map.set(key, id);
    return id;
  }
  clear() { for (const id of this.map.values()) core.release(id); this.map.clear(); }
}

/* The conveyor: the CLI's edit, from the same core choreography. */
function drawConveyorFrame(ctx, prepared, { width, height, shots, t, duration, palette, spotlight, plan, scaled, glow, overlays }) {
  const fo = core.call({ op: 'carousel_frame', plan, t });
  const hero = plan.shots[fo.hero];
  const pal = palette[0];
  const angle = pal.angle + GRADIENT_TURNS * 360 * (t / duration);
  const [background, backgroundImage] = backdropFor(prepared, angle, pal);
  const cars = fo.cars.map((c) => {
    const w = Math.max(1, Math.round(c.rect[2]));
    const h = Math.max(1, Math.round(c.rect[3]));
    return { image: scaled.get(shots[c.shot].id, w, h), x: c.rect[0], y: c.rect[1], w, h, alpha: c.alpha };
  });
  const frame = core.renderFrame(cars, width, height, background, {
    backgroundImage,
    spotlight: spotlight ? { cx: hero.center[0], cy: hero.center[1], dim: hero.dim } : null,
    resample: 'bilinear', overlays,
    ...glow,
  });
  ctx.putImageData(frame, 0, 0);
}

/* Fewer than three shots cannot fill a conveyor (the CLI renders no clip
 * then); the browser keeps a plain push with crossfades for those. */
function drawFrame(ctx, prepared, { width, height, shots, t, duration, palette, spotlight, glow, overlays, window: win }) {
  const perShot = duration / shots.length;
  const index = Math.min(shots.length - 1, Math.floor(t / perShot));
  const local = (t - index * perShot) / perShot;

  // Rotating rather than looping: a generated backdrop has no seam to
  // hide, so it can just keep turning, as the CLI's does.
  const pal = palette[index % palette.length];
  const angle = pal.angle + GRADIENT_TURNS * 360 * (t / duration);
  const [background, backgroundImage] = backdropFor(prepared, angle, pal);

  // The push fills the window (the canvas, less the text's band).
  const [wl, wt, wr, wb] = win || [0, 0, width, height];
  const ww = wr - wl;
  const wh = wb - wt;
  const cars = [];
  const place = (shot, alpha, progress) => {
    if (alpha <= 0) return;
    const availW = ww * (1 - 2 * HERO_MARGIN_FRAC);
    const availH = wh * (1 - 2 * HERO_MARGIN_FRAC);
    const base = Math.min(availW / shot.width, availH / shot.height);
    // A slow push across the dwell so no frame is ever static.
    const scale = base * (1 + PUSH_STRENGTH * easeInOut(progress));
    const w = shot.width * scale;
    const h = shot.height * scale;
    cars.push({ image: shot.id, x: wl + (ww - w) / 2, y: wt + (wh - h) / 2, w, h, alpha });
  };

  const fadeFrac = Math.min(0.45, CROSSFADE_S / perShot);
  if (local < fadeFrac && index > 0) {
    const k = local / fadeFrac;
    place(shots[index - 1], 1 - k, 1);
    place(shots[index], k, local);
  } else {
    place(shots[index], 1, local);
  }

  const frame = core.renderFrame(cars, width, height, background, {
    backgroundImage,
    spotlight: spotlight ? { cx: wl + ww / 2, cy: wt + wh / 2, dim: shots[index].dim } : null,
    resample: 'bilinear', overlays,
    ...glow,
  });
  ctx.putImageData(frame, 0, 0);
}

/* Everything a clip needs before its first frame: each shot's pixels
 * and spotlight dim, one palette per shot, and, for three or more
 * shots, the conveyor plan from the core. Split out so the Look pane's
 * preview can draw one frame of the very clip a run would render. */
export function prepareClip(cutouts, {
  width = 1254, height = 1254, seed = 'lotstretcher', angles = null,
  exterior = null, interior = null, generic = false, spotlight = true, duration = null,
  text = null,                // lib/text.js::textRequest; the still's text on every frame
  background = null,          // a canvas: a stock or the user's photo behind the clip, cover-fitted
} = {}) {
  const explicitDuration = duration !== null;
  if (duration === null) duration = DEFAULT_DURATION_S;
  // A photo backdrop is fitted once and held for the clip; the gradient
  // is the fallback, rebuilt per frame because it rotates.
  const bgData = background
    ? ctxOf(coverFit(background, width, height), { willReadFrequently: true }).getImageData(0, 0, width, height)
    : null;
  // One palette per shot (the CLI seeds per image too), and each shot's
  // pixels and spotlight dim measured once. The gradient itself is
  // rebuilt by the core per frame because it rotates.
  const shots = cutouts.map((cut, i) => {
    const data = ctxOf(cut, { willReadFrequently: true }).getImageData(0, 0, cut.width, cut.height);
    return { width: cut.width, height: cut.height, data, dim: 1.0 };
  });
  // The text is planned once inside the canvas (its paint colour read
  // off the first shot), and the cars are laid out in the window left
  // beside its band, as the CLI's clip does.
  const overlays = text ? core.overlayPlan(width, height, text.vehicle, { ...text, window: [0, 0, width, height] }, shots[0]?.data || null) : [];
  const window = overlays.length
    ? core.call({ op: 'text_window', window: [0, 0, width, height], height, overlays })
    : [0, 0, width, height];
  const palette = cutouts.map((cut, i) => {
    const s = `${seed}:v${i}`;
    let start; let end;
    // Generic means no colour names: the palette is measured off the
    // cutout's own paint, which is what the core does with no names.
    [start, end] = core.vehicleGradientColors(generic ? null : exterior, generic ? null : interior, shots[i].data);
    // The angle is the seed's, as the still's would be.
    const angle = (hashAngle(s));
    return { start, end, angle };
  });
  if (spotlight) {
    for (const shot of shots) {
      const availW = width * (1 - 2 * HERO_MARGIN_FRAC);
      const availH = height * (1 - 2 * HERO_MARGIN_FRAC);
      const scale = Math.min(availW / shot.width, availH / shot.height);
      const w = Math.max(1, Math.round(shot.width * scale));
      const h = Math.max(1, Math.round(shot.height * scale));
      const scaled = core.call({ op: 'resize', image: { $image: 0 }, width: w, height: h }, [shot.data]);
      // The dim is measured against what sits behind the car: the photo
      // where there is one, the gradient otherwise.
      const bg = bgData
        ? rgbOf(core.call({ op: 'resize', image: { $image: 0 }, width: w, height: h, bilinear: true }, [{ width, height, channels: 4, data: bgData.data }]))
        : core.call({ op: 'linear_gradient', width: w, height: h, angle: palette[0].angle, start: palette[0].start, end: palette[0].end });
      shot.dim = core.call({ op: 'dim_strength', background: { $image: 0 }, car: { $image: 1 } },
        [{ width: w, height: h, channels: 3, data: bg.data }, { width: w, height: h, channels: 4, data: scaled.data }]);
    }
  }

  // Three or more shots: the conveyor, planned by the core exactly as
  // the CLI's is. The clock is the spec's default tempo, since the
  // browser has no music to sync to.
  let plan = null;
  if (shots.length >= 3) {
    const v = specGet('video');
    const loopS = v.barsPerLoop * v.beatsPerBar * 60 / v.defaultBpm;
    const bg = bgData
      ? rgbOf({ width, height, channels: 4, data: bgData.data })
      : core.call({ op: 'linear_gradient', width, height, angle: palette[0].angle, start: palette[0].start, end: palette[0].end });
    plan = core.call({
      op: 'carousel_plan', width, height, backdrop: { $image: 0 },
      shots: shots.map((sh, i) => ({ image: { $image: i + 1 }, pannable: (angles?.[i] || null) === v.panAngleLabel, hood_side: null })),
      audio_loop_s: loopS, window,
    }, [{ width, height, channels: 3, data: bg.data }, ...shots.map((sh) => sh.data)]);
    if (!explicitDuration) duration = plan.period;
  }

  return { shots, palette, plan, duration, width, height, overlays, window, background: bgData };
}

/* The backdrop a frame draws: the held photo, or the turning gradient. */
function backdropFor(prepared, angle, pal) {
  if (prepared.bgId !== undefined) return [{ kind: 'image' }, prepared.bgId];
  return [{ kind: 'linear', angle, start: pal.start, end: pal.end }, null];
}

/* One frame at time `t` of a prepared clip. `scaled` is a ScaledCache
 * when the caller draws many frames; a one-off frame passes none and
 * pays for its resampling once. */
export function drawClipFrame(ctx, prepared, t, { spotlight = true, glow = false, glowColor = null, glowRadius = null, glowIntensity = null, scaled = null } = {}) {
  const { shots, palette, plan, duration, width, height, overlays = [], window = null } = prepared;
  const halo = { glow, glowColor, glowRadius, glowIntensity };
  const own = !scaled;
  const cache = scaled || new ScaledCache();
  const held = own ? shots.map((sh) => { const had = sh.id; if (had === undefined) sh.id = core.retain(sh.data); return had === undefined; }) : null;
  const heldBg = own && prepared.background && prepared.bgId === undefined;
  if (heldBg) prepared.bgId = core.retain(prepared.background);
  try {
    if (plan) drawConveyorFrame(ctx, prepared, { width, height, shots, t, duration, palette, spotlight, plan, scaled: cache, glow: halo, overlays });
    else drawFrame(ctx, prepared, { width, height, shots, t, duration, palette, spotlight, glow: halo, overlays, window });
  } finally {
    if (own) {
      cache.clear();
      shots.forEach((sh, i) => { if (held[i]) { core.release(sh.id); delete sh.id; } });
      if (heldBg) { core.release(prepared.bgId); delete prepared.bgId; }
    }
  }
}

/* Render and encode a hero video.
 *
 * `cutouts` are cropped RGBA canvases, best shot first. Returns a Blob.
 * onProgress receives 0..1.
 */
/* Render a clip in a worker of its own, on the threaded core where the
 * page is cross-origin isolated (about 3.5x), with the page left free
 * to draw. Anything that stops the worker from doing it (no
 * OffscreenCanvas, no WebCodecs there, a failed load) falls back to
 * rendering here, with the same code. A run that renders stills too
 * keeps one CoreWorker for the lot; this is the one-off form. */
export async function renderHeroVideo(cutouts, opts = {}) {
  const { CoreWorker } = await import('./core-worker.js');
  if (!CoreWorker.supported()) return renderHeroVideoHere(cutouts, opts);
  const cw = new CoreWorker();
  try {
    lastThreads = await cw.init();
    return await cw.video(cutouts, opts);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    console.warn('video worker fell back to the page:', e);
    return renderHeroVideoHere(cutouts, opts);
  } finally {
    cw.terminate();
  }
}

let lastThreads = 0;
/* How many threads the last clip was rendered on; 0 for the page's own build. */
export function videoThreads() { return lastThreads; }
export function setVideoThreads(n) { lastThreads = n; }

export async function renderHeroVideoHere(cutouts, {
  width = 1254,
  height = 1254,
  fps = DEFAULT_FPS,
  duration = null,
  seed = 'lotstretcher',
  angles = null,              // per-cutout angle labels; only the spec's pan angle pans
  exterior = null,
  interior = null,
  generic = false,
  spotlight = true,
  // The glow halo behind each car, as the CLI's --glow-* flags set it.
  // Memoized per scaled car inside the core, so it costs one blur per
  // car per clip rather than per frame.
  glow = false,
  glowColor = null,
  glowRadius = null,
  glowIntensity = null,
  text = null,                // lib/text.js::textRequest: the still's title, badge and line on the clip
  background = null,          // a canvas behind the clip (a stock or the user's photo); the gradient otherwise
  onProgress = null,
  signal = null,
} = {}) {
  const explicitDuration = duration !== null;
  if (duration === null) duration = DEFAULT_DURATION_S;
  if (!cutouts.length) throw new Error('no cutouts to animate');

  const config = await pickCodec(width, height, fps);
  if (!config) {
    throw new Error('This browser will not encode H.264 at this size. Try a smaller format.');
  }

  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',   // so the file plays without a full download
  });

  /* Backpressure is EVENT-DRIVEN, not timer-driven.
   *
   * The obvious implementation waits on setTimeout until encodeQueueSize
   * falls. That is broken in a way that only shows up in use: Chrome
   * clamps timers hard in a hidden tab, so the moment someone switches
   * away mid-render the encode rate collapses to the timer clamp and
   * stays there. Measured while debugging this: throughput pinned at
   * exactly 5.6 fps for 1254, 1080 AND 720 frames, identical to one
   * decimal, which is the signature of a limit that has nothing to do
   * with the work being measured.
   *
   * Waking on the encoder's own output callback instead means progress
   * is paced by the encoder finishing frames, which keeps running at
   * full speed in a background tab. */
  let drained = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      if (drained) { drained(); drained = null; }
    },
    error: (e) => { throw e; },
  });
  encoder.configure(config);

  const MAX_QUEUE = 6;
  const waitForDrain = () => (
    encoder.encodeQueueSize <= MAX_QUEUE
      ? Promise.resolve()
      : new Promise((resolve) => { drained = resolve; })
  );

  const prepared = prepareClip(cutouts, { width, height, seed, angles, exterior, interior, generic, spotlight, duration: explicitDuration ? duration : null, text, background });
  const { shots, palette, plan } = prepared;
  duration = prepared.duration;

  const canvas = makeCanvas(width, height);
  const ctx = ctxOf(canvas);

  const total = Math.round(duration * fps);
  const usPerFrame = 1e6 / fps;

  // The cutouts stay resident in the core for the clip; every frame
  // names them by id. Released in `finally`, including on cancel.
  for (const shot of shots) shot.id = core.retain(shot.data);
  if (prepared.background) prepared.bgId = core.retain(prepared.background);
  const scaled = new ScaledCache();
  try {
  for (let f = 0; f < total; f++) {
    if (signal?.aborted) { encoder.close(); throw new Error('cancelled'); }

    drawClipFrame(ctx, prepared, f / fps, { spotlight, glow, glowColor, glowRadius, glowIntensity, scaled });

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(f * usPerFrame),
      duration: Math.round(usPerFrame),
    });
    // A keyframe every two seconds keeps seeking usable without
    // inflating the file the way all-keyframes would.
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();

    // Let the encoder drain rather than queueing every frame at once,
    // which is what pushes a phone into a memory wall.
    await waitForDrain();
    if (onProgress && f % 5 === 0) onProgress(f / total);
  }
  } finally {
    scaled.clear();
    for (const shot of shots) { if (shot.id !== undefined) { core.release(shot.id); delete shot.id; } }
    if (prepared.bgId !== undefined) { core.release(prepared.bgId); delete prepared.bgId; }
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();
  onProgress?.(1);

  return new Blob([target.buffer], { type: 'video/mp4' });
}
