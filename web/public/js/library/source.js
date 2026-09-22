/* Where a listings library comes from.
 *
 * Two sources, one shape. A self-hosted server lists its designated
 * folder through GET /library and serves files from it; a browser alone
 * opens a folder the user picks. Both hand the reader the same index
 * ({ root, buckets, vehicles: [{ bucket, folder, card, files, images }] })
 * and the same three operations (url, text, json, file), so everything
 * above this file is identical on lotstretcher.org and against a server.
 *
 * The layout both walk is spec.library, the names vehicle_pipeline
 * writes. Neither source knows what a hero image is; that is the
 * reader's business. */

import { get } from '../spec.js';

const CARD_KEYS = ['vin', 'stock_number', 'year', 'make', 'model', 'trim', 'title',
  'condition', 'mileage', 'display_price', 'exterior_color_factory'];
const DERIVED_IMAGE_DIRS = new Set(['cutout', 'wheels', 'upscaled', 'rejected']);
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

const enc = (s) => encodeURIComponent(s);

/* ---------- a server's library --------------------------------------- */

export class HttpSource {
  constructor() { this.kind = 'server'; this.label = 'your server'; }

  async index() {
    const res = await fetch('library', { cache: 'no-store' });
    if (!res.ok) {
      let detail = String(res.status);
      try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
      throw new Error(detail);
    }
    const idx = await res.json();
    this.label = idx.root || this.label;
    return idx;
  }

  url(v, rel) {
    return `library/${enc(v.bucket)}/${enc(v.folder)}/${rel.split('/').map(enc).join('/')}`;
  }

  async text(v, rel) {
    const res = await fetch(this.url(v, rel));
    if (!res.ok) throw new Error(`${res.status} ${rel}`);
    return res.text();
  }

  async json(v, rel) { return JSON.parse(await this.text(v, rel)); }

  /* For reprocessing: a File-like the app's photo intake accepts. */
  async file(v, rel) {
    const res = await fetch(this.url(v, rel));
    if (!res.ok) throw new Error(`${res.status} ${rel}`);
    const blob = await res.blob();
    return new File([blob], rel.split('/').pop(), { type: blob.type });
  }
}

/* ---------- a folder the user picked ---------------------------------- */

/* Built from either a directory handle (File System Access API, Chrome
 * and Edge) or a webkitdirectory FileList (everything else). The
 * FileList route hands over every File up front but reads none of them
 * until asked, so a 20 GB library still opens in a moment. */
export class DirectorySource {
  constructor(tree, label) {
    this.kind = 'folder';
    this.label = label;
    this.tree = tree;        // Map bucket -> Map folder -> Map rel -> File | FileSystemFileHandle
    this.objectUrls = new Map();
  }

  static supportsPicker() { return typeof window.showDirectoryPicker === 'function'; }

  static async pick() {
    if (DirectorySource.supportsPicker()) {
      const handle = await window.showDirectoryPicker({ id: 'lotstretcher-library', mode: 'read' });
      return DirectorySource.fromHandle(handle);
    }
    return DirectorySource.fromInput();
  }

  static async fromHandle(root) {
    const layout = get('library');
    const tree = new Map();
    for (const bucket of layout.buckets) {
      let bucketHandle;
      try { bucketHandle = await root.getDirectoryHandle(bucket); } catch { continue; }
      const folders = new Map();
      for await (const [name, handle] of bucketHandle.entries()) {
        if (handle.kind !== 'directory') continue;
        const files = new Map();
        await walkHandle(handle, '', files);
        if (files.has(layout.details)) folders.set(name, files);
      }
      tree.set(bucket, folders);
    }
    return new DirectorySource(tree, root.name);
  }

  static fromInput() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.onchange = () => {
        const files = input.files;
        if (!files.length) { reject(new Error('no folder chosen')); return; }
        resolve(DirectorySource.fromFileList(files));
      };
      input.oncancel = () => reject(new Error('no folder chosen'));
      input.click();
    });
  }

  static fromFileList(files) {
    const layout = get('library');
    const buckets = new Set(layout.buckets);
    const tree = new Map();
    let rootName = '';
    for (const f of files) {
      // "<root>/<bucket>/<folder>/<rel...>"
      const parts = (f.webkitRelativePath || '').split('/');
      if (parts.length < 4) continue;
      rootName = parts[0];
      const [, bucket, folder, ...rest] = parts;
      if (!buckets.has(bucket)) continue;
      if (!tree.has(bucket)) tree.set(bucket, new Map());
      const folders = tree.get(bucket);
      if (!folders.has(folder)) folders.set(folder, new Map());
      folders.get(folder).set(rest.join('/'), f);
    }
    for (const folders of tree.values()) {
      for (const [name, map] of folders) if (!map.has(layout.details)) folders.delete(name);
    }
    return new DirectorySource(tree, rootName);
  }

  async index() {
    const layout = get('library');
    const vehicles = [];
    for (const [bucket, folders] of this.tree) {
      for (const [folder, map] of folders) {
        const files = [];
        const images = [];
        for (const rel of map.keys()) {
          const parts = rel.split('/');
          if (parts[0] === layout.images) {
            if (parts.slice(1, -1).some((d) => DERIVED_IMAGE_DIRS.has(d))) continue;
            if (IMAGE_EXT.test(rel)) images.push(rel);
            continue;
          }
          if (rel !== layout.details) files.push(rel);
        }
        files.sort(); images.sort();
        let details = {};
        try { details = await this.json({ bucket, folder }, layout.details); } catch { /* card stays thin */ }
        const card = Object.fromEntries(CARD_KEYS.map((k) => [k, details[k] ?? null]));
        const entry = map.get(layout.details);
        const modified = entry instanceof File ? Math.floor(entry.lastModified / 1000) : 0;
        const record = details.vehicle || details;
        vehicles.push({ bucket, folder, modified, card, files, images, delisted: record.delisted_at || null });
      }
    }
    vehicles.sort((a, b) => b.modified - a.modified);
    return { root: this.label, buckets: layout.buckets, vehicles, summary: null };
  }

  async file(v, rel) {
    const entry = this.tree.get(v.bucket)?.get(v.folder)?.get(rel);
    if (!entry) throw new Error(`no such file ${rel}`);
    return entry instanceof File ? entry : entry.getFile();
  }

  /* Object URLs are cached per file, and revoked in release(): a grid of
   * 237 heroes would otherwise leak one blob URL per card per render. */
  async url(v, rel) {
    const key = `${v.bucket}/${v.folder}/${rel}`;
    if (this.objectUrls.has(key)) return this.objectUrls.get(key);
    const u = URL.createObjectURL(await this.file(v, rel));
    this.objectUrls.set(key, u);
    return u;
  }

  async text(v, rel) { return (await this.file(v, rel)).text(); }
  async json(v, rel) { return JSON.parse(await this.text(v, rel)); }

  release() {
    for (const u of this.objectUrls.values()) URL.revokeObjectURL(u);
    this.objectUrls.clear();
  }
}

async function walkHandle(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') out.set(rel, handle);
    else await walkHandle(handle, rel, out);
  }
}
