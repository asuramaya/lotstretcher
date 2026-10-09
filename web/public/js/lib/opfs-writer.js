/* Writes one file into the browser's private storage with a sync access
 * handle: the only way Safari before 18.4 writes there. lib/save.js
 * posts {id, path, name, bytes}; path is the folder's parts from the
 * storage root (FileSystemDirectoryHandle.resolve). */
self.onmessage = async (e) => {
  const { id, path, name, bytes } = e.data;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const part of path) dir = await dir.getDirectoryHandle(part, { create: true });
    const file = await dir.getFileHandle(name, { create: true });
    const access = await file.createSyncAccessHandle();
    try {
      access.truncate(0);
      access.write(new Uint8Array(bytes), { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
    self.postMessage({ id });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
