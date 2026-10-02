/* App orchestration.
 *
 * No framework. The state is small enough that a plain object plus
 * explicit render calls is both shorter and easier to follow than any
 * reactive layer would be, and it keeps third-party JavaScript at zero --
 * which is part of what makes the privacy claim on the landing page
 * checkable rather than just stated.
 *
 * The one rule: mutate `state`, then call the matching render function.
 * Never write to the DOM from anywhere else. */

import {
  initConfigFromSpec, LIMITS, IMAGE_EXTS,
  MIN_ANGLE_CONFIDENCE, MIN_SCENE_CONFIDENCE, INTERIOR_LEAN, EXTERIOR_LEAN, MAX_SOURCE_SIDE, modelKeys,
} from './config.js';
import { initRuntime, runtime, loadModel, totalBytes, prefetchModels, modelsCached } from './pipeline/runtime.js';
import { classifyScene, classifyAngle, loadLabels } from './pipeline/classify.js';
import { matte, cutOut } from './pipeline/matte.js';
import { composeHero } from './pipeline/compose.js';
import { renderHeroVideoHere, videoThreads, setVideoThreads, isSupported as videoSupported } from './pipeline/video.js';
import { CoreWorker } from './pipeline/core-worker.js';
import { buildAllPosts, vehicleTitle, PLATFORMS } from './pipeline/copy.js';
import { decode, makeCanvas, ctxOf, canvasToBlob, pixelsOf } from './lib/imageio.js';
import * as OPTS from './options.js';
import {
  loadOptions, saveOptions, resetOptions, initFromSpec, serialisable,
} from './options.js';
import { store, blobToCanvas } from './lib/store.js';
import { loadSpec, get as specGet } from './spec.js';
import { loadCore, version as coreVersion, enhanceInterior, call as coreCall } from './core.js';
import { mountBrand, wireSurfaceLinks } from './chrome.js';
import { Preview } from './preview.js';
import { loadCapabilities, can, isSelfHosted, whyUnavailable } from './host.js';
import { renderControls, controlsToFlags, affectsPreview, renderLooks, openSubTab } from './controls.js';
import { loadAssets, needsServer, composeOnServer, scrapeOnServer, libraryOps } from './lib/delegate.js';
import { image as libraryImage } from './lib/library.js';
import { textOptions, textRequest, stillOptions, clipOptions, stockFrame } from './lib/text.js';
import { describesVehicle, recordFromHtml, fetchListing } from './pipeline/listing.js';
import { recordFromText } from './pipeline/vin.js';
import { LibraryView } from './library/view.js';
import { el } from './lib/widgets.js';
import { canvasItem, openLightbox, wireLightbox } from './lib/lightbox.js';
import { cropRows, sameShotAs, walkaround, clipOrder } from './pipeline/shots.js';
import { saveOne, saveInterior, downloadBundle } from './lib/bundle.js';
import { studioArt } from './lib/studio-art.js';
import { HttpSource, DirectorySource } from './library/source.js';

const $ = (id) => document.getElementById(id);

const state = {
  pane: 'booth',
  photos: [],            // { id, name, blob|url, thumb, status, scene, angle, cutout, hero }
  uploads: { customBackground: [], customFrame: [] }, // the user's own images, by file control
  vehicle: {},
  dealer: {},
  running: false,
  done: false,
  posts: null,
  videos: null,
  sticker: null,
  options: null,
  errors: [],
  lookVisited: false,
};

let nextId = 1;
let preview = null;
const { swatchArt, lookArt } = studioArt(() => preview?.subject?.() || null);

/* The rail is a checklist: a step is ticked once it has what it needs.
 * Called from every render that can change that. */
function renderSteps() {
  const done = {
    booth: state.photos.length > 0 || !!(state.vehicle.make || state.vehicle.model || state.vehicle.exterior_color),
    options: state.lookVisited,
    results: state.done,
  };
  for (const btn of document.querySelectorAll('.nav-btn')) {
    btn.classList.toggle('is-done', !!done[btn.dataset.go]);
  }
  // The studio needs the cut-outs: its step opens once they exist.
  const ready = state.photos.length > 0 && !state.preparing && state.prepared?.key === photoKey();
  const studio = document.querySelector('.nav-btn[data-go="options"]');
  if (studio) { studio.disabled = !ready; studio.title = ready ? '' : state.photos.length ? 'Sorting and cutting out the photos first' : 'Add photos first'; }
}

/* ---------- persistence -------------------------------------------
 * localStorage holds the dealer block; IndexedDB (lib/store.js) holds
 * the person's own images and the car in progress (SESSION_KEY). All
 * per-viewer, on this device only. localStorage is a
 * per-viewer convenience, it never contains a photo or anything derived
 * from one, and every access is wrapped because it throws in a private
 * window and returns empty after a site-data clear. */
const DEALER_KEY = 'lotstretcher.dealer';

function loadDealer() {
  try {
    const raw = localStorage.getItem(DEALER_KEY);
    if (raw) state.dealer = JSON.parse(raw) || {};
  } catch { /* private window, blocked storage -- the app works without it */ }
}

function saveDealer() {
  try { localStorage.setItem(DEALER_KEY, JSON.stringify(state.dealer)); } catch { /* ignore */ }
}

/* ---------- the car in progress, kept on this device ----------------
 * A refresh, a back-swipe or a closed tab used to lose everything. The
 * photos (as the files or links they came in as), the vehicle fields,
 * the listing and sticker reads and the step are saved to IndexedDB
 * on this device as they change, and offered back on the next load as
 * Resume or Discard. Once the sort and cut has finished, its result
 * (each photo's scene and angle, the cutouts and lifted interiors) is
 * saved with them, so a resumed car opens the studio at once rather
 * than being sorted and cut again; a run's stills are not kept. */
const SESSION_KEY = 'session';
const FORM_IDS = ['f-year', 'f-make', 'f-model', 'f-trim', 'f-ext', 'f-int', 'f-price', 'f-miles', 'f-vin', 'f-stock', 'f-cond'];
const EXTRA_KEYS = ['engine', 'transmission', 'drivetrain', 'seating'];
let sessionTimer = null;
function saveSessionSoon() { clearTimeout(sessionTimer); sessionTimer = setTimeout(saveSession, 400); }
async function saveSession() {
  if (state.restoring) return;
  const fields = Object.fromEntries(FORM_IDS.map((id) => [id, $(id).value]));
  // The preparation is saved only once it is finished and for these
  // very photos; a canvas goes in as a PNG, encoded once per cutout.
  const done = !!state.prepared && !state.preparing && state.prepared.key === photoKey();
  const asBlob = async (p, field) => {
    const c = p[field];
    if (!c) return null;
    const memo = `${field}Blob`;
    if (p[memo]?.for !== c) p[memo] = { for: c, blob: await canvasToBlob(c, 'image/png') };
    return p[memo].blob;
  };
  const photos = [];
  for (const p of state.photos) {
    const entry = {
      name: p.name, blob: p.blob || null, url: p.url || null, source: p.source || 'chosen',
      userScene: !!p.userScene, scene: p.userScene ? p.scene : null, rejected: !!p.rejected,
    };
    if (done) {
      Object.assign(entry, {
        scene: p.scene || null, sceneConf: p.sceneConf ?? null, angle: p.angle || null, angleConf: p.angleConf ?? null,
        angleUncertain: !!p.angleUncertain, coverage: p.coverage ?? null, ambiguous: p.ambiguous ?? null,
        status: p.status, error: p.error || null,
        cutout: await asBlob(p, 'cutout'), interior: await asBlob(p, 'interior'),
      });
    }
    photos.push(entry);
  }
  if (state.restoring) return;
  try {
    if (!photos.length && !Object.values(fields).some((v) => v && v.trim())) { await store.del(SESSION_KEY); return; }
    await store.set(SESSION_KEY, {
      v: 2, savedAt: Date.now(), pane: ['booth', 'options'].includes(state.pane) ? state.pane : 'booth',
      prepared: done ? { stages: state.prepared.stages.slice(0, 3).map((st) => ({ ...st })), options: [state.options.interiors, state.options.cutType] } : null,
      fields, photos, listing: state.listing || null, sticker: state.sticker || null,
      extras: Object.fromEntries(EXTRA_KEYS.filter((k) => state.vehicle?.[k]).map((k) => [k, state.vehicle[k]])),
    });
  } catch { /* private window or blocked storage: the app works without it */ }
}
async function discardSession() {
  try { await store.del(SESSION_KEY); } catch { /* ignore */ }
  $('resumeBox').innerHTML = '';
}
async function restoreSession(s) {
  state.restoring = true;
  for (const [id, v] of Object.entries(s.fields || {})) if ($(id) && v) $(id).value = v;
  state.listing = s.listing || null;
  state.sticker = s.sticker || null;
  // The saved preparation counts only for the cut the options ask for now.
  const prepared = s.prepared && s.prepared.options?.[0] === state.options.interiors && s.prepared.options?.[1] === state.options.cutType
    ? s.prepared : null;
  for (const p of s.photos || []) {
    if (state.photos.length >= LIMITS.maxPhotos) break;
    const photo = { id: nextId++, name: p.name, status: 'ready', source: p.source };
    if (p.blob) { photo.blob = p.blob; photo.thumb = URL.createObjectURL(p.blob); }
    else if (p.url) { photo.url = p.url; photo.thumb = p.url; }
    else continue;
    if (p.userScene) { photo.userScene = true; photo.scene = p.scene; photo.rejected = p.rejected; if (p.rejected) photo.scene = photo.scene || 'unsure'; }
    if (prepared) {
      Object.assign(photo, {
        scene: p.scene || photo.scene, sceneConf: p.sceneConf ?? undefined, angle: p.angle || null, angleConf: p.angleConf ?? undefined,
        angleUncertain: !!p.angleUncertain, coverage: p.coverage ?? undefined, ambiguous: p.ambiguous ?? undefined,
        rejected: p.rejected || false, status: p.status || 'sorted', error: p.error || undefined,
      });
      if (p.cutout) photo.cutout = await blobToCanvas(p.cutout);
      if (p.interior) photo.interior = await blobToCanvas(p.interior);
    }
    state.photos.push(photo);
  }
  readVehicle();
  for (const [k, v] of Object.entries(s.extras || {})) state.vehicle[k] = v;
  if (prepared) {
    // The sort and cut as it was: a run takes it, the studio draws it.
    const exteriors = state.photos.filter((p) => p.scene === 'exterior' && !p.rejected);
    state.prepared = { key: photoKey(), promise: Promise.resolve(exteriors), stages: prepared.stages };
  }
  state.restoring = false;
  renderPhotos();
  $('resumeBox').innerHTML = '';
  go(s.pane === 'options' ? 'options' : 'booth');
  if (prepared && preview?.getUserCutout?.()) preview.subjectChanged();
}
async function offerResume() {
  // Nothing is saved (or wiped) until the saved car has been looked at.
  state.restoring = true;
  let s = null;
  try { s = await store.get(SESSION_KEY); } catch { s = null; }
  if (!s || (!s.photos?.length && !s.fields?.['f-make'] && !s.fields?.['f-vin'])) { state.restoring = false; return; }
  const f = s.fields || {};
  const title = [f['f-year'], f['f-make'], f['f-model'], f['f-trim']].filter(Boolean).join(' ') || 'a vehicle';
  const n = s.photos?.length || 0;
  const mins = Math.max(1, Math.round((Date.now() - (s.savedAt || Date.now())) / 60000));
  const ago = mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  const box = $('resumeBox');
  box.innerHTML = '';
  const b = el('div', 'banner');
  b.append(el('div', 'grow', `${title}${n ? `, ${n} photo${n === 1 ? '' : 's'}` : ''}, left ${ago}.`));
  const yes = el('button', 'btn btn-primary btn-sm', 'Resume');
  yes.onclick = () => restoreSession(s);
  const no = el('button', 'btn btn-ghost btn-sm', 'Discard');
  no.onclick = () => { discardSession(); state.restoring = false; };
  b.append(yes, no);
  box.appendChild(b);
  // Until Resume or Discard, edits made meanwhile save over the offer.
  const arm = () => { state.restoring = false; };
  for (const id of FORM_IDS) $(id).addEventListener('input', arm, { once: true });
  state.armSession = arm;
}

/* ---------- navigation --------------------------------------------- */
function go(pane) {
  state.pane = pane;
  document.querySelector('.app')?.setAttribute('data-pane', pane);
  // The step is part of the saved car, so a resume lands where it left.
  if (state.photos.length && !state.restoring) saveSessionSoon();
  for (const p of ['booth', 'options', 'results', 'library']) {
    $(`pane-${p}`).hidden = p !== pane;
  }
  for (const btn of document.querySelectorAll('.nav-btn')) {
    if (btn.dataset.go === pane) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  if (pane === 'results') $('resultsDot').classList.add('hidden');
  if (pane === 'options') {
    state.lookVisited = true;
    // The stage draws the vehicle's own record: its title, its paint.
    readVehicle();
    // The preview is drawn only while it can be seen.
    preview?.update();
    // On a phone the panel is a card: the first visit opens the Looks
    // card so the Studio never reads as an empty stage with a bar.
    const studio = document.querySelector('.studio');
    if (studio && !state.studioOpened && !studio.classList.contains('panel-open')
        && getComputedStyle(studio.querySelector('.studio-panel')).position === 'absolute') {
      state.studioOpened = true;
      studio.querySelector('.studio-rail .tool[role="tab"]')?.click();
    }
  }
  $(`pane-${pane}`).scrollTop = 0;
  renderSteps();
}

/* A sheet takes the focus while it is open and gives it back when it
 * closes; whatever it started (the VIN camera) stops on its 'close'. */
let sheetOpener = null;
function openSheet(id) {
  sheetOpener = document.activeElement;
  $(id).hidden = false;
  // The dialog itself, not its first field: that would raise a phone's keyboard.
  const body = $(id).querySelector('.sheet-body');
  if (body) { body.tabIndex = -1; body.focus(); }
}
function closeSheet(id) {
  const sheet = $(id);
  if (sheet.hidden) return;
  sheet.hidden = true;
  sheet.dispatchEvent(new Event('close'));
  sheetOpener?.focus?.();
  sheetOpener = null;
}

/* ---------- adding photos ------------------------------------------ */
function isImageName(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

const SOURCE_LABEL = { listing: 'from the listing', chosen: 'chosen', folder: 'from a folder', captured: 'captured', links: 'from links', dropped: 'dropped', pasted: 'pasted' };
async function addFiles(files, source = 'chosen') {
  const images = [...files].filter((f) => f.type.startsWith('image/') || isImageName(f.name));
  if (!images.length) return;

  // A folder picker returns entries in whatever order the filesystem
  // hands them over, which is not the order a human named them in.
  images.sort((a, b) => (a.webkitRelativePath || a.name)
    .localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));

  // The same file twice (picked again, or in two folders) is one photo:
  // a size and content hash each photo keeps settle it.
  let skipped = 0;
  for (const file of images) {
    if (state.photos.length >= LIMITS.maxPhotos) break;
    const digest = await fileDigest(file);
    if (digest && state.photos.some((q) => q.digest === digest)) { skipped++; continue; }
    state.photos.push({
      digest,
      id: nextId++,
      name: file.name,
      blob: file,
      thumb: URL.createObjectURL(file),
      status: 'ready',
      source,
    });
  }
  state.skippedDuplicates = skipped;
  renderPhotos();
}

async function fileDigest(file) {
  try {
    const buf = await file.arrayBuffer();
    const h = await crypto.subtle.digest('SHA-256', buf);
    return `${file.size}:${[...new Uint8Array(h).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { return null; }
}

function addUrls(text, source = 'links') {
  const urls = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  let skipped = 0;
  for (const url of urls) {
    if (state.photos.length >= LIMITS.maxPhotos) break;
    if (!/^https?:\/\//i.test(url)) continue;
    if (state.photos.some((q) => q.url === url)) { skipped++; continue; }
    state.photos.push({
      id: nextId++,
      name: url.split('/').pop().split('?')[0] || 'photo',
      url,
      thumb: url,
      status: 'ready',
      source,
    });
  }
  state.skippedDuplicates = skipped;
  renderPhotos();
}

function removePhoto(id) {
  if (state.running) return;
  const i = state.photos.findIndex((p) => p.id === id);
  if (i < 0) return;
  const p = state.photos[i];
  if (p.blob && p.thumb) URL.revokeObjectURL(p.thumb);
  state.photos.splice(i, 1);
  state.skippedDuplicates = 0;
  renderPhotos();
}

function clearPhotos() {
  if (state.running) return;
  for (const p of state.photos) if (p.blob && p.thumb) URL.revokeObjectURL(p.thumb);
  state.photos = [];
  state.done = false;
  state.posts = null;
  state.videos = null;
  state.skippedDuplicates = 0;
  renderPhotos();
  renderResults();
}

/* ---------- rendering ---------------------------------------------- */
function renderPhotos() {
  const n = state.photos.length;
  $('photosSection').hidden = n === 0;
  $('photoCount').textContent = `${n} photo${n === 1 ? '' : 's'}`;
  if (n && state.armSession && state.restoring) { state.armSession(); $('resumeBox').innerHTML = ''; }
  saveSessionSoon();
  // Where they came from, in the head: "23 from the listing · 4 captured".
  const by = {};
  for (const p of state.photos) by[p.source || 'chosen'] = (by[p.source || 'chosen'] || 0) + 1;
  const dupes = state.skippedDuplicates ? [`${state.skippedDuplicates} already here, skipped`] : [];
  setStatus('photosStatus', [...Object.entries(by).map(([k, c]) => `${c} ${SOURCE_LABEL[k] || k}`), ...dupes].join(' · '), 'ok');
  // A changed photo set starts any preparation over, and the sort and
  // cut start on their own once the adding has settled.
  if (state.prepared && state.prepared.key !== photoKey() && !state.preparing) state.prepared = null;
  clearTimeout(preloadTimer);
  if (n && !state.running && !state.preparing && !state.restoring) preloadTimer = setTimeout(preload, 600);
  // A strip, so the vehicle fields stay a glance below; a tile opens
  // the lightbox.
  $('photoGrid').classList.add('is-strip');
  // With photos in, the drop zone folds to one row of ways to add more.
  $('dropzone').classList.toggle('has-photos', n > 0);
  $('pickBtn').textContent = n > 0 ? 'Add more' : 'Add photos';
  $('runBtn').disabled = !(n > 0 && !state.running);
  renderSteps();

  const warn = $('warnBox');
  warn.innerHTML = '';
  if (n > LIMITS.softPhotoWarn) {
    const b = el('div', 'banner');
    b.append(el('div', null,
      `${n} photos. On a phone this will take several minutes and the tab has to stay open. ` +
      `Fewer photos, or a laptop, will be considerably faster.`));
    warn.appendChild(b);
  }

  const grid = $('photoGrid');
  grid.innerHTML = '';
  for (const p of state.photos) {
    const tile = el('div', 'tile');
    tile.classList.toggle('is-working', p.status === 'working');
    tile.classList.toggle('is-pending', p.status === 'ready' && state.running);

    const img = el('img');
    // The app is cross-origin isolated (COEP require-corp), which blocks
    // a plain cross-origin image; asking for CORS lets one the CDN
    // allows (the dealer's does) through, and the decode uses CORS too.
    if (p.url) img.crossOrigin = 'anonymous';
    img.src = p.thumb;
    img.alt = p.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    // A URL photo can fail CORS; show it as failed rather than as a
    // silently broken image icon.
    img.onerror = () => { if (!p.unreachable) { p.unreachable = true; renderPhotos(); } };
    if (p.unreachable) { tile.classList.add('is-pending'); tile.append(tagOf('unreachable')); }
    tile.appendChild(img);

    // The sort is a suggestion: the tag is a button that corrects it.
    const said = p.unreachable ? null : p.rejected ? 'skipped' : p.scene ? (p.angle ? `${p.scene} · ${angleLabel(p.angle)}` : p.scene) : null;
    const tag = said ? el('button', 'tile-tag tile-tag-btn', said) : null;
    if (tag) {
      tag.type = 'button';
      tag.setAttribute('aria-label', `${p.name}: ${said}. Change`);
      if (p.userScene) tag.classList.add('is-user');
      tag.title = 'Wrong? Tap to change';
      tag.onclick = (e) => { e.stopPropagation(); if (!state.running) pickScene(p, tag); };
      tile.appendChild(tag);
    }
    openable(tile, img, `Open ${p.name}`, () => openLightbox(boothItems(), state.photos.indexOf(p)));

    if (!state.running) {
      const x = el('button', 'tile-x', '×');
      x.setAttribute('aria-label', `Remove ${p.name}`);
      x.onclick = (e) => { e.stopPropagation(); removePhoto(p.id); };
      tile.appendChild(x);
    }
    grid.appendChild(tile);
  }
}

function tagOf(text) { return el('span', 'tile-tag', text); }

/* A tile opens on a click anywhere on it; its picture is what a
 * keyboard reaches and opens with Enter or Space, so the tile's own
 * buttons (the scene tag, the ×) stay separate controls. */
function openable(tile, pic, label, open) {
  tile.onclick = open;
  pic.tabIndex = 0;
  pic.setAttribute('role', 'button');
  pic.setAttribute('aria-label', label);
  pic.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
}

/* The angle the classifier gives, as words. */
const ANGLE_WORDS = { front: 'Front', front_3q: 'Front \u00be', side: 'Side', rear_3q: 'Rear \u00be', rear: 'Rear', hero: 'Hero' };
// An angle the model would not commit to reads as a plain exterior, not
// "Hero" (which the lead shot is, whatever its angle).
function angleLabel(angle) { return ANGLE_WORDS[angle] || angle || 'Exterior'; }

function renderStages(stages) {
  const list = $('stageList');
  list.innerHTML = '';
  for (const s of stages) {
    const row = el('div', `stage ${s.state}`);
    const mark = el('span', 'mark', s.state === 'done' ? '✓' : s.n);
    row.append(mark, el('span', null, s.label), el('span', 'xs dim', s.detail || ''));
    list.appendChild(row);
  }
}

function setProgress(frac) {
  const pct = Math.round(frac * 100);
  $('progBar').style.width = `${pct}%`;
  $('progPct').textContent = `${pct}%`;
  topProgress(frac);
}

/* The one progress line, along the header's edge, and the words beside
 * the Process button: a fraction, 'busy' for an indeterminate wait, or
 * null to hide. Seen from every step. */
let topText = '';
function topProgress(value, text = null) {
  const bar = $('appProgress');
  bar.hidden = value === null;
  // Nothing done yet reads as a slide, not an empty track.
  bar.classList.toggle('is-indeterminate', value === 'busy' || value === 0);
  if (typeof value === 'number') bar.firstElementChild.style.width = `${Math.round(value * 100)}%`;
  if (text !== null || value === null) topText = text || '';
  $('appStatus').textContent = typeof value === 'number' && value > 0 && topText ? `${topText} ${Math.round(value * 100)}%` : topText;
}

/* What the results grid shows, encoded once: a still or interior as a
 * small JPEG, a clip as its blob, each by its object URL while it is on
 * screen and revoked when a later run replaces it. renderResults runs
 * once per composed photo, so encoding afresh each time re-did every
 * thumbnail and left every URL behind. */
const shownUrls = new Map();   // canvas or blob -> Promise<object URL>
function shownUrl(key, side) {
  if (!shownUrls.has(key)) {
    shownUrls.set(key, key instanceof Blob ? Promise.resolve(URL.createObjectURL(key)) : (async () => {
      const k = side / Math.max(key.width, key.height);
      const c = makeCanvas(Math.round(key.width * k), Math.round(key.height * k));
      ctxOf(c).drawImage(key, 0, 0, c.width, c.height);
      return URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.85));
    })());
  }
  return shownUrls.get(key);
}
function forgetShown(live) {
  for (const [key, url] of shownUrls) {
    if (!live.has(key)) { url.then((u) => URL.revokeObjectURL(u)).catch(() => {}); shownUrls.delete(key); }
  }
}

function renderResults() {
  const live = new Set();
  const heroes = walkaround(state.photos.filter((p) => p.hero));
  const interiors = state.photos.filter((p) => p.interior);

  // Working: the stages open. Done: one line of what was made, folded.
  const prog = $('progressSection');
  if (state.running) { prog.open = true; $('progHead').textContent = 'Working'; }
  else if (state.done) {
    prog.open = false;
    const stills = heroes.reduce((n, p) => n + Object.keys(p.heroes || { square: p.hero }).length, 0);
    const clips = Object.keys(state.videos || {}).length;
    const parts = [`${stills} image${stills === 1 ? '' : 's'}`];
    if (interiors.length) parts.push(`${interiors.length} interior${interiors.length === 1 ? '' : 's'}`);
    if (clips) parts.push(`${clips} clip${clips === 1 ? '' : 's'}`);
    $('progHead').textContent = `Made ${parts.join(', ')} from ${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}`;
    if (state.runMs) $('progPct').textContent = state.runMs < 90000 ? `${Math.round(state.runMs / 1000)} s` : `${Math.round(state.runMs / 60000)} min`;
  }

  const tab = document.querySelector('.nav-btn[data-go="results"]');
  tab.disabled = !state.running && heroes.length === 0 && interiors.length === 0;
  // A badge only while the user is looking at something else.
  $('resultsDot').classList.toggle('hidden', !(state.done && state.pane !== 'results'));

  $('heroSection').hidden = heroes.length === 0 && interiors.length === 0;
  $('copySection').hidden = !state.posts;
  $('resultsEmpty').hidden = heroes.length > 0 || interiors.length > 0 || state.running;

  const interiorHost = $('interiorGrid');
  $('interiorSection').hidden = interiors.length === 0;
  interiorHost.innerHTML = '';
  for (const p of interiors) {
    const tile = el('div', 'tile is-captioned');
    const pic = el('div', 'tile-pic');
    pic.style.aspectRatio = `${p.interior.width} / ${p.interior.height}`;
    const img = el('img');
    live.add(p.interior);
    shownUrl(p.interior, 420).then((u) => { img.src = u; });
    img.alt = `Interior photo ${p.name}, corrected`;
    pic.append(img);
    tile.append(pic, tagOf('interior'));
    interiorHost.appendChild(tile);
  }
  const interiorItems = interiors.map((p) => canvasItem(p.interior, p.name, 'interior', () => saveInterior(state, p)));
  [...interiorHost.children].forEach((tile, i) => openable(tile, tile.querySelector('img'), `Open interior ${interiors[i].name}`, () => openLightbox(interiorItems, i)));

  // One tile per still, grouped by shape: a row of squares, a row of
  // portraits, a row of horizontals, each tile in its own proportions,
  // so a tall portrait never stretches a square's row.
  const grid = $('resultGrid');
  grid.innerHTML = '';
  const stillItems = [];
  const byFormat = new Map();
  for (const p of heroes) {
    for (const [fmt, canvas] of Object.entries(p.heroes || { square: p.hero })) {
      if (!byFormat.has(fmt)) byFormat.set(fmt, []);
      byFormat.get(fmt).push([p, canvas]);
    }
  }
  const order = Object.keys(OPTS.HERO_FORMATS);
  const formats = [...byFormat.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const fmt of formats) {
    const label = OPTS.HERO_FORMATS[fmt]?.label || fmt;
    const group = el('section', 'shape-group');
    if (formats.length > 1) group.append(el('h3', 'shape-head', label));
    const row = el('div', `grid shape-grid is-${fmt}`);
    for (const [p, canvas] of byFormat.get(fmt)) {
      // The tag is a caption under the picture, not a chip over it:
      // the still's own text may sit in any corner now.
      const tile = el('div', 'tile is-captioned');
      const pic = el('div', 'tile-pic');
      pic.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
      const img = el('img');
      live.add(canvas);
      shownUrl(canvas, 640).then((u) => { img.src = u; });
      img.alt = `${label} still from ${p.name}`;
      pic.append(img);
      tile.append(pic, tagOf(angleLabel(p.angle)));
      stillItems.push(canvasItem(canvas, `${p.name} \u00b7 ${label}`, angleLabel(p.angle), () => saveOne(state, p, fmt)));
      const at = stillItems.length - 1;
      openable(tile, img, `Open ${label} still from ${p.name}`, () => openLightbox(stillItems, at));
      row.appendChild(tile);
    }
    group.append(row);
    grid.appendChild(group);
  }

  const videoHost = $('videoGrid');
  if (videoHost) {
    const clips = Object.entries(state.videos || {});
    $('videoSection').hidden = clips.length === 0;
    videoHost.innerHTML = '';
    for (const [fmt, blob] of clips) {
      const wrap = el('figure', 'clip');
      const v = document.createElement('video');
      live.add(blob);
      shownUrl(blob).then((u) => { v.src = u; });
      v.controls = true; v.loop = true; v.muted = true; v.playsInline = true;
      v.preload = 'metadata';
      const cap = el('figcaption', 'xs dim',
        `${OPTS.VIDEO_FORMATS[fmt].label} \u00b7 ${(blob.size / 1e6).toFixed(1)} MB`);
      wrap.append(v, cap);
      videoHost.appendChild(wrap);
    }
  }

  forgetShown(live);

  const copyList = $('copyList');
  copyList.innerHTML = '';
  if (state.posts) {
    for (const platform of PLATFORMS) {
      const wrap = el('div');
      const head = el('div', 'row', null);
      head.append(el('strong', 'grow', platform[0].toUpperCase() + platform.slice(1)));
      const btn = el('button', 'btn btn-sm', 'Copy');
      btn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(state.posts[platform]);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } catch { btn.textContent = 'Press and hold to copy'; }
      };
      head.appendChild(btn);
      wrap.append(head, el('div', 'copybox', state.posts[platform]));
      wrap.style.marginBottom = 'var(--s-4)';
      copyList.appendChild(wrap);
    }
  }
}


/* The vehicle's own title, as the Text tool's Words field shows it
 * empty: year make model trim, whichever are filled. */
function vehicleTitleWords() {
  return ['year', 'make', 'model', 'trim'].map((k) => ($(`f-${k}`)?.value || '').trim()).filter(Boolean).join(' ');
}

function renderOptions() {
  const o = state.options;

  $('videoNote').textContent = o.videoFormats.length
    ? 'Rendered after the stills, about twice realtime on a laptop; the '
      + 'time above is measured on this device.'
    : 'No video. Stills only, which is faster on a phone.';

  // The looks: one tap sets several controls, then the pane is drawn
  // again so every lever shows the value the look gave it.
  const applyLook = (lk) => {
    Object.assign(o, lk.values);
    commitOptions();
    renderOptions();
    preview?.update();
  };
  renderLooks($('looksHost'), o, applyLook, { tileFor: lookArt });
  // The tiles are drawn on the preview's subject: a new sample redraws them.
  if (preview) preview.onSubjectChange = () => renderLooks($('looksHost'), o, applyLook, { tileFor: lookArt });

  // The three tools the spec does not describe (the looks, what a run
  // makes, this host) are parked in #studioParts and moved into the
  // panel while theirs is open, so their ids stay live for the code
  // above. Everything else is a spec group.
  const parts = $('studioParts');
  for (const id of ['looksPart', 'outputPart']) parts.appendChild($(id));
  const part = (id) => (body) => body.appendChild($(id));
  const head = renderControls($('controlsHost'), o, (key, value, live) => {
    o[key] = value;
    // A slider mid-drag: redraw the preview and nothing else, so the
    // slider under the finger is not rebuilt.
    if (live) { if (affectsPreview(key)) preview?.update(); return; }
    // Which upload is chosen is remembered by its id; the images
    // themselves live in IndexedDB, since the options blob is JSON.
    if (key === 'customBackground' || key === 'customFrame') {
      o[`${key}Id`] = value?.uploadId || null;
    }
    commitOptions();
    // A moved lever may make or break a look: the chips say which.
    renderLooks($('looksHost'), o, applyLook, { tileFor: lookArt });
    if (affectsPreview(key)) preview?.update(); else preview?.renderEstimates();
  }, {
    thumbFor: swatchArt,
    rail: $('studioRail'),
    // On a phone the panel is a card: a tool opens it, the same tool
    // again (or its ×) closes it and gives the stage the screen back.
    onOpen: (id, { keep = false } = {}) => {
      const studio = document.querySelector('.studio');
      const wasOpen = studio.classList.contains('panel-open');
      if (wasOpen && id === state.studioTool && !keep) studio.classList.remove('panel-open');
      else studio.classList.add('panel-open');
      state.studioTool = id;
      renderOptions();
      preview?.update();
    },
    before: [{ id: 'looks', label: 'Looks', hint: 'One tap, several levers', render: part('looksPart') }],
    after: [{ id: 'output', label: 'Output', hint: 'What a run makes, and the command line', render: part('outputPart') }],
    // Settings supplies the Text tool's default line.
    placeholders: { subtitle: state.dealer.greeting ? `Optional, e.g. ${state.dealer.greeting}` : null, titleText: vehicleTitleWords() || null },
    uploads: state.uploads,
    onUpload: addUpload,
    onRemoveUpload: removeUpload,
  });
  $('panelTitle').textContent = head?.label || '';
  // On a phone the Studio hides the page tabs to give the stage their
  // room; the rail's first button goes back to the photos instead.
  const rail = $('studioRail');
  if (!rail.querySelector('.tool-back')) {
    const back = el('button', 'tool tool-back');
    back.type = 'button';
    back.title = 'Back to the photos';
    back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Photos</span>';
    back.onclick = () => go('booth');
    rail.prepend(back);
  }
  const badge = $('panelBadge');
  badge.hidden = !head?.badge;
  if (head?.badge) { badge.textContent = head.badge[0]; badge.className = `ctrl-badge ${head.badge[1]}`; }

  // Built from the same control definitions the pane renders, so the
  // echo cannot describe a flag the UI does not actually have.
  const formatFlags = o.heroFormats.map((f) => `--hero-format ${f}`)
    .concat(o.videoFormats.length
      ? o.videoFormats.map((f) => `--video-format ${f}`)
      : ['--no-video']);
  $('cliEcho').textContent =
    `lotstretcher ./photos ${[...formatFlags, ...controlsToFlags(o)].join(' ')}`;
}

/* The user's own images, one list per file control, kept in IndexedDB
 * as blobs so they are there next time and can be chosen again. */
async function saveUploads(key) {
  try {
    await store.set(`uploads:${key}`, state.uploads[key].map((c) => ({ id: c.uploadId, name: c.name || '', blob: c.sourceBlob })));
  } catch { /* blocked storage */ }
}
function addUpload(key, canvas) {
  canvas.uploadId = crypto.randomUUID();
  canvas.name = canvas.name || 'Your image';
  state.uploads[key].push(canvas);
  saveUploads(key);
}
function removeUpload(key, canvas) {
  state.uploads[key] = state.uploads[key].filter((c) => c !== canvas);
  saveUploads(key);
  // Dropping the chosen image falls back to the default backdrop or frame.
  if (state.options[key] === canvas) {
    state.options[key] = null;
    state.options[`${key}Id`] = null;
    if (key === 'customBackground' && state.options.backdrop === 'custom') state.options.backdrop = 'vehicle';
    if (key === 'customFrame' && state.options.border === 'custom') state.options.border = 'none';
  }
  commitOptions();
  preview?.update();
}

/* The host panel.
 *
 * Gated features are LISTED whether or not they are available, with the
 * reason when they are not. A capability that simply vanishes on the
 * public site teaches people the app is inconsistent; one that says
 * "needs your own machine" teaches them what the self-hosted surface is
 * for. */
const GATED = [
  ['scrape', 'Scrape a listing page', 'Pull photos and specs straight from a VDP'],
  ['inventorySync', 'Inventory sync', 'Work a whole lot on a schedule'],
  ['batch', 'Batch processing', 'More vehicles than a tab can hold'],
  ['upscale', 'Upscaling', 'SwinIR or Real-ESRGAN on a GPU'],
];

function renderHost() {
  const badge = $('hostBadge');
  const selfHosted = isSelfHosted();
  badge.textContent = selfHosted ? 'self-hosted' : 'lotstretcher.org';
  badge.className = selfHosted ? 'pill pill-ok' : 'pill';

  $('hostNote').textContent = selfHosted
    ? 'Running against your own lotstretcher server. Same app as the '
      + 'website, with the things a browser alone cannot do switched on.'
    : 'Running entirely in this browser. The features below need a '
      + 'lotstretcher server on your own machine.';

  // The runtime, for the iOS checklist: threads, isolation, the core.
  $('aboutRuntime').textContent = (runtime.isolated
    ? `threads: ${runtime.threads} · SIMD: on · cross-origin isolated`
    : 'single-threaded (no cross-origin isolation)')
    + ` · core: wasm v${coreVersion()} on the page`
    + (CoreWorker.supported()
      ? (self.crossOriginIsolated ? '; a run uses the threaded core in a worker' : '; a run uses a worker, single-threaded (not isolated)')
      : '; no worker here, a run composes on the page');

  const list = $('hostCaps');
  list.innerHTML = '';
  for (const [key, label, hint] of GATED) {
    const row = el('div', 'opt');
    const text = el('div', 'opt-text');
    text.append(el('strong', null, label),
      el('span', null, can(key) ? hint : whyUnavailable(key, specGet)));
    row.append(text, el('span', can(key) ? 'pill pill-ok' : 'pill', can(key) ? 'on' : 'off'));
    list.appendChild(row);
  }
}

function commitOptions() {
  saveOptions(state.options);
  renderOptions();
}

/* A shape ticked under the stage goes into (or out of) the run.
 * Deselecting the last still format would leave the run with nothing
 * to produce, and it silently fell back to square anyway, so the echo
 * and the behaviour disagreed. Keep one selected instead. */
function toggleFormat(kind, key) {
  const list = kind === 'video' ? state.options.videoFormats : state.options.heroFormats;
  const i = list.indexOf(key);
  if (i >= 0 && !(kind === 'still' && list.length === 1)) list.splice(i, 1);
  else if (i < 0) list.push(key);
  commitOptions();
  preview?.renderEstimates();
  preview?.update();
}

/* ---------- the run ------------------------------------------------ */
/* Passes 1 and 2: load the models, sort every photo, cut out the
 * exteriors (and lift the interiors). Shared by a run and by the
 * preload that starts when the booth is left, so the Look step shows
 * the real vehicle. Returns the exteriors. */
async function sortAndCut(stages, errors) {
  // The photos as they were when the sort began: one added, removed or
  // cleared meanwhile changes the key, and the result is not reused.
  const photos = [...state.photos];
  try {
    /* Where the time goes, per step, summed over the photos: shown in
     * the stage list and kept on state.timings for the bench page and
     * automation. */
    const T = state.timings = { models: 0, decode: 0, scene: 0, matte: 0, cut: 0, angle: 0, interior: 0, photos: 0, exteriors: 0 };
    const clock = (key, t0) => { T[key] += performance.now() - t0; };
    let t0 = performance.now();
    await initRuntime();
    $('isolationWarn').classList.toggle('hidden', runtime.isolated);

    await loadLabels();
    await Promise.all([
      loadModel('scene', (f) => setProgress(f * 0.2)),
      loadModel('angle'),
      loadModel(modelKeys(state.options.cutoutModel)[2]),
    ]);
    clock('models', t0);
    stages[0].state = 'done';
    stages[0].detail = `${(T.models / 1000).toFixed(1)} s, kept on this device`;
    stages[1].state = 'active';
    renderStages(stages);

    // --- pass 1: scene. Runs on every photo, so it is the hot path.
    const total = photos.length;
    for (let i = 0; i < total; i++) {
      const p = photos[i];
      // What an earlier sort or run made of it does not carry over; only
      // a person's own word on the scene (and a skip) does.
      Object.assign(p, { cutout: null, angle: null, angleConf: null, angleUncertain: false, onTrial: false,
        interior: null, error: null, hero: null, heroes: null, ambiguous: null, coverage: null });
      if (p.rejected !== true || !p.userScene) p.rejected = false;
      p.status = 'working';
      renderPhotos();
      try {
        t0 = performance.now();
        const bitmap = await decode(p.blob || p.url, MAX_SOURCE_SIDE);
        clock('decode', t0);
        p.bitmap = bitmap;
        // A dealer's known junk graphic (a reviews card, "photos coming
        // soon") is set aside before anything looks at it, by the core's
        // pHash against the spec's templates, as the CLI's photos.py does.
        const junk = p.userScene ? null
          : coreCall({ op: 'junk_match', hash: coreCall({ op: 'phash', image: { $image: 0 } }, [pixelsOf(bitmap)]) });
        if (junk) { p.rejected = `a dealer's stock graphic (${junk.replace(/\.[a-z]+$/, '')})`; p.scene = 'unsure'; }
        else if (p.userScene) { /* the person said what it is; the model does not argue */ }
        // Sorting off (the CLI's --no-photo-sort): every photo is tried as
        // an exterior, and the cutout gate keeps what is a whole vehicle.
        else if (!state.options.photoSort) { p.scene = 'exterior'; }
        else {
        t0 = performance.now();
        // Only the classification view loses a dealer's saturated banner
        // (core letterbox.rs, as the CLI's evaluate_photo does); the photo
        // itself keeps it. Measured on the 413 library photos with one: the
        // scene model was right on 409 raw and 411 stripped, none worse.
        const [bt, bb] = coreCall({ op: 'detect_banner', image: { $image: 0 } }, [pixelsOf(bitmap)]);
        const scene = await classifyScene(cropRows(bitmap, bt, bb));
        clock('scene', t0);
        p.sceneConf = scene.confidence;
        // Too weak to route on. Keep the photo, do not act on the guess.
        p.scene = scene.confidence >= MIN_SCENE_CONFIDENCE ? scene.label : 'unsure';
        // A wide cabin shot can land in 'detail' by a hair (spec confidence.interiorLean).
        if (p.scene === 'detail' && (scene.scores.interior || 0) >= INTERIOR_LEAN) { p.scene = 'interior'; p.sceneConf = scene.scores.interior; }
        // A whole car can land there too (a straight-on rear with the
        // spare): tried as an exterior, kept only if its cutout clears
        // the frame (spec confidence.exteriorLean).
        else if (p.scene === 'detail' && (scene.scores.exterior || 0) >= EXTERIOR_LEAN) { p.scene = 'exterior'; p.onTrial = true; }
        }
      } catch (e) {
        p.status = 'failed';
        p.error = String(e.message || e);
        errors.push(`${p.name}: ${p.error}`);
      }
      if (p.status !== 'failed') p.status = 'sorted';
      setProgress(0.2 + 0.15 * ((i + 1) / total));
      renderPhotos();
    }
    stages[1].state = 'done';

    // Interiors: the photograph itself, neutralised and lifted by the
    // core, at its own size, the same treatment the CLI's bundle/interior
    // gets. No cutout, no compositing: rembg cannot cut out a cabin.
    if (state.options.interiors) {
      const inside = photos.filter((p) => p.scene === 'interior' && !p.rejected && p.status !== 'failed');
      // A vendor's flat letterbox bars come off first, at the size most of
      // the batch agrees on (core letterbox.rs, as the CLI's photos.py
      // does): one vendor pads a whole gallery alike, and a photo whose own
      // edge fades too gradually to find still gets the batch's crop.
      t0 = performance.now();
      const bars = inside.map((p) => {
        try { return coreCall({ op: 'detect_bars', image: { $image: 0 } }, [pixelsOf(p.bitmap)]); } catch { return [0, 0]; }
      });
      const [top, bottom] = inside.length ? coreCall({ op: 'batch_bars', bars }) : [0, 0];
      clock('interior', t0);
      for (const p of inside) {
        try {
          t0 = performance.now();
          p.interior = enhanceInterior(cropRows(p.bitmap, top, bottom));
          clock('interior', t0);
        } catch (e) {
          errors.push(`${p.name}: ${e.message || e}`);
        }
      }
    }
    // cut_type "none" is the server's classify-only mode: sort the
    // photos, compose nothing.
    const exteriors = state.options.cutType === 'none'
      ? []
      : photos.filter((p) => p.scene === 'exterior' && !p.rejected);
    stages[1].detail = `${exteriors.length} exterior, ${total - exteriors.length} other`;
    stages[2].state = 'active';
    renderStages(stages);

    // --- pass 2: matte + angle, exteriors only. The expensive pass:
    // ~960ms per photo against ~38ms for classification.
    for (let i = 0; i < exteriors.length; i++) {
      const p = exteriors[i];
      p.status = 'working';
      renderPhotos();
      try {
        t0 = performance.now();
        const m = await matte(p.bitmap, null, modelKeys(state.options.cutoutModel)[2]);
        clock('matte', t0);
        t0 = performance.now();
        // Judged by the core's gate (gate.rs) and cropped to its box, as
        // the CLI's cutout.py and photos.py do.
        const { canvas: cutCanvas, gate } = cutOut(p.bitmap, m, state.options.strictCutouts);
        clock('cut', t0);
        p.ambiguous = gate.ambiguous;
        p.coverage = gate.coverage;

        if (p.onTrial) {
          // On trial (a whole car the scene model called a detail): a
          // close-up touches the frame's edges, a whole car stands clear.
          p.onTrial = false;
          if (gate.fills_frame) {
            p.scene = 'detail';
            p.status = 'sorted';
            setProgress(0.35 + 0.45 * ((i + 1) / Math.max(1, exteriors.length)));
            renderPhotos();
            continue;
          }
        }

        const twin = gate.ok ? sameShotAs(cutCanvas, exteriors.slice(0, i)) : null;
        if (!gate.ok) {
          p.rejected = gate.reason;
        } else if (twin) {
          // The same shot uploaded twice (re-saved, resized, or pasted
          // from two links): composed once, not twice.
          p.rejected = `the same shot as ${twin.name}`;
        } else {
          p.cutout = cutCanvas;
          const cutBitmap = await createImageBitmap(await canvasToBlob(cutCanvas));
          t0 = performance.now();
          const angle = await classifyAngle(cutBitmap);
          clock('angle', t0);
          /* Only assert an angle we actually believe. A wheel close-up
           * that slips past the scene classifier scores ~0.33 here, and
           * calling it "front_3q" anyway is precisely the kind of
           * confident error that makes the whole output untrustworthy. */
          if (angle.confidence >= MIN_ANGLE_CONFIDENCE) {
            p.angle = angle.label;
            p.angleConf = angle.confidence;
          } else {
            p.angle = null;
            p.angleConf = angle.confidence;
            p.angleUncertain = true;
          }
        }
      } catch (e) {
        p.error = String(e.message || e);
        errors.push(`${p.name}: ${p.error}`);
      }
      p.status = p.cutout ? 'cut' : 'failed';
      setProgress(0.35 + 0.45 * ((i + 1) / Math.max(1, exteriors.length)));
      renderPhotos();
    }
    stages[2].state = 'done';
    T.photos = total;
    T.exteriors = exteriors.length;
    const each = (ms) => (ms / Math.max(1, exteriors.length) / 1000).toFixed(2);
    stages[2].detail = `${exteriors.filter((p) => p.cutout).length} cut out · ${each(T.matte + T.cut)} s a photo`;
    console.info('[lotstretcher] prepare timings (ms)', JSON.stringify(Object.fromEntries(Object.entries(T).map(([k, v]) => [k, Math.round(v)]))));
    stages[3].state = 'active';
    renderStages(stages);

    return exteriors;
  } finally {
    // The decoded sources are the largest thing held, and nothing needs
    // them once the cutouts and interiors exist.
    for (const p of photos) { p.bitmap?.close?.(); p.bitmap = null; }
  }
}

/* What the photos and the options that shape a cut amount to; a
 * preparation is only reused for the same. */
function photoKey() {
  return JSON.stringify([state.photos.map((p) => [p.id, p.userScene ? (p.rejected ? 'skip' : p.scene) : null]), state.options.interiors, state.options.cutType, state.options.cutoutModel, state.options.photoSort]);
}

/* The sort-and-cut for the current photos: the preload's, awaited, when
 * it is for these photos; started here otherwise. */
async function prepared(stages) {
  // A preload for photos that have since changed finishes first: two
  // sorts on the same photos would close each other's bitmaps.
  if (state.preparing && state.prepared?.key !== photoKey()) await state.prepared?.promise.catch(() => {});
  const key = photoKey();
  const prep = state.prepared;
  if (prep?.key === key) {
    const exteriors = await prep.promise;
    state.errors.push(...(prep.errors || []));
    for (const st of stages.slice(0, 3)) st.state = 'done';
    Object.assign(stages[0], prep.stages[0]); Object.assign(stages[1], prep.stages[1]); Object.assign(stages[2], prep.stages[2]);
    stages[3].state = 'active';
    renderStages(stages);
    return exteriors;
  }
  // The run's own sort is a preparation too, so the preload that
  // follows the run does not do it all again.
  const errors = [];
  const promise = sortAndCut(stages, errors);
  state.prepared = { key, promise, stages, errors };
  promise.catch(() => { if (state.prepared?.promise === promise) state.prepared = null; });
  const exteriors = await promise;
  state.errors.push(...errors);
  return exteriors;
}

function runStages() {
  return [
    { n: 1, label: 'Loading models', state: 'active', detail: `${(totalBytes(modelKeys(state.options.cutoutModel)) / 1e6).toFixed(0)} MB, first run only` },
    { n: 2, label: 'Sorting photos', state: '' },
    { n: 3, label: 'Removing backgrounds', state: '' },
    { n: 4, label: 'Composing', state: '' },
  ];
}

/* Start sorting and cutting out as soon as the booth is left, so the
 * Look step previews the real vehicle rather than a sample. A run that
 * follows takes the result; a photo added later starts it over. */
let preloadTimer = null;
function preload() {
  if (state.running || state.preparing || !state.photos.length) return;
  const key = photoKey();
  if (state.prepared?.key === key) return;
  const stages = runStages();
  $('progressSection').hidden = false;
  renderStages(stages);
  setProgress(0);
  state.preparing = true;
  topProgress(0, `Sorting and cutting out ${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}…`);
  renderSteps();
  const errors = [];
  const promise = (async () => {
    try {
      return await sortAndCut(stages, errors);
    } finally {
      state.preparing = false;
      topProgress(null);
      renderPhotos();
      // A finished preparation for the same photos: prepare again if they changed meanwhile.
      if (state.prepared?.key !== photoKey()) { state.prepared = null; renderPhotos(); }
      if (preview?.getUserCutout?.()) preview.subjectChanged();
    }
  })();
  state.prepared = { key, promise, stages, errors };
  promise.catch((e) => { state.prepared = null; console.warn('preload failed:', e); });
}

async function run() {
  if (state.running || !state.photos.length) return;
  state.running = true;
  state.done = false;
  state.runStart = performance.now();
  let cw = null;   // the run's core worker, ended in `finally`
  state.errors = [];
  setVideoThreads(0);
  $('runBtn').disabled = true;
  go('results');
  topProgress(0, 'Processing…');
  $('progressSection').hidden = false;
  $('resultsEmpty').hidden = true;
  setProgress(0);

  const stages = runStages();
  renderStages(stages);

  try {
    // Sorting and cutting out may already have run when the booth was
    // left (preload); a run waits for it and takes its result.
    const exteriors = await prepared(stages);

    // --- pass 3: compose.
    readVehicle();
    const cut = walkaround(exteriors.filter((p) => p.cutout));
    const formats = state.options.heroFormats.length ? state.options.heroFormats : ['square'];
    const vid = state.vehicle.vin || state.vehicle.stock_number || 'v';
    // Nothing an earlier run made is shown or bundled with this one's.
    for (const p of state.photos) { p.hero = null; p.heroes = null; }
    state.videos = null;

    // Only when the user actually switched a server-only control on. A
    // self-hosted user who changed nothing still composes locally, which
    // is faster and keeps the round trip off the common path.
    const delegating = needsServer(state.options, specGet);
    if (delegating) {
      stages[3].label = 'Composing on your server';
      renderStages(stages);
    }
    // The threaded core in a worker does the stills and the clip when
    // it can, one worker for the run; the page composes when it cannot.
    if (!delegating && CoreWorker.supported()) {
      try { cw = new CoreWorker(); setVideoThreads(await cw.init()); } catch (e) { console.warn('core worker unavailable:', e); cw?.terminate(); cw = null; }
    }
    // A stock backdrop or frame the site ships is composed here, from
    // its own file; the core fits the frame to each format.
    const stockBackground = !delegating && state.options.backdrop === 'asset'
      ? await libraryImage('backgrounds', state.options.background) : null;
    const stockBorder = !delegating && stockFrame(state.options)
      ? await libraryImage('borders', state.options.border) : null;
    // A name remembered from another host (a server's private frame,
    // opened later on the site) is not in this library: say so rather
    // than compose on the gradient or frameless as if nothing was asked.
    if (!delegating && state.options.backdrop === 'asset' && !stockBackground) {
      state.errors.push(`background "${state.options.background || ''}" is not in this library; the stills use the gradient`);
    }
    if (!delegating && stockFrame(state.options) && !stockBorder) {
      state.errors.push(`frame "${state.options.border}" is not in this library; the stills are frameless`);
    }

    // What the Studio asks for, mapped once for every still and the clip.
    const look = stillOptions(state.options);
    const text = await textRequest(state.vehicle, textOptions(state.options));
    for (let i = 0; i < cut.length; i++) {
      const p = cut[i];
      p.heroes = {};
      for (const fmt of formats) {
        const [w, h] = OPTS.HERO_FORMATS[fmt].size;

        /* When the run asks for something only a server can do (a stock
         * backdrop, a branded frame, GPU upscaling), hand THIS cutout to
         * it. Only the cutout travels: the source photograph stays on
         * the device, because matting already happened here. */
        if (delegating) {
          try {
            const { blob, warnings } = await composeOnServer(p.cutout, {
              width: w, height: h,
              seed: `${vid}:${p.name}:${fmt}`,
              exteriorColor: state.vehicle.exterior_color,
              interiorColor: state.vehicle.interior_color,
              ...serialisable(state.options),
              // The form's record, for a title or price badge; no photo.
              vehicle: state.vehicle,
            });
            // Normalise to a canvas: everything downstream (the result
            // grid, the bundle) expects one, not a bitmap.
            const bmp = await createImageBitmap(blob);
            const c = makeCanvas(bmp.width, bmp.height);
            ctxOf(c).drawImage(bmp, 0, 0);
            bmp.close?.();
            p.heroes[fmt] = c;
            for (const warning of warnings) {
              if (!state.errors.includes(warning)) state.errors.push(warning);
            }
            continue;
          } catch (e) {
            // Fall through to composing locally rather than producing
            // nothing; the user still gets an image, and the reason the
            // server could not help is reported.
            state.errors.push(`${p.name}: ${e.message || e}`);
          }
        }

        /* Each format is composed from the cutout, never cropped from
         * another format. Cropping a square down to 4:5 cuts the
         * vehicle's nose off; recomposing re-fits it to the new box. */
        const composeOpts = {
          ...look,
          seed: `${vid}:${p.name}:${fmt}`,
          exterior: state.vehicle.exterior_color,
          interior: state.vehicle.interior_color,
          width: w, height: h,
          // The user's own images, the browser's --photo-background and
          // --border: drawn by the core exactly as the CLI's are.
          background: state.options.backdrop === 'custom' ? state.options.customBackground || null : stockBackground,
          border: state.options.border === 'custom' ? state.options.customFrame || null : stockBorder,
          text,
        };
        if (cw) {
          try { p.heroes[fmt] = await cw.compose(p.cutout, composeOpts); }
          catch (e) { console.warn('core worker compose fell back to the page:', e); p.heroes[fmt] = composeHero(p.cutout, composeOpts); }
        } else {
          p.heroes[fmt] = composeHero(p.cutout, composeOpts);
        }
      }
      // The first format is the one shown in the grid.
      p.hero = p.heroes[formats[0]];
      /* Reserve the tail of the bar for video when it is coming, or the
       * bar reaches 100% and then the app carries on working, which
       * reads as a hang. */
      const composeCeiling = state.options.videoFormats.length ? 0.85 : 1.0;
      setProgress(0.8 + (composeCeiling - 0.8) * ((i + 1) / Math.max(1, cut.length)));
      renderResults();
    }

    /* Video last, and only when asked. It is by far the heaviest stage,
     * and the stills are what most people came for, so they land first
     * and stay usable while this runs. */
    const wantVideo = state.options.videoFormats.filter((f) => OPTS.VIDEO_FORMATS[f]);
    if (wantVideo.length && cut.length && videoSupported()) {
      // The clip sits on the same backdrop as the stills: a stock photo
      // from the studio, the user's own, or the turning gradient. A
      // server-only photo is composed by the server for stills; the clip
      // is rendered here, so it falls back to the gradient and says so.
      const videoBackground = state.options.backdrop === 'custom' ? state.options.customBackground || null
        : state.options.backdrop === 'asset' ? (stockBackground || await libraryImage('backgrounds', state.options.background)) : null;
      if (state.options.backdrop === 'asset' && !videoBackground) {
        state.errors.push('video: that background lives on your server; the clip uses the gradient');
      }
      stages.push({ n: 5, label: 'Rendering video', state: 'active' });
      renderStages(stages);
      state.videos = {};
      const clipShots = clipOrder(cut);
      for (const fmt of wantVideo) {
        const [w, h] = OPTS.VIDEO_FORMATS[fmt].size;
        try {
          const videoOpts = {
            // One or two shots are a push with crossfades (core carousel.rs).
            ...clipOptions(state.options),
            angles: clipShots.map((p) => p.angle || null),
            width: w, height: h,
            seed: `${vid}:video:${fmt}`,
            exterior: state.vehicle.exterior_color,
            interior: state.vehicle.interior_color,
            text,
            background: videoBackground,
            vehicle: state.vehicle,
            onProgress: (f) => setProgress(0.85 + 0.15 * f),
          };
          const shots = clipShots.map((p) => p.cutout);
          if (cw) {
            try { state.videos[fmt] = await cw.video(shots, videoOpts); }
            catch (e) { console.warn('core worker video fell back to the page:', e); state.videos[fmt] = await renderHeroVideoHere(shots, videoOpts); }
          } else {
            state.videos[fmt] = await renderHeroVideoHere(shots, videoOpts);
          }
        } catch (e) {
          state.errors.push(`video ${fmt}: ${e.message || e}`);
        }
      }
      const made = Object.keys(state.videos).length;
      stages[4].state = 'done';
      // Where it was rendered: the worker's threaded core, or the page.
      const where = videoThreads() ? ` on ${videoThreads()} threads` : '';
      stages[4].detail = made ? `${made} clip${made === 1 ? '' : 's'}${where}` : 'failed';
      renderStages(stages);
    }

    state.posts = buildAllPosts(state.vehicle, { dealer: state.dealer });
    stages[3].state = 'done';
    stages[3].detail = `${cut.length} image${cut.length === 1 ? '' : 's'}`;
    renderStages(stages);
    setProgress(1);
    state.runMs = performance.now() - state.runStart;
    state.done = true;

    if (state.errors.length) {
      const b = el('div', 'banner banner-err');
      // Photos that failed and things that fell back alike: each said once.
      const n = state.errors.length;
      b.append(el('div', null, n === 1 ? state.errors[0] : `${n} problems:`));
      if (n > 1) for (const m of state.errors.slice(0, 6)) b.append(el('div', null, `· ${m}`));
      if (n > 6) b.append(el('div', null, `and ${n - 6} more`));
      $('stageList').appendChild(b);
    }
  } catch (e) {
    const b = el('div', 'banner banner-err');
    b.append(el('div', null, String(e.message || e)));
    $('stageList').appendChild(b);
  } finally {
    cw?.terminate();
    state.running = false;
    topProgress(null);
    $('runBtn').disabled = !state.photos.length;
    renderPhotos();
    renderResults();
    // A cut-out vehicle of the user's own is now a preview subject.
    preview?.subjectChanged();
  }
}

/* ---------- output -------------------------------------------------- */
let stepsTimer = null;
function renderStepsSoon() {
  clearTimeout(stepsTimer);
  stepsTimer = setTimeout(() => { renderSteps(); preview?.update(); }, 0);
}

function readVehicle() {
  renderStepsSoon();
  saveSessionSoon();
  // Spec fields come from the sticker and have no form input; carry them
  // across the rebuild rather than losing them on every run.
  const carried = {};
  for (const k of EXTRA_KEYS) {
    if (state.vehicle?.[k]) carried[k] = state.vehicle[k];
  }
  /* The record is scrape.Vehicle-shaped, because the copy builders are
   * ports of the CLI's and read the same field names. A listing that was
   * imported supplies everything the form has no box for (description,
   * features, MPG); the form wins for anything it does have. */
  const milesText = $('f-miles').value.replace(/[^0-9]/g, '');
  const ext = $('f-ext').value.trim();
  const int = $('f-int').value.trim();
  state.vehicle = {
    ...(state.listing || {}),
    ...carried,
    year: $('f-year').value.trim() || null,
    make: $('f-make').value.trim() || null,
    model: $('f-model').value.trim() || null,
    trim: $('f-trim').value.trim() || null,
    condition: $('f-cond').value || state.listing?.condition || null,
    exterior_color_factory: ext || null,
    interior_color: int || null,
    // The compositor's names for the same two colours.
    exterior_color: ext,
    display_price: $('f-price').value.trim() || null,
    mileage: milesText ? Number(milesText) : null,
    vin: $('f-vin').value.trim() || null,
    stock_number: $('f-stock').value.trim() || null,
    sticker: state.sticker || null,
  };
  state.vehicle.title = vehicleTitle(state.vehicle) || null;
  state.dealer = {
    name: $('f-dealer').value.trim(),
    greeting: $('f-greeting').value.trim(),
    address: $('f-address').value.trim(),
    city_tags: $('f-citytags').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  saveDealer();
}

/* ---------- window sticker import ------------------------------------
 * The CLI shells out to poppler for this; in the browser pdf.js supplies
 * the same positioned text. Loaded lazily, so the 1.7MB costs nothing
 * unless someone actually uses it. */
async function importSticker(source) {
  const note = $('stickerNote');
  $('stickerRow').classList.remove('is-ok');
  note.textContent = 'Reading the PDF...';
  try {
    const { parseSticker, stickerToVehicle, stickerPriceApplies } = await import('./pipeline/sticker.js');
    const parsed = await parseSticker(source);

    if (parsed.placeholder) {
      note.textContent = 'That PDF holds no sticker: it says the sticker is not published yet or the link has expired.';
      return;
    }

    const fields = stickerToVehicle(parsed);
    const map = {
      year: 'f-year', make: 'f-make', model: 'f-model', trim: 'f-trim',
      exterior_color: 'f-ext', interior_color: 'f-int', vin: 'f-vin',
    };
    let filled = 0;
    // The sticker's total is the price only when the car is sold new.
    // Taken as new on its model year alone, the condition says so too:
    // the post copy (core copy.rs) reads only the stated condition, and
    // would otherwise write a sticker price up as a used car's.
    if (fields.msrp && stickerPriceApplies($('f-cond').value, fields.year || $('f-year').value)) {
      fields.price = fields.msrp;
      map.price = 'f-price';
      if (!$('f-cond').value) $('f-cond').value = 'New';
    }
    for (const [key, id] of Object.entries(map)) {
      // Never overwrite something the user typed themselves.
      if (fields[key] && !$(id).value.trim()) { $(id).value = fields[key]; filled++; }
    }
    /* Keep the whole parse, not just the form fields: equipment,
     * optional equipment and the spec lines feed the post copy, and
     * there is nowhere on the form to put them. */
    state.sticker = parsed;
    for (const k of EXTRA_KEYS) {
      if (parsed[k]) state.vehicle[k] = parsed[k];
    }

    const extras = [];
    const optional = parsed.optional_equipment?.length || 0;
    const standard = Object.values(parsed.equipment || {}).reduce((n, a) => n + a.length, 0);
    if (optional) extras.push(`${optional} option${optional === 1 ? '' : 's'}`);
    if (standard) extras.push(`${standard} standard features`);
    const readWhat = extras.join(' · ');

    // Said in the Vehicle head, after whatever the listing said; the
    // sticker row itself goes green.
    note.textContent = '';
    $('stickerRow').classList.add('is-ok');
    const said = $('vehicleStatus').textContent;
    setStatus('vehicleStatus', [said, readWhat].filter(Boolean).join(' · ') || 'Sticker read', 'ok');
  } catch (e) {
    // A CORS refusal is the common case and deserves a plain explanation
    // rather than the browser's own wording.
    const msg = /fetch|CORS|NetworkError/i.test(String(e))
      ? 'That host will not allow the browser to read the PDF. Download it and pick the file instead.'
      : String(e.message || e);
    note.textContent = msg;
  }
}

/* A listing address or a VIN, from the sheet or a paste. Decoded here
 * on every host; a server that can scrape reads the page, and if it
 * cannot, what the address says still fills the form. Resolves true
 * when something was applied. */
async function importListingText(text, note = () => {}) {
  const isUrl = /^https?:\/\//i.test(text);
  const local = recordFromText(text);
  // A listed dealer's page, read on the site through /api/vdp: the photos,
  // the price and the rest, as the CLI's scrape gets them.
  if (isUrl && !can('scrape')) {
    note('Reading the dealer\'s page…');
    try {
      const record = await fetchListing(text);
      if (record) { applyVehicle(record); return true; }
    } catch (e) {
      note(`${String(e.message || e)}. Filled what the address says instead.`);
      local.warnings.push(`The page could not be read (${String(e.message || e)}); only the address was read.`);
    }
  }
  if (!isUrl || !can('scrape')) {
    if (!local.vin && !local.year && !local.make) { note(local.warnings.join(' ') || 'That is neither an address nor a VIN.'); return false; }
    applyVehicle(local);
    return true;
  }
  note('Your server is reading the page. A Cloudflare challenge can take a few seconds.');
  try {
    applyVehicle(await scrapeOnServer(text));
  } catch (e) {
    note(`${String(e.message || e)}. Filled what the address says instead.`);
    local.warnings.push(`Your server could not read the page (${String(e.message || e)}); only the address was read.`);
    applyVehicle(local);
  }
  return true;
}

/* Pasted or dropped text on the Photos step, routed by what it is:
 * image links become photos, an address or a VIN is a listing. */
const IMAGE_LINK = /\.(jpe?g|png|webp|gif|avif|heic)(\?|$)|\/resize\/\d+x\d+\//i;
const looksLikeHtml = (text) => /^\s*<(!doctype|html|head|body|script|div|meta)/i.test(text) || /<script[\s>]/i.test(text) && text.length > 2000;
function readPastedText(text) {
  if (looksLikeHtml(text)) { readListingHtmlRef?.(text, 'the pasted source'); return true; }
  const tokens = String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) return false;
  const links = tokens.filter((t) => /^https?:\/\//i.test(t) && IMAGE_LINK.test(t));
  if (links.length) { addUrls(links.join('\n')); return true; }
  const one = tokens.length === 1 ? tokens[0] : null;
  if (one && (/^https?:\/\//i.test(one) || one.replace(/[^A-Za-z0-9]/g, '').length === 17)) {
    importListingText(one, (m) => showSourceNote(m));
    return true;
  }
  return false;
}

let readListingHtmlRef = null;
function showSourceNote(text) { setStatus('vehicleStatus', text); }

/* ---------- listing import --------------------------------------------
 * Fill the app from a scrape.Vehicle-shaped record, whichever route it
 * came in by: the address or VIN decoded here, a saved page read here,
 * or the server's /scrape. */
function applyVehicle(v) {
  const map = {
    year: 'f-year', make: 'f-make', model: 'f-model', trim: 'f-trim',
    exterior_color_factory: 'f-ext', interior_color: 'f-int',
    display_price: 'f-price', mileage: 'f-miles', vin: 'f-vin', stock_number: 'f-stock',
  };
  let filled = 0;
  for (const [key, id] of Object.entries(map)) {
    if (v[key] != null && v[key] !== '' && !$(id).value.trim()) { $(id).value = String(v[key]); filled++; }
  }
  if (v.condition && !$('f-cond').value) $('f-cond').value = v.condition;
  if (v.dealer_name && !$('f-dealer').value.trim()) $('f-dealer').value = v.dealer_name;
  if (v.dealer_address && !$('f-address').value.trim()) $('f-address').value = v.dealer_address;
  readVehicle();
  for (const k of EXTRA_KEYS) {
    if (v[k]) state.vehicle[k] = v[k];
  }
  state.listing = v;

  v.photo_urls = v.photo_urls || []; v.warnings = v.warnings || [];
  if (v.photo_urls.length) addUrls(v.photo_urls.join('\n'), 'listing');

  // What was read is said in the heads of the sections it filled, not
  // in a box: the photo count beside Photos, the vehicle beside Vehicle.
  setStatus('vehicleStatus', v.title || 'a vehicle', 'ok');
  $('detailsNote').innerHTML = '';
  for (const w of v.warnings) $('detailsNote').appendChild(el('p', 'status-warn', w));

  /* A sticker link is read straight away: it carries the option list
   * and MSRP the analytics blob does not, and typed fields are never
   * overwritten by it. */
  if (v.window_sticker_url) importSticker(v.window_sticker_url);
  go('booth');
}

/* A small menu on a tile's tag: what this photo really is. The choice
 * is kept as the person's own (userScene), survives the next sort, and
 * an exterior that was not cut out yet gets cut on the next run. */
function pickScene(p, anchor) {
  document.querySelector('.scene-menu')?.remove();
  const menu = el('div', 'scene-menu');
  for (const [value, label] of [['exterior', 'Exterior'], ['interior', 'Interior'], ['detail', 'Detail'], ['skip', 'Skip this one']]) {
    const b = el('button', 'scene-choice', label);
    b.type = 'button';
    if ((value === 'skip' && p.rejected) || (value !== 'skip' && !p.rejected && p.scene === value)) b.setAttribute('aria-pressed', 'true');
    b.onclick = (e) => {
      e.stopPropagation();
      menu.remove();
      if (value === 'skip') { p.rejected = true; p.userScene = true; }
      else { p.rejected = false; p.scene = value; p.userScene = true; p.sceneConf = 1; if (value !== 'exterior') { p.cutout = null; p.angle = null; } }
      // A corrected sort is a different preparation.
      state.prepared = null;
      renderPhotos();
    };
    menu.appendChild(b);
  }
  anchor.parentElement.appendChild(menu);
  // A keyboard lands on the first choice; Escape puts it back on the tag.
  menu.querySelector('button')?.focus();
  menu.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); menu.remove(); anchor.focus(); } };
  const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', away, true); } };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
}

/* A section head's status line. */
function setStatus(id, text, tone = '') {
  const s = $(id);
  s.textContent = text;
  s.className = `head-status${tone ? ` is-${tone}` : ''}`;
}

/* The booth's photos as lightbox items. */
function boothItems() {
  return state.photos.map((p) => ({
    src: p.thumb, name: p.name, cors: !!p.url,
    tag: p.rejected ? 'skipped' : p.scene ? (p.angle ? `${p.scene} · ${angleLabel(p.angle)}` : p.scene) : '',
  }));
}

/* The first visit downloads the models (56MB) while the person is still
 * picking photos, not after, and says so in the top bar; later visits
 * find them on the device and say nothing. Skipped on a data saver:
 * then they load when the first photo needs them. */
async function warmModels() {
  if (navigator.connection?.saveData) return;
  const keys = modelKeys(state.options.cutoutModel);
  if (await modelsCached(keys)) return;
  const label = `Getting ready, first visit only (${(totalBytes(keys) / 1e6).toFixed(0)} MB)`;
  const quiet = () => state.preparing || state.running;
  if (!quiet()) topProgress(0, label);
  try {
    await prefetchModels((f) => { if (!quiet()) topProgress(f, label); }, keys);
  } catch { /* the first photo will try again */ }
  if (!quiet()) topProgress(null);
}

/* ---------- wiring --------------------------------------------------- */
async function init() {
  // Chrome first: it must not depend on the spec loading, or a spec
  // failure would also strand the user with no way back.
  mountBrand($('brandSlot'));
  wireSurfaceLinks();

  /* The shared spec loads BEFORE anything reads a constant. Both this
   * client and the Python pipeline read shared/pipeline-spec.json, so a
   * value changed in one place cannot silently differ in the other. */
  try {
    await loadSpec();
    initConfigFromSpec(specGet);
    // The Rust core does the compositing. There is no JavaScript
    // fallback: a host that cannot load it says so, loudly, here.
    await loadCore();
    initFromSpec();
    // Which host this is decides what to unlock. Asked once, and a
    // failed probe leaves everything locked rather than open.
    await loadCapabilities();
    // The asset library, if this host has one. Empty on a static host.
    await loadAssets();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="banner banner-err" style="margin:var(--s-4)">`
      + `Could not load the pipeline spec or the core: ${e.message}. `
      + `The app cannot run without it.</div>`);
    throw e;
  }

  // Spec defaults first, then anything this device saved. A control
  // added since the last visit therefore arrives at its spec default
  // rather than undefined.
  state.options = loadOptions();
  // "Your words" is the title's On with the Words field filled now; a
  // saved custom title keeps its words under the vehicle mode.
  if (state.options.titleMode === 'custom') state.options.titleMode = 'vehicle';
  // The user's own images, kept on this device: every upload of each
  // kind, and which one is chosen (by id, in the options blob). An
  // image saved by an older build as the single choice joins the list.
  state.uploads = { customBackground: [], customFrame: [] };
  for (const key of ['customBackground', 'customFrame']) {
    const list = state.uploads[key];
    let legacy = null;
    try {
      for (const u of (await store.get(`uploads:${key}`)) || []) {
        const canvas = await blobToCanvas(u.blob);
        if (canvas) { canvas.uploadId = u.id; canvas.name = u.name; list.push(canvas); }
      }
      if (!list.length) {
        legacy = await blobToCanvas(await store.get(key));
        if (legacy) { legacy.uploadId = crypto.randomUUID(); legacy.name = 'Your image'; list.push(legacy); await saveUploads(key); await store.del(key); }
      }
    } catch { /* blocked storage: the list is simply empty */ }
    const chosenId = state.options[`${key}Id`];
    state.options[key] = list.find((c) => c.uploadId === chosenId) || legacy || null;
  }
  warmModels();
  loadDealer();
  $('f-dealer').value = state.dealer.name || '';
  $('f-greeting').value = state.dealer.greeting || '';
  $('f-address').value = state.dealer.address || '';
  $('f-citytags').value = (state.dealer.city_tags || []).join(', ');

  for (const btn of document.querySelectorAll('.nav-btn')) {
    btn.onclick = () => go(btn.dataset.go);
  }
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.onclick = () => closeSheet(btn.dataset.close);
  }
  for (const sheet of document.querySelectorAll('.sheet')) {
    // Click the scrim (but not the body) to dismiss.
    sheet.onclick = (e) => { if (e.target === sheet) closeSheet(sheet.id); };
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const s of document.querySelectorAll('.sheet')) closeSheet(s.id);
  });

  $('pickBtn').onclick = () => $('fileInput').click();
  $('folderBtn').onclick = () => $('folderInput').click();
  $('cameraBtn').onclick = () => $('cameraInput').click();
  $('urlBtn').onclick = () => openSheet('urlSheet');
  $('listingBtn').onclick = () => {
    // One field on every host. A server that can scrape reads the whole
    // page; the site decodes the address and the VIN on this device.
    // One box. What it holds decides what happens: an address, a VIN,
    // or the page's own source pasted in (Ctrl+U, select all, copy).
    $('listingHint').textContent = can('scrape')
      ? 'Or load the page you saved from the listing.'
      : 'A page from a dealer lotstretcher knows is read in full. For any other, to get the photos and the price too: on the listing press Ctrl+U, select all, copy, and paste that here; or save the page (Ctrl+S, "HTML only") and load it.';
    readState('idle');
    setTimeout(() => $('listingUrlInput').focus(), 50);
    openSheet('listingSheet');
  };
  /* A saved copy of the listing page, or its pasted source: read here,
   * with the same reader the scraper uses on the live page. */
  const readListingHtml = (html, label) => {
    const note = $('listingUrlNote');
    let record;
    try { record = recordFromHtml(html); } catch (e) { note.textContent = String(e.message || e); return false; }
    if (!describesVehicle(record)) {
      note.textContent = `No vehicle data in ${label}. Save the page as "Webpage, HTML only" once the listing has fully loaded.`;
      note.className = 'small is-err';
      return false;
    }
    closeSheet('listingSheet');
    applyVehicle(record);
    return true;
  };
  readListingHtmlRef = readListingHtml;
  $('listingFileBtn').onclick = () => $('listingFileInput').click();
  $('listingFileInput').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) readListingHtml(await f.text(), f.name);
  };
  const sheet = $('listingSheet');
  sheet.addEventListener('dragover', (e) => { e.preventDefault(); });
  sheet.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files || [])].find((x) => /\.html?$/i.test(x.name) || x.type === 'text/html');
    if (f) readListingHtml(await f.text(), f.name);
  });

  /* The box reads itself: on paste, on Enter, on leaving it. A small
   * state machine says where it is (idle, reading, done, failed). */
  const readState = (status, note = '') => {
    const n = $('listingUrlNote');
    n.textContent = note;
    n.className = `small ${status === 'failed' ? 'is-err' : status === 'done' ? 'is-ok' : 'dim'}`;
    $('listingBusy').hidden = status !== 'reading';
    if (!state.preparing && !state.running) topProgress(status === 'reading' ? 'busy' : null, status === 'reading' ? 'Reading the listing…' : null);
    $('listingUrlInput').disabled = status === 'reading';
  };
  let reading = false;
  const readBox = async () => {
    const text = $('listingUrlInput').value.trim();
    if (!text || reading) return;
    reading = true;
    readState('reading', looksLikeHtml(text) ? 'Reading the page…' : /^https?:/i.test(text) && can('scrape') ? 'Your server is reading the page…' : 'Reading…');
    try {
      let ok;
      if (looksLikeHtml(text)) ok = readListingHtml(text, 'the pasted source');
      else ok = await importListingText(text, (m) => readState('reading', m));
      if (ok) { readState('done'); closeSheet('listingSheet'); $('listingUrlInput').value = ''; }
      else if ($('listingUrlNote').className.includes('dim')) readState('failed', $('listingUrlNote').textContent || 'Nothing readable there.');
    } catch (e) {
      readState('failed', String(e.message || e));
    } finally {
      reading = false;
    }
  };
  $('listingUrlInput').addEventListener('paste', () => setTimeout(readBox, 0));
  $('listingUrlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); readBox(); } });
  $('listingUrlInput').addEventListener('change', readBox);

  $('fileInput').onchange = (e) => { addFiles(e.target.files, 'chosen'); e.target.value = ''; };
  $('folderInput').onchange = (e) => { addFiles(e.target.files, 'folder'); e.target.value = ''; };
  $('cameraInput').onchange = (e) => { addFiles(e.target.files, 'captured'); e.target.value = ''; };

  // Every box reads itself on paste; the button stays for a typed entry.
  const takeUrls = () => {
    if (!$('urlInput').value.trim()) return;
    addUrls($('urlInput').value);
    $('urlInput').value = '';
    closeSheet('urlSheet');
  };
  $('urlAdd').onclick = takeUrls;
  $('urlInput').addEventListener('paste', () => setTimeout(takeUrls, 0));

  $('stickerFileBtn').onclick = () => $('stickerInput').click();
  $('stickerUrlBtn').onclick = () => openSheet('stickerSheet');
  $('stickerInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importSticker(await f.arrayBuffer());
  };
  const takeSticker = () => {
    const url = $('stickerUrlInput').value.trim();
    if (!url) return;
    $('stickerUrlInput').value = '';
    closeSheet('stickerSheet');
    importSticker(url);
  };
  $('stickerUrlGo').onclick = takeSticker;
  $('stickerUrlInput').addEventListener('paste', () => setTimeout(takeSticker, 0));

  $('resetOptions').onclick = () => { state.options = resetOptions(); renderOptions(); preview?.update(); };
  $('panelClose').onclick = () => { document.querySelector('.studio').classList.remove('panel-open'); preview?.update(); };
  // The rail scrolls on a phone with the scrollbar hidden: a fade on
  // the edge with more past it says so.
  const rail = $('studioRail');
  const railHint = () => {
    rail.classList.toggle('can-scroll', rail.scrollWidth > rail.clientWidth + 2);
    rail.classList.toggle('is-start', rail.scrollLeft <= 2);
    rail.classList.toggle('is-end', rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 2);
  };
  rail.addEventListener('scroll', railHint, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(railHint).observe(rail);
  railHint();

  // The walkthrough's own buttons: next at the foot of each step, back
  // where there is somewhere to go back to.
  for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => go(b.dataset.back);

  // The whole pane, not the stage: the estimates live in the Output
  // tool, wherever that panel happens to be parked.
  preview = new Preview($('pane-options'), {
    getOptions: () => state.options,
    getVehicle: () => state.vehicle,
    getUserCutout: () => state.photos.find((p) => p.cutout)?.cutout || null,
    getUserCutouts: () => clipOrder(state.photos.filter((p) => p.cutout)).map((p) => p.cutout),
    getPhotoCount: () => state.photos.length,
    onToggleFormat: toggleFormat,
  });
  // Dragging the text on the stage moves the Text tool's position lever.
  // A drag on the stage moves the piece the open Text tab names (the
  // whole stack from the All tab), or a piece already placed on its
  // own when the pointer lands on it.
  preview.onTextPosition = (pos, live, piece) => {
    state.options[piece ? `${piece}Position` : 'textPosition'] = pos;
    if (live) { preview.update(); return; }
    commitOptions();
    preview.update();
  };
  // What a drag moves: the piece under the pointer when its own tab is
  // open or it already stands on its own, otherwise the whole stack.
  preview.textTarget = (hit) => {
    const tab = openSubTab('text');
    if (hit && tab === hit) return hit;
    if (hit && state.options[`${hit}Position`]) return hit;
    return null;
  };
  preview.subjectChanged();
  renderOptions();

  // Settings: the dealer and this host. Dealer edits are kept as typed
  // and reach the Studio's Text tool as its default line.
  $('settingsBtn').onclick = () => { renderHost(); openSheet('settingsSheet'); };
  for (const id of ['f-dealer', 'f-greeting', 'f-address', 'f-citytags']) {
    $(id).addEventListener('change', () => { readVehicle(); renderOptions(); });
  }

  $('clearBtn').onclick = clearPhotos;
  wireLightbox();

  // The VIN barcode, through the camera; a photo of it where there is
  // no camera stream. Either way the VIN takes the listing route, so
  // the year and make fill with it.
  let scanAbort = null;
  const tookVin = (vin) => {
    closeSheet('scanSheet');
    if (!vin) return;
    importListingText(vin, (m) => setStatus('vehicleStatus', m));
    setStatus('vehicleStatus', `${$('vehicleStatus').textContent} (scanned)`, 'ok');
  };
  $('scanVinBtn').onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { $('scanInput').click(); return; }
    openSheet('scanSheet');
    $('scanStatus').textContent = 'Starting the camera…';
    scanAbort?.abort();
    scanAbort = new AbortController();
    try {
      const { scanVin } = await import('./pipeline/scan.js');
      const vin = await scanVin($('scanVideo'), { onStatus: (m) => { $('scanStatus').textContent = m; }, signal: scanAbort.signal });
      if (vin) tookVin(vin);
    } catch (e) {
      $('scanStatus').textContent = /NotAllowed|Permission/i.test(String(e)) ? 'The camera was refused. A photo of the barcode works too.' : String(e.message || e);
    }
  };
  // However the sheet closes (Cancel, Escape, the scrim), the camera stops.
  $('scanSheet').addEventListener('close', () => scanAbort?.abort());
  $('scanCancel').onclick = () => closeSheet('scanSheet');
  $('scanPhotoBtn').onclick = () => { scanAbort?.abort(); $('scanInput').click(); };
  $('scanInput').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const { scanVinFromFile } = await import('./pipeline/scan.js');
    try {
      const vin = await scanVinFromFile(f);
      if (vin) tookVin(vin); else setStatus('vehicleStatus', 'No VIN barcode found in that photo.', 'err');
    } catch (err) { setStatus('vehicleStatus', String(err.message || err), 'err'); }
  };
  $('runBtn').onclick = run;
  $('downloadBtn').onclick = () => downloadBundle(state);

  // Only offer the camera where one plausibly exists. A desktop with a
  // webcam would give a useless still, and `capture` is ignored there
  // anyway, so the button would be a lie.
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    $('cameraBtn').classList.remove('hidden');
  }

  const dz = $('dropzone');
  for (const ev of ['dragenter', 'dragover']) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); });
  }
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) { addFiles(e.dataTransfer.files, 'dropped'); return; }
    // A link dragged from another tab: an image, or the listing itself.
    const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (text) readPastedText(text);
  });
  // Paste on the Photos step, outside a field: photos from the
  // clipboard, or text routed by what it is.
  window.addEventListener('paste', (e) => {
    if (state.pane !== 'booth') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files, 'pasted'); return; }
    const text = e.clipboardData?.getData('text/plain');
    if (text && readPastedText(text)) e.preventDefault();
  });
  // Dropping anywhere but the zone should not navigate the tab to the file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // Report isolation as soon as we know, not only once a run starts --
  // it changes what the user should expect from the very first tap.
  initRuntime().then(() => {
    $('isolationWarn').classList.toggle('hidden', runtime.isolated);
  }).catch(() => { /* surfaced properly on run() */ });

  // The photos and fields are saved on this device as they change and
  // offered back on the next load; a run's results are not, so leaving
  // mid-run still asks.
  window.addEventListener('beforeunload', (e) => {
    if (state.running) { e.preventDefault(); e.returnValue = ''; }
  });
  // Typing in the vehicle form is read as it happens, so a title or a
  // paint colour on the stage follows the words.
  for (const id of FORM_IDS) $(id).addEventListener('input', () => { saveSessionSoon(); readVehicle(); if (state.pane === 'options') preview?.update(); });
  /* Marking the car New after a sticker was read lets its MSRP stand as
   * the price, if no price was typed. */
  $('f-cond').addEventListener('change', () => {
    const msrp = state.sticker?.msrp;
    if ($('f-cond').value === 'New' && msrp && !$('f-price').value.trim()) {
      $('f-price').value = String(msrp).replace(/^\$/, '').replace(/,/g, '').replace(/\.00$/, '');
      $('f-price').dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  state.restoring = true;   // until offerResume has looked
  offerResume();

  // A listing shared to the installed app from the phone's browser
  // (Android's share sheet: the manifest's share_target) arrives as ?url=,
  // or inside ?text= with words around it; it takes the paste's route.
  const shared = new URLSearchParams(location.search);
  const sharedText = ['url', 'text', 'title'].map((k) => shared.get(k)).filter(Boolean).join(' ');
  if (sharedText) {
    history.replaceState(null, '', location.pathname);
    const link = sharedText.match(/https?:\/\/\S+/)?.[0];
    if (link) importListingText(link, (m) => showSourceNote(m));
    else readPastedText(sharedText);
  }

  renderOptions();
  renderPhotos();
  renderResults();

  /* The Library pane. One view, two sources: a self-hosted server's
   * designated folder is opened for you; anywhere, a folder can be
   * picked. Loading a vehicle's originals back in is how a library
   * entry gets rerun with today's options, on either surface. */
  const libraryView = new LibraryView($('libraryHost'), {
    // Management is a capability, not an edition: the edge site's host
    // reports none of it, and the pane simply has less to offer there.
    ops: can('recompose') ? libraryOps : null,
    getOptions: () => state.options,
    can,
    onLoadVehicle: ({ details, files }) => {
      clearPhotos();
      addFiles(files);
      if (details && Object.keys(details).length) applyVehicle(details);
      else go('booth');
    },
  });
  libraryView.onPick = async () => {
    try {
      await libraryView.setSource(await DirectorySource.pick());
    } catch (e) {
      if (!/no folder chosen|abort/i.test(String(e))) {
        libraryView.error = String(e.message || e);
        libraryView.render();
      }
    }
  };
  if (can('library')) libraryView.setSource(new HttpSource());

  /* A debug handle.
   *
   * Deliberately exposed rather than kept private: everything here is
   * already the user's own data sitting in their own tab, there is no
   * secret to leak, and without it neither automation nor a person in
   * the console can check what the pipeline actually decided. Several
   * real bugs this session were only visible from the inside. */
  window.lotstretcher = {
    state,
    preview,
    go,
    options: () => state.options,
    summary: () => ({
      photos: state.photos.map((p) => ({
        name: p.name, scene: p.scene, sceneConf: p.sceneConf,
        angle: p.angle, angleConf: p.angleConf,
        ambiguous: p.ambiguous, coverage: p.coverage,
        rejected: p.rejected || null,
        formats: p.heroes ? Object.fromEntries(
          Object.entries(p.heroes).map(([k, c]) => [k, `${c.width}x${c.height}`])) : null,
      })),
      posts: state.posts ? Object.keys(state.posts) : null,
      sticker: state.sticker ? Object.keys(state.sticker) : null,
    }),
  };
}

init();
