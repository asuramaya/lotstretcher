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

import { makeCanvas, ctxOf } from '../lib/imageio.js';
import { vehicleGradient, genericGradient, computeDimStrength, applySpotlight } from './compose.js';

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

/* Draw one frame.
 *
 * Shots crossfade, and the backdrop rotates independently of them, so
 * the motion never stops even at a shot boundary. */
function drawFrame(ctx, { width, height, shots, t, duration, backdrops, spotlight }) {
  const perShot = duration / shots.length;
  const index = Math.min(shots.length - 1, Math.floor(t / perShot));
  const local = (t - index * perShot) / perShot;

  // The rotating backdrop is pre-rendered once per shot, because
  // regenerating the gradient per frame was the single biggest per-frame
  // cost in the CLI too.
  const angleTurn = (t / duration) * GRADIENT_TURNS;
  ctx.save();
  ctx.clearRect(0, 0, width, height);

  const bg = backdrops[index % backdrops.length];
  // Rotate the backdrop about its centre, drawn oversized so no corner
  // ever swings into frame.
  const diag = Math.hypot(width, height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate(angleTurn * 2 * Math.PI);
  ctx.drawImage(bg, -diag / 2, -diag / 2, diag, diag);
  ctx.restore();

  const paint = (shot, alpha, progress) => {
    if (alpha <= 0) return;
    const box = [0, 0, width, height];
    const avail = [
      (box[2] - box[0]) * (1 - 2 * HERO_MARGIN_FRAC),
      (box[3] - box[1]) * (1 - 2 * HERO_MARGIN_FRAC),
    ];
    const base = Math.min(avail[0] / shot.width, avail[1] / shot.height);
    // A slow push across the dwell so no frame is ever static.
    const scale = base * (1 + PUSH_STRENGTH * easeInOut(progress));
    const w = shot.width * scale;
    const h = shot.height * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(shot, (width - w) / 2, (height - h) / 2, w, h);
    ctx.restore();
  };

  const fadeFrac = Math.min(0.45, CROSSFADE_S / perShot);
  if (local < fadeFrac && index > 0) {
    const k = local / fadeFrac;
    paint(shots[index - 1], 1 - k, 1);
    paint(shots[index], k, local);
  } else {
    paint(shots[index], 1, local);
  }
}

/* Render and encode a hero video.
 *
 * `cutouts` are cropped RGBA canvases, best shot first. Returns a Blob.
 * onProgress receives 0..1.
 */
export async function renderHeroVideo(cutouts, {
  width = 1254,
  height = 1254,
  fps = DEFAULT_FPS,
  duration = DEFAULT_DURATION_S,
  seed = 'lotstretcher',
  exterior = null,
  interior = null,
  generic = false,
  spotlight = true,
  onProgress = null,
  signal = null,
} = {}) {
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

  // Pre-render one backdrop per shot. Regenerating a gradient per frame
  // was the biggest per-frame cost in the CLI, and it is worse here.
  const diag = Math.ceil(Math.hypot(width, height));
  const backdrops = cutouts.map((cut, i) => {
    const cutCtx = ctxOf(cut, { willReadFrequently: true });
    const data = cutCtx.getImageData(0, 0, cut.width, cut.height);
    return generic
      ? genericGradient(diag, diag, `${seed}:v${i}`)
      : vehicleGradient(diag, diag, `${seed}:v${i}`, exterior, interior, data);
  });

  const canvas = makeCanvas(width, height);
  const ctx = ctxOf(canvas);

  const total = Math.round(duration * fps);
  const usPerFrame = 1e6 / fps;

  for (let f = 0; f < total; f++) {
    if (signal?.aborted) { encoder.close(); throw new Error('cancelled'); }

    drawFrame(ctx, {
      width, height, shots: cutouts, t: f / fps, duration, backdrops, spotlight,
    });

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

  await encoder.flush();
  encoder.close();
  muxer.finalize();
  onProgress?.(1);

  return new Blob([target.buffer], { type: 'video/mp4' });
}
