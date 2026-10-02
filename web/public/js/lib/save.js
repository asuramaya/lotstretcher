/* Save a run into a listings library: the same folder, the same names,
 * the CLI's vehicle_pipeline writes (spec library), so the Library pane,
 * `recompose` and a later run all find one folder per vehicle, whichever
 * surface made it. Where the vehicle goes is the core's (library_place.rs,
 * as scrape.py files a scrape).
 *
 *   <root>/<new|used>/<Year-Make-Model-Trim-Stock>/
 *     details.json              the record (kept fields the CLI added survive)
 *     window-sticker.json/.pdf  the parsed sticker, and the PDF when it was a file
 *     images/exterior/NN.jpg    the originals the stills came from, in walkaround order
 *     images/exterior/cutout/NN.png
 *     images/interior/NN.jpg
 *     bundle/hero*.png          the lead shot in each shape
 *     bundle/framed/NN.png      every square still; portrait/ and horizontal/ the others
 *     bundle/interior/NN.jpg, the clips, the three posts
 *
 * Saving again replaces bundle/ (it is all derived) and overwrites the
 * rest by name, as `lotstretcher <url> --force` does; nothing else in the
 * library is touched. Writing needs a folder handle (Chrome, Edge); the
 * caller falls back to the zip where there is none. */

import { canvasToBlob } from './imageio.js';
import { get as specGet } from '../spec.js';
import { call as coreCall } from '../core.js';
import { walkaround } from '../pipeline/shots.js';
import { DirectorySource } from '../library/source.js';

const nn = (i) => String(i + 1).padStart(2, '0');
const ext = (name, fallback) => (/\.(jpe?g|png|webp|heic|avif)$/i.exec(name || '')?.[0] || fallback).toLowerCase();

/* The record the folder is filed under and that details.json holds: what
 * the listing said, then what the form says now. */
export function savedRecord(state) {
  const record = { ...(state.listing || {}), ...(state.vehicle || {}) };
  delete record.warnings;
  return record;
}

export function placeFor(state) {
  const record = savedRecord(state);
  return coreCall({ op: 'library_place', record, url: record.url || '' });
}

async function original(p) {
  if (p.blob) return p.blob;
  if (!p.url) return null;
  try {
    const r = await fetch(p.url, { mode: 'cors' });
    return r.ok ? await r.blob() : null;
  } catch { return null; }
}

/* Every file of the run, by its path inside the vehicle's folder. */
export async function libraryFiles(state) {
  const layout = specGet('library');
  const b = layout.bundle;
  const files = [];
  const add = (rel, data) => { if (data != null) files.push({ rel, data }); };

  const heroes = walkaround(state.photos.filter((p) => p.hero));
  for (let i = 0; i < heroes.length; i++) {
    const p = heroes[i];
    const src = await original(p);
    if (src) add(`${layout.images}/exterior/${nn(i)}${ext(p.name, '.jpg')}`, src);
    if (p.cutout) add(`${layout.images}/exterior/cutout/${nn(i)}.png`, await canvasToBlob(p.cutout, 'image/png'));
    for (const [fmt, canvas] of Object.entries(p.heroes || { square: p.hero })) {
      const blob = await canvasToBlob(canvas, 'image/png');
      add(fmt === 'square' ? `${b.dir}/${b.framed}/${nn(i)}.png` : `${b.dir}/${fmt}/${nn(i)}.png`, blob);
      if (i === 0) {
        const top = { square: b.hero, portrait: b.heroPortrait, horizontal: b.heroHorizontal }[fmt];
        if (top) add(`${b.dir}/${top}`, blob);
      }
    }
  }

  const interiors = state.photos.filter((p) => p.interior);
  for (let i = 0; i < interiors.length; i++) {
    const p = interiors[i];
    const src = await original(p);
    if (src) add(`${layout.images}/interior/${nn(i)}${ext(p.name, '.jpg')}`, src);
    add(`${b.dir}/${b.interior}/${nn(i)}.jpg`, await canvasToBlob(p.interior, 'image/jpeg', b.interiorQuality / 100));
  }

  for (const [fmt, blob] of Object.entries(state.videos || {})) add(`${b.dir}/${b.videos[fmt] || `hero-video-${fmt}.mp4`}`, blob);
  for (const [platform, text] of Object.entries(state.posts || {})) add(`${b.dir}/${b.posts[platform] || `${platform}.txt`}`, text);
  if (state.sticker) add(layout.sticker.json, JSON.stringify(state.sticker, null, 2));
  if (state.stickerPdf) add(layout.sticker.pdf, state.stickerPdf);
  return files;
}

async function dirAt(root, parts, create = true) {
  let d = root;
  for (const part of parts) d = await d.getDirectoryHandle(part, { create });
  return d;
}

async function write(dir, rel, data) {
  const parts = rel.split('/');
  const name = parts.pop();
  const parent = await dirAt(dir, parts);
  const handle = await parent.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

/* Write the run into `root` (a directory handle with write permission).
 * Returns {bucket, folder, count, replaced}. A folder the command line
 * made (its record has no saved_at) is replaced only when `replaceCli`
 * says so: auto-save never swaps a full CLI bundle for a browser run
 * without a press. */
export class MadeByCli extends Error {}
export async function saveToLibrary(root, state, onProgress = () => {}, { replaceCli = false } = {}) {
  const layout = specGet('library');
  const { bucket, folder } = placeFor(state);
  const files = await libraryFiles(state);
  const dir = await dirAt(root, [bucket, folder]);

  // The record: what the CLI wrote there before (a delist stamp, a
  // manifest key) stays unless this run says otherwise.
  let before = {};
  try { before = JSON.parse(await (await (await dir.getFileHandle(layout.details)).getFile()).text()); } catch { /* new folder */ }
  const prior = before.vehicle || before;
  const existed = Object.keys(prior).length > 0;
  if (existed && !prior.saved_at && !replaceCli) throw new MadeByCli(`${bucket}/${folder}`);
  const record = { ...prior, ...savedRecord(state), saved_at: new Date().toISOString() };

  try { await dir.removeEntry(layout.bundle.dir, { recursive: true }); } catch { /* none yet */ }
  for (let i = 0; i < files.length; i++) {
    await write(dir, files[i].rel, files[i].data);
    onProgress((i + 1) / (files.length + 1));
  }
  await write(dir, layout.details, JSON.stringify(record, null, 2));
  onProgress(1);
  return { bucket, folder, count: files.length + 1, replaced: existed };
}

/* ---- the library folder this device saves into ----
 * The Library pane's own remembered folder (one folder for reading and
 * saving), asked for write access on first save. */
export const canSaveToFolder = () => DirectorySource.supportsPicker();

export async function libraryFolder({ ask = false } = {}) {
  const r = await DirectorySource.remembered();
  if (r) {
    if ((await r.handle.queryPermission({ mode: 'readwrite' })) === 'granted') return r.handle;
    if (!ask) return null;
    return (await r.handle.requestPermission({ mode: 'readwrite' })) === 'granted' ? r.handle : null;
  }
  return ask ? pickLibraryFolder() : null;
}

/* Choose (or change) the folder: from a click only. */
export async function pickLibraryFolder() {
  const handle = await window.showDirectoryPicker({ id: 'lotstretcher-library', mode: 'readwrite' });
  await DirectorySource.remember(handle);
  return handle;
}

/* Per device: save each run as it finishes. */
const AUTO_KEY = 'lotstretcher.autoSave';
export function autoSave() { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } }
export function setAutoSave(on) { try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* storage blocked */ } }
