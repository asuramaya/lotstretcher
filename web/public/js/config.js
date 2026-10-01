/* Single source of truth for anything that differs between dev and
 * production, or that we might reasonably want to tune without hunting
 * through modules. */

export const MODELS = {
  /* Classifiers ship as fp32.
   *
   * The int8 exports of both classifiers are BROKEN -- quantize_dynamic
   * rewrites MobileNetV3's 52 Conv nodes to ConvInteger with per-tensor
   * dynamic activation scales, and the depthwise convs plus HardSwish
   * collapse under one shared scale. Measured against the CLIP teacher
   * labels: fp32 100%/99.25%, int8 9.75%/11.50% -- both BELOW chance,
   * because the logits settle into a near-constant vector and argmax
   * stops depending on the input. Per-channel weight scales changed
   * nothing (identical to two decimals), because the damage is on the
   * activation side. 6.1MB each is well under Cloudflare's 25MiB
   * per-file static-asset cap, so this costs us nothing structural. */
  angle: { url: 'models/angle.onnx', bytes: 6101537, size: 224 },
  scene: { url: 'models/scene.onnx', bytes: 6093335, size: 224 },

  /* u2net int8 at a FIXED 256x256. Fixed because ORT-web handles dynamic
   * axes badly, and 256 because it measured 0/150 catastrophic failures
   * on production photos with composites indistinguishable from
   * BiRefNet. Unlike the classifiers this one quantizes cleanly -- it is
   * a plain conv encoder/decoder with no depthwise/HardSwish blocks. */
  matte: { url: 'models/matte.onnx', bytes: 44212443, size: 256 },

  /* Pipeline > Cutout model: Light. u2netp fp32 at its native 320: 4.6MB
   * against 44MB, ~475 against ~590 ms a matte in the browser, and on
   * 150 library photos against BiRefNet, 4 misses (IoU < 0.9) where u2net
   * had none (2026-09-25 bake-off). Its int8 export is broken (IoU 0.22). */
  matteLight: { url: 'models/matte-light.onnx', bytes: 4574861, size: 320 },
};

/* The models a run needs: the two classifiers and the chosen matte. */
export function modelKeys(cutoutModel) {
  return ['scene', 'angle', cutoutModel === 'light' ? 'matteLight' : 'matte'];
}

/* Where the models come from in production. Cloudflare caps static
 * assets at 25MiB per file on free AND paid plans, so the 44.2MB matte
 * cannot be an asset regardless of billing -- the models live in
 * R2 (zero egress) behind the bucket's custom domain, which Cloudflare
 * caches (the r2.dev address is rate-limited and not for production).
 * Objects sit under models/<MODEL_VERSION>/ with a year-long immutable
 * Cache-Control: a new model is a new version, never an overwrite.
 * Empty origin = serve from the same origin (dev). */
export const MODEL_ORIGIN = 'https://models.lotstretcher.org/';
export const MODEL_VERSION = 'v1';

export const ORT_PATH = 'ort/';

/* Throughput saturates at 4 threads; more measured no better. Threads
 * require cross-origin isolation (COOP/COEP) -- without it ORT silently
 * falls back to one thread and a vehicle takes ~27s instead of ~12s,
 * which is why the app surfaces isolation state rather than hiding it. */
export const MAX_THREADS = 4;

/* ImageNet normalisation -- what both students were trained with. */
export const NORM_MEAN = [0.485, 0.456, 0.406];
export const NORM_STD = [0.229, 0.224, 0.225];

/* The values below are loaded from shared/pipeline-spec.json by
 * initConfigFromSpec(); the literals here are only what the module
 * evaluates to before that runs. */
/* The quality gates themselves (ambiguity, coverage, frame fill) are
 * the core's (gate.rs, pipeline/matte.js::gateCutout). */
export let MAX_SOURCE_SIDE = 2048;

/* Below this, the angle is reported as unknown rather than asserted.
 * A wheel close-up that slips past the scene classifier scores ~0.33
 * here, and labelling it "front_3q" anyway is exactly the kind of
 * confident error that makes the output untrustworthy. */
export let MIN_ANGLE_CONFIDENCE = 0;

/* Below this the scene label is too weak to route on, so the photo is
 * kept but not composed. */
export let MIN_SCENE_CONFIDENCE = 0;
export let INTERIOR_LEAN = 1;
export let EXTERIOR_LEAN = 1;

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'bmp', 'tiff', 'avif'];

export const LIMITS = {
  /* A soft cap. Nothing breaks above it, but a phone working through 60
   * photos at ~2-3s each is a long time to hold a tab open, so the UI
   * warns rather than silently grinding. */
  softPhotoWarn: 40,
  maxPhotos: 120,
};


/* Pull the shared values in. Called once at startup, after loadSpec().
 * These are `let` rather than `const` precisely so the spec, not this
 * file, is the source of truth. */
export function initConfigFromSpec(get) {
  MAX_SOURCE_SIDE = get('cutout', 'maxSourceSideBrowser') || 0;
  MIN_ANGLE_CONFIDENCE = get('confidence', 'minAngle');
  MIN_SCENE_CONFIDENCE = get('confidence', 'minScene');
  INTERIOR_LEAN = get('confidence', 'interiorLean');
  EXTERIOR_LEAN = get('confidence', 'exteriorLean');
}
