/* The core, in a worker of its own.
 *
 * Here the core may be the threaded build: rayon's join blocks the
 * calling thread, which this one may do and the page's main thread may
 * not. The page (pipeline/core-worker.js) hands over everything a job
 * reads from a page: the spec once, the studio font's bytes once, and
 * per job the cutouts and the backdrop and frame as pixels, so nothing
 * here fetches relative to a document. A still comes back as pixels, a
 * clip as MP4 bytes, both transferred; progress and the thread count
 * come back as they happen. Any failure is reported as a message and
 * the page does the job itself instead. */

import { loadSpecFrom } from '../spec.js';
import * as core from '../core.js';
import { ctxOf } from '../lib/imageio.js';
import { composeHero } from './compose.js';
import { renderHeroVideoHere } from './video.js';

const toCanvas = (data) => {
  if (!data) return null;
  const c = new OffscreenCanvas(data.width, data.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
};

self.onmessage = async (e) => {
  const m = e.data;
  const id = m.id;
  try {
    if (m.job === 'init') {
      loadSpecFrom(m.spec);
      await core.loadCore(undefined, { threads: true });
      self.postMessage({ id, threads: core.threadCount() });
    } else if (m.job === 'font') {
      core.loadFont(m.name, m.bytes);
      self.postMessage({ id, ok: true });
    } else if (m.job === 'compose') {
      const canvas = composeHero(toCanvas(m.cutout), {
        ...m.opts,
        background: toCanvas(m.background),
        border: toCanvas(m.border),
        text: m.text,
      });
      const image = ctxOf(canvas, { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
      self.postMessage({ id, image }, [image.data.buffer]);
    } else if (m.job === 'video') {
      const blob = await renderHeroVideoHere(m.shots.map(toCanvas), {
        ...m.opts,
        text: m.text,
        background: toCanvas(m.background),
        onProgress: (f) => self.postMessage({ id, progress: f }),
      });
      const mp4 = await blob.arrayBuffer();
      self.postMessage({ id, mp4 }, [mp4]);
    } else {
      throw new Error(`unknown job ${m.job}`);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
