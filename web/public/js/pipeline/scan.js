/* Scanning a VIN barcode with the camera, on this device.
 *
 * The door-jamb label carries the VIN as Code 39 (some as Code 128 or a
 * QR/Data Matrix). The browser's own BarcodeDetector reads those where
 * it exists (Chrome, Android); elsewhere the vendored ZXing reader
 * (vendor/zxing, MIT, ~1 MB wasm loaded on first use) does. Frames are
 * read off the live preview and never leave the page. A VIN counts only
 * when its check digit holds (pipeline/vin.js). */

import { normalize, checkDigit } from './vin.js';

const FORMATS_NATIVE = ['code_39', 'code_128', 'qr_code', 'data_matrix', 'pdf417'];
const FORMATS_ZXING = ['Code39', 'Code128', 'QRCode', 'DataMatrix', 'PDF417'];

let zxing = null;
async function zxingReader() {
  if (zxing) return zxing;
  const mod = await import('../../vendor/zxing/index.js');
  mod.prepareZXingModule({ overrides: { locateFile: (f) => new URL(`../../vendor/zxing/${f}`, import.meta.url).href } });
  zxing = mod;
  return mod;
}

/* The VIN in a barcode's text, if any. A Code 39 VIN label often
 * carries an import marker ("I") before the 17 characters. */
export function vinFromText(text) {
  const raw = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const candidate of [raw, raw.replace(/^I/, ''), raw.slice(-17)]) {
    const v = normalize(candidate);
    if (v.length === 17 && checkDigit(v) === v[8]) return v;
  }
  return null;
}

/* Decode every barcode in an ImageData; returns the texts. */
export async function decodeFrame(imageData) {
  if (typeof BarcodeDetector !== 'undefined') {
    try {
      const supported = await BarcodeDetector.getSupportedFormats?.();
      const formats = supported ? FORMATS_NATIVE.filter((f) => supported.includes(f)) : FORMATS_NATIVE;
      if (formats.length) {
        const found = await new BarcodeDetector({ formats }).detect(imageData);
        if (found.length) return found.map((b) => b.rawValue);
      }
    } catch { /* fall through to ZXing */ }
  }
  const z = await zxingReader();
  const found = await z.readBarcodes(imageData, { formats: FORMATS_ZXING, tryHarder: true, maxNumberOfSymbols: 4 });
  return found.map((b) => b.text);
}

/* Read the camera until a VIN turns up, the signal aborts, or the
 * stream ends. `video` is the element to show the preview in. */
export async function scanVin(video, { onStatus = () => {}, signal = null } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => { for (const t of stream.getTracks()) t.stop(); video.srcObject = null; };
  try {
    onStatus('Point at the VIN barcode on the door jamb.');
    let tries = 0;
    while (!signal?.aborted) {
      if (video.videoWidth && video.videoHeight) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let texts = [];
        try { texts = await decodeFrame(frame); } catch (e) { onStatus(`The decoder failed: ${e.message || e}`); }
        for (const t of texts) {
          const vin = vinFromText(t);
          if (vin) return vin;
        }
        if (texts.length) onStatus('A barcode, but not a VIN. Try the one on the door jamb.');
        else if (++tries % 8 === 0) onStatus('Hold steady and fill the frame with the barcode.');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  } finally {
    stop();
  }
}

/* A photo of the barcode instead, for a browser with no camera stream. */
export async function scanVinFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const texts = await decodeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
  for (const t of texts) { const vin = vinFromText(t); if (vin) return vin; }
  return null;
}
