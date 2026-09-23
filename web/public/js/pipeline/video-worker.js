/* The video renderer, in a worker of its own.
 *
 * Here the core may be the threaded build: rayon's join blocks the
 * calling thread, which this one may do and the page's main thread may
 * not. The page hands over everything the renderer reads from a page
 * (the spec, the studio font's bytes, the cutouts and the backdrop as
 * pixels) so nothing here fetches relative to a document. The clip
 * comes back as MP4 bytes, transferred; progress and the thread count
 * come back as they happen. Any failure is reported as a message, and
 * the page renders the clip itself instead. */

import { loadSpecFrom } from '../spec.js';
import * as core from '../core.js';
import { renderHeroVideoHere } from './video.js';

const toCanvas = (data) => {
  const c = new OffscreenCanvas(data.width, data.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
};

self.onmessage = async (e) => {
  const { spec, fonts, shots, background, text, opts } = e.data;
  try {
    loadSpecFrom(spec);
    await core.loadCore(undefined, { threads: true });
    for (const [name, bytes] of Object.entries(fonts || {})) core.loadFont(name, bytes);
    self.postMessage({ threads: core.threadCount() });
    const blob = await renderHeroVideoHere(shots.map(toCanvas), {
      ...opts,
      text,
      background: background ? toCanvas(background) : null,
      onProgress: (f) => self.postMessage({ progress: f }),
    });
    const mp4 = await blob.arrayBuffer();
    self.postMessage({ mp4 }, [mp4]);
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
