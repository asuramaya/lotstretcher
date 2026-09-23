/* A small IndexedDB key/value store for the user's own assets: the
 * background photo and the frame PNG they chose for the Look pane.
 *
 * These are settings in the same sense the options blob is, kept on this
 * device only, but they are images and localStorage is the wrong shape
 * for images. Nothing here is a vehicle photo or derived from one, and
 * every call is wrapped: IndexedDB throws in a private window and can
 * come back empty after a site-data clear, and the app must work with
 * nothing remembered. */

const DB = 'lotstretcher-assets';
const STORE = 'blobs';

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    return undefined;
  }
}

export const store = {
  get: (key) => withStore('readonly', (s) => s.get(key)),
  set: (key, blob) => withStore('readwrite', (s) => s.put(blob, key)),
  del: (key) => withStore('readwrite', (s) => s.delete(key)),
};

/* A blob decoded to a canvas, or null when it is not an image. */
export async function blobToCanvas(blob) {
  if (!blob) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    c.sourceBlob = blob;
    return c;
  } catch {
    return null;
  }
}
