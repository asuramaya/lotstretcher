/* The page's handle on the core running in a worker (video-worker.js).
 *
 * One CoreWorker serves a run: stills and the clip go through it so the
 * threaded core does the work and the page stays free. The preview
 * stays on the page's own plain build, since it wants a frame back in
 * the same tick. Every method resolves to what the page-side function
 * would have returned, and a job the worker cannot do rejects, so the
 * caller falls back to doing it on the page. */

import { ctxOf, makeCanvas } from '../lib/imageio.js';

const toData = (c) => (c == null ? null : c instanceof ImageData ? c
  : ctxOf(c, { willReadFrequently: true }).getImageData(0, 0, c.width, c.height));

export class CoreWorker {
  static supported() {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  }

  constructor() {
    this.worker = new Worker(new URL('./video-worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();   // id -> { resolve, reject, onProgress }
    this.threads = 0;
    this.fontsSent = new Set();
    this.worker.onmessage = (e) => {
      const m = e.data;
      const job = this.pending.get(m.id);
      if (!job) return;
      if (m.progress !== undefined) { job.onProgress?.(m.progress); return; }
      this.pending.delete(m.id);
      if (m.error) job.reject(new Error(m.error)); else job.resolve(m);
    };
    this.worker.onerror = (e) => {
      for (const job of this.pending.values()) job.reject(new Error(e.message || 'worker failed'));
      this.pending.clear();
    };
  }

  post(msg, transfer = [], onProgress = null) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /* Load the spec and the core there. Resolves to the thread count. */
  async init() {
    const { raw } = await import('../spec.js');
    const r = await this.post({ job: 'init', spec: raw() });
    this.threads = r.threads || 0;
    return this.threads;
  }

  /* The studio fonts the page has loaded, sent once each. */
  async fonts() {
    const { loadedFonts } = await import('../lib/text.js');
    for (const [name, bytes] of Object.entries(loadedFonts())) {
      if (this.fontsSent.has(name)) continue;
      await this.post({ job: 'font', name, bytes: bytes.slice() }, []);
      this.fontsSent.add(name);
    }
  }

  /* composeHero, there. Same arguments; resolves to a canvas. */
  async compose(cutout, { background = null, border = null, text = null, ...opts } = {}) {
    await this.fonts();
    const cut = toData(cutout);
    const bg = toData(background);
    const bd = toData(border);
    // The cutout is copied, not moved: the page keeps using it.
    const r = await this.post({ job: 'compose', cutout: cut, background: bg, border: bd, text, opts },
      [...(bg ? [bg.data.buffer] : []), ...(bd ? [bd.data.buffer] : [])]);
    const c = makeCanvas(r.image.width, r.image.height);
    ctxOf(c).putImageData(r.image, 0, 0);
    return c;
  }

  /* renderHeroVideo, there. Same arguments; resolves to an MP4 blob. */
  async video(cutouts, { onProgress = null, signal = null, background = null, text = null, ...opts } = {}) {
    await this.fonts();
    const shots = cutouts.map(toData);
    const bg = toData(background);
    const onAbort = () => { this.terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await this.post({ job: 'video', shots, background: bg, text, opts },
        [...shots.map((d) => d.data.buffer), ...(bg ? [bg.data.buffer] : [])], onProgress);
      return new Blob([r.mp4], { type: 'video/mp4' });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  terminate() {
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(new Error('cancelled'));
    this.pending.clear();
  }
}
