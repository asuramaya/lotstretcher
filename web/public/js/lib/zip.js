/* A minimal ZIP writer (store-only, no compression).
 *
 * No library, because the payload is PNGs and MP4s -- already-compressed
 * bytes that DEFLATE cannot meaningfully shrink. Store-only means we
 * write the bytes through untouched, which is both correct and fast, and
 * it keeps the app at zero third-party JavaScript.
 *
 * Zip64 is not implemented. The cap that matters is 4GB per entry and
 * 65535 entries; a vehicle bundle is ~15 files and a few MB. */

const encoder = new TextEncoder();

/* CRC-32, table built once on first use. */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c >>> 0;
  }
  return CRC_TABLE;
}

function crc32(bytes) {
  const table = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* MS-DOS date/time, which is what ZIP stores. Two-second resolution,
 * and the year is an offset from 1980. */
function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  push(bytes) { this.parts.push(bytes); this.length += bytes.length; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xFFFF, true); this.push(b); }
}

/* files: [{ name, data }] where data is a Blob, ArrayBuffer, Uint8Array
 * or string. Returns a Blob. */
export async function makeZip(files) {
  const w = new Writer();
  const central = [];
  const { time, day } = dosDateTime();

  for (const file of files) {
    let bytes = file.data;
    if (typeof bytes === 'string') bytes = encoder.encode(bytes);
    // Duck-typed: instanceof is realm-sensitive, and a Blob made in
    // another window would silently fall through to the wrong branch.
    else if (typeof bytes?.arrayBuffer === 'function') bytes = new Uint8Array(await bytes.arrayBuffer());
    else if (ArrayBuffer.isView(bytes)) bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else if (bytes?.byteLength !== undefined) bytes = new Uint8Array(bytes);

    const name = encoder.encode(file.name);
    const crc = crc32(bytes);
    const offset = w.length;

    w.u32(0x04034b50);          // local file header
    w.u16(20);                  // version needed
    w.u16(0x0800);              // flags: UTF-8 names
    w.u16(0);                   // method: store
    w.u16(time); w.u16(day);
    w.u32(crc);
    w.u32(bytes.length);        // compressed
    w.u32(bytes.length);        // uncompressed
    w.u16(name.length);
    w.u16(0);                   // extra length
    w.push(name);
    w.push(bytes);

    central.push({ name, crc, size: bytes.length, offset });
  }

  const centralStart = w.length;
  for (const e of central) {
    w.u32(0x02014b50);          // central directory header
    w.u16(20); w.u16(20);
    w.u16(0x0800);
    w.u16(0);
    w.u16(time); w.u16(day);
    w.u32(e.crc);
    w.u32(e.size); w.u32(e.size);
    w.u16(e.name.length);
    w.u16(0); w.u16(0); w.u16(0);
    w.u16(0);
    w.u32(0);                   // external attrs
    w.u32(e.offset);
    w.push(e.name);
  }
  const centralSize = w.length - centralStart;

  w.u32(0x06054b50);            // end of central directory
  w.u16(0); w.u16(0);
  w.u16(central.length); w.u16(central.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0);

  return new Blob(w.parts, { type: 'application/zip' });
}

/* Hand a Blob to the user.
 *
 * On a phone, the share sheet is the native destination -- "download"
 * puts a file somewhere most people cannot find. We prefer Web Share
 * when it can take files and fall back to a download link otherwise.
 * Returns which path was taken so the UI can say the right thing. */
export async function deliver(blob, filename) {
  if (navigator.canShare && navigator.share) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      } catch (e) {
        // A user cancelling the sheet is not an error worth surfacing;
        // anything else falls through to the download path.
        if (e?.name === 'AbortError') return 'cancelled';
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
