/* ONNX Runtime setup and model loading.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. wasmPaths resolves relative to the MODULE, not the page. A value of
 *    './ort/' from a module in js/pipeline/ produces js/pipeline/ort/...
 *    and every fetch 404s. It must be rooted.
 *
 * 2. Threads need crossOriginIsolated, which needs COOP/COEP headers. If
 *    isolation is missing ORT does not error -- it quietly runs on one
 *    thread, which is the difference between ~12s and ~27s per vehicle.
 *    We detect it and report it rather than letting it look like the
 *    models are just slow. */

import { MODELS, MODEL_ORIGIN, MODEL_VERSION, ORT_PATH, MAX_THREADS } from '../config.js';

let ort = null;
const sessions = new Map();
const inflight = new Map();

export const runtime = {
  isolated: false,
  threads: 1,
  simd: true,
};

export async function initRuntime() {
  if (ort) return ort;

  ort = await import(`../../${ORT_PATH}ort.wasm.min.mjs`);

  // Rooted at the origin, not at this module. See note 1 above.
  ort.env.wasm.wasmPaths = new URL(ORT_PATH, document.baseURI).href;

  runtime.isolated = !!self.crossOriginIsolated;
  runtime.threads = runtime.isolated
    ? Math.max(1, Math.min(MAX_THREADS, navigator.hardwareConcurrency || 4))
    : 1;

  ort.env.wasm.numThreads = runtime.threads;
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';

  return ort;
}

const SESSION_OPTS = {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
};

function modelUrl(rel) {
  if (!MODEL_ORIGIN) return rel;
  return new URL(rel.replace(/^models\//, `models/${MODEL_VERSION}/`), MODEL_ORIGIN).href;
}

/* The models are kept in the Cache API after the first download, so a
 * second visit (or an offline one) starts in a moment instead of pulling
 * 56MB again. They are the app's own files, not anything of the user's.
 * The cache name carries the version: a new model version starts a new
 * cache and the old one is dropped. Every access is guarded, because the
 * Cache API is missing on insecure origins and can throw when storage is
 * blocked; then the network (and the HTTP cache) is the fallback. */
const MODEL_CACHE = `lotstretcher-models-${MODEL_VERSION}`;

async function cachedModel(url, expectedBytes, onProgress, { keep = true } = {}) {
  let cache = null;
  try {
    if (self.caches) {
      cache = await caches.open(MODEL_CACHE);
      const hit = await cache.match(url);
      if (hit) {
        if (!keep) { onProgress?.(1); return null; }
        const buf = await hit.arrayBuffer();
        if (!expectedBytes || buf.byteLength === expectedBytes) { onProgress?.(1); return buf; }
        await cache.delete(url);
      }
    }
  } catch { cache = null; }
  const buf = await fetchWithProgress(url, expectedBytes, onProgress);
  if (cache) {
    try {
      await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } }));
      // Older versions' caches are dead weight on a phone.
      for (const name of await caches.keys()) {
        if (name.startsWith('lotstretcher-models-') && name !== MODEL_CACHE) await caches.delete(name);
      }
      // Stored: a prefetch need not hold 56MB in memory until it is used.
      if (!keep) return null;
    } catch { /* storage full or blocked: the model still runs */ }
  }
  return buf;
}

/* Fetch with byte-accurate progress.
 *
 * Content-Length is absent under some compression configurations, so the
 * declared size from config.js is the fallback denominator -- a progress
 * bar that reaches 100% and keeps going is worse than a slightly
 * approximate one. */
async function fetchWithProgress(url, expectedBytes, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);

  const declared = Number(res.headers.get('content-length')) || expectedBytes || 0;
  if (!res.body || !declared) {
    const buf = await res.arrayBuffer();
    onProgress?.(1);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(1, received / declared));
  }
  onProgress?.(1);

  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

/* One download per model, shared by a prefetch and a load: a model the
 * app started fetching when it opened is not fetched again when the
 * first photo lands, the load waits on the same request. */
const downloads = new Map();
const prefetched = new Map();
const progressOf = new Map();
const listeners = new Set();

function emit() {
  let got = 0; let total = 0;
  for (const k of Object.keys(MODELS)) {
    total += MODELS[k].bytes;
    got += (progressOf.get(k) || 0) * MODELS[k].bytes;
  }
  for (const fn of listeners) fn(total ? got / total : 1);
}

function download(key, keep) {
  if (!downloads.has(key)) {
    const spec = MODELS[key];
    const task = cachedModel(modelUrl(spec.url), spec.bytes, (f) => { progressOf.set(key, f); emit(); }, { keep })
      .then((buf) => { if (buf) prefetched.set(key, buf); return buf; })
      .finally(() => downloads.delete(key));
    downloads.set(key, task);
  }
  return downloads.get(key);
}

/* Whether every model is already on this device (no download ahead). */
export async function modelsCached() {
  try {
    if (!self.caches) return false;
    const cache = await caches.open(MODEL_CACHE);
    for (const k of Object.keys(MODELS)) {
      if (!(await cache.match(modelUrl(MODELS[k].url)))) return false;
    }
    return true;
  } catch { return false; }
}

/* Start fetching the models into the device's cache without building
 * sessions (no inference memory is taken until a photo needs it).
 * `onProgress(fraction)` follows the bytes across all three. */
export function prefetchModels(onProgress) {
  if (onProgress) listeners.add(onProgress);
  const all = Promise.all(Object.keys(MODELS).map((k) => (sessions.has(k) ? null : download(k, !self.caches))));
  return all.finally(() => { if (onProgress) listeners.delete(onProgress); });
}

/* Load a model by key. Concurrent callers share one fetch -- the
 * pipeline asks for `scene` on photo 1 and `matte` on photo 1 at nearly
 * the same moment, and downloading 44MB twice would be a real cost. */
export async function loadModel(key, onProgress) {
  if (sessions.has(key)) return sessions.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const spec = MODELS[key];
  if (!spec) throw new Error(`unknown model: ${key}`);

  const task = (async () => {
    await initRuntime();
    let buf = prefetched.get(key) || null;
    prefetched.delete(key);
    if (!buf) {
      // A prefetch may be under way: wait for it, then read the stored copy.
      if (downloads.has(key)) { if (onProgress) listeners.add(onProgress); await downloads.get(key).catch(() => null); listeners.delete(onProgress); }
      buf = prefetched.get(key) || await cachedModel(modelUrl(spec.url), spec.bytes, onProgress);
      prefetched.delete(key);
    }
    const session = await ort.InferenceSession.create(buf, SESSION_OPTS);
    const entry = { session, spec, inputName: session.inputNames[0] };
    sessions.set(key, entry);
    inflight.delete(key);
    return entry;
  })();

  inflight.set(key, task);
  return task;
}

export function getOrt() {
  if (!ort) throw new Error('runtime not initialised -- call initRuntime() first');
  return ort;
}

export function isLoaded(key) {
  return sessions.has(key);
}

/* Release everything. Reclaims the inference arenas (~141MB of the
 * measured ~466MB floor), which matters on a phone between vehicles. */
export async function releaseAll() {
  for (const [, entry] of sessions) {
    try { await entry.session.release(); } catch { /* already gone */ }
  }
  sessions.clear();
}

export function totalBytes(keys = Object.keys(MODELS)) {
  return keys.reduce((n, k) => n + (MODELS[k]?.bytes || 0), 0);
}
