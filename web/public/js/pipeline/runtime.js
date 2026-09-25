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

async function cachedModel(url, expectedBytes, onProgress) {
  let cache = null;
  try {
    if (self.caches) {
      cache = await caches.open(MODEL_CACHE);
      const hit = await cache.match(url);
      if (hit) {
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
    const buf = await cachedModel(modelUrl(spec.url), spec.bytes, onProgress);
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
