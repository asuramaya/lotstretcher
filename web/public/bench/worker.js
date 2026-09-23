// Bench: the plain core against the threaded one, both inside this worker.
async function cutout() {
  const r = await fetch('../demo/samples/camry.webp');
  const bmp = await createImageBitmap(await r.blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}
function arena(images) {
  let total = 0; for (const im of images) total += im.data.length;
  const buf = new Uint8Array(total); const slices = []; let off = 0;
  for (const im of images) { buf.set(im.data, off); slices.push({ offset: off, len: im.data.length, width: im.width, height: im.height, channels: im.channels || 4 }); off += im.data.length; }
  return { buf, slices };
}
async function bench(mod, label, cut) {
  const { buf, slices } = arena([cut]);
  const req = (w, h, glow) => JSON.stringify({ width: w, height: h, background: { kind: 'vehicle', seed: 'b', exterior: 'Midnight Black Metallic', interior: 'Black' }, cars: [slices[0]], layout: 'single', spotlight: true, glow, glow_color: 'white' });
  mod.compose_hero(req(1254, 1254, true), buf); // warm
  let t0 = performance.now(); for (let i = 0; i < 5; i++) mod.compose_hero(req(1254, 1254, true), buf);
  const composeGlow = (performance.now() - t0) / 5;
  t0 = performance.now(); for (let i = 0; i < 5; i++) mod.compose_hero(req(1254, 1254, false), buf);
  const compose = (performance.now() - t0) / 5;
  // video frames: one car scaled per frame, linear backdrop, 720²
  const id = JSON.parse(mod.call(JSON.stringify({ op: 'retain', image: slices[0] }), buf).text).value;
  const frame = (t) => JSON.stringify({ op: 'render_frame', width: 720, height: 720, background: { kind: 'linear', angle: t, start: [20, 20, 30], end: [60, 60, 90] },
    cars: [{ image: { retained: id }, x: 60, y: 120, w: 600, h: 400, alpha: 1 }], spotlight: { cx: 360, cy: 320, dim: 0.5 }, resample: 'bilinear', rgba: true });
  mod.call(frame(0), new Uint8Array(0));
  t0 = performance.now(); for (let i = 0; i < 60; i++) mod.call(frame(i * 6), new Uint8Array(0));
  const frameMs = (performance.now() - t0) / 60;
  mod.call(JSON.stringify({ op: 'release', id }), new Uint8Array(0));
  return { label, composeGlow: Math.round(composeGlow), compose: Math.round(compose), frameMs: Math.round(frameMs * 10) / 10 };
}
const log = (m) => self.postMessage({ log: m });
self.onmessage = async () => {
  const out = { hw: navigator.hardwareConcurrency, isolated: self.crossOriginIsolated };
  log(`start hw=${out.hw} isolated=${out.isolated}`);
  try {
    const cut = await cutout();
    const plain = await import('../core/lotstretcher_core.js'); await plain.default();
    log('plain loaded'); out.plain = await bench(plain, 'plain', cut); log('plain done ' + JSON.stringify(out.plain));
    const thr = await import('../core-threads/lotstretcher_core.js'); await thr.default();
    const n = Math.min(8, navigator.hardwareConcurrency || 2);
    log('threaded loaded, pool ' + n); await thr.initThreadPool(n); log('pool up');
    out.threaded = await bench(thr, `threaded x${n}`, cut);
  } catch (e) { out.error = String(e.stack || e); }
  self.postMessage(out);
};
