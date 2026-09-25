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
  MIN_ANGLE_CONFIDENCE, MIN_SCENE_CONFIDENCE, INTERIOR_LEAN, EXTERIOR_LEAN, FRAME_FILL_MIN_EDGES, MAX_SOURCE_SIDE,
} from './config.js';
import { initRuntime, runtime, loadModel, totalBytes, prefetchModels, modelsCached } from './pipeline/runtime.js';
import { classifyScene, classifyAngle, loadLabels } from './pipeline/classify.js';
import { matte, applyMatte, gateCutout } from './pipeline/matte.js';
import { composeHero } from './pipeline/compose.js';
import { renderHeroVideoHere, videoThreads, setVideoThreads, isSupported as videoSupported } from './pipeline/video.js';
import { CoreWorker } from './pipeline/core-worker.js';
import { buildAllPosts, vehicleTitle, PLATFORMS } from './pipeline/copy.js';
import { decode, makeCanvas, ctxOf, canvasToBlob } from './lib/imageio.js';
import { makeZip, deliver } from './lib/zip.js';
import * as OPTS from './options.js';
import {
  loadOptions, saveOptions, resetOptions, toCliFlags, initFromSpec, serialisable,
} from './options.js';
import { store, blobToCanvas } from './lib/store.js';
import { loadSpec, get as specGet } from './spec.js';
import { loadCore, version as coreVersion, threadCount as coreThreads, enhanceInterior, renderFrame as coreRenderFrame, drawFrame as coreDrawFrame, call as coreCall, toImageData as coreToImageData, vehicleGradientColors as coreVehicleGradientColors } from './core.js';
import { mountBrand, wireSurfaceLinks } from './chrome.js';
import { Preview } from './preview.js';
import { loadCapabilities, can, host, isSelfHosted, whyUnavailable } from './host.js';
import { renderControls, controlDefaults, controlsToFlags, affectsPreview, renderLooks, openSubTab } from './controls.js';
import { loadAssets, needsServer, composeOnServer, scrapeOnServer, libraryOps } from './lib/delegate.js';
import { entry as libraryEntry, image as libraryImage } from './lib/library.js';
import { textOptions, textRequest, frameStyle, shadowStyle, reflectionStyle, spotlightStyle } from './lib/text.js';
import { normalizeListing, recordFromHtml } from './pipeline/listing.js';
import { recordFromText } from './pipeline/vin.js';
import { LibraryView } from './library/view.js';
import { HttpSource, DirectorySource } from './library/source.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

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

/* The run button lives in the header and again at the foot of the Look
 * pane; one function keeps them agreeing. */
function setRunEnabled(on) {
  $('runBtn').disabled = !on;
  const b = null;
  if (b) b.disabled = !on;
}

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
  if (prepared && preview?.getUserCutout?.()) { preview.current = 'yours'; preview.renderSamples(); preview.update(); preview.onSubjectChange?.(); }
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
    preview?.renderSamples();
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

function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }

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

  for (const file of images) {
    if (state.photos.length >= LIMITS.maxPhotos) break;
    state.photos.push({
      id: nextId++,
      name: file.name,
      blob: file,
      thumb: URL.createObjectURL(file),
      status: 'ready',
      source,
    });
  }
  renderPhotos();
}

function addUrls(text, source = 'links') {
  const urls = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  for (const url of urls) {
    if (state.photos.length >= LIMITS.maxPhotos) break;
    if (!/^https?:\/\//i.test(url)) continue;
    state.photos.push({
      id: nextId++,
      name: url.split('/').pop().split('?')[0] || 'photo',
      url,
      thumb: url,
      status: 'ready',
      source,
    });
  }
  renderPhotos();
}

function removePhoto(id) {
  const i = state.photos.findIndex((p) => p.id === id);
  if (i < 0) return;
  const p = state.photos[i];
  if (p.blob && p.thumb) URL.revokeObjectURL(p.thumb);
  state.photos.splice(i, 1);
  renderPhotos();
}

function clearPhotos() {
  for (const p of state.photos) if (p.blob && p.thumb) URL.revokeObjectURL(p.thumb);
  state.photos = [];
  state.done = false;
  state.posts = null;
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
  setStatus('photosStatus', Object.entries(by).map(([k, c]) => `${c} ${SOURCE_LABEL[k] || k}`).join(' · '), 'ok');
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
  setRunEnabled(n > 0 && !state.running);
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
    const tag = p.unreachable ? null : p.rejected ? tagOf('skipped') : p.scene ? tagOf(p.angle ? `${p.scene} · ${angleLabel(p.angle)}` : p.scene) : null;
    if (tag) {
      tag.classList.add('tile-tag-btn');
      if (p.userScene) tag.classList.add('is-user');
      tag.title = 'Wrong? Tap to change';
      tag.onclick = (e) => { e.stopPropagation(); if (!state.running) pickScene(p, tag); };
      tile.appendChild(tag);
    }
    tile.onclick = () => openLightbox(boothItems(), state.photos.indexOf(p));

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

/* The angle the classifier gives, as words. */
const ANGLE_WORDS = { front: 'Front', front_3q: 'Front \u00be', side: 'Side', rear_3q: 'Rear \u00be', rear: 'Rear', hero: 'Hero' };
function angleLabel(angle) { return ANGLE_WORDS[angle] || angle || 'Hero'; }

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

function renderResults() {
  const heroes = state.photos.filter((p) => p.hero);
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
    const scale = 420 / Math.max(p.interior.width, p.interior.height);
    const c = makeCanvas(Math.round(p.interior.width * scale), Math.round(p.interior.height * scale));
    ctxOf(c).drawImage(p.interior, 0, 0, c.width, c.height);
    const img = el('img');
    canvasToBlob(c, 'image/jpeg', 0.85).then((b) => { img.src = URL.createObjectURL(b); });
    img.alt = `Interior photo ${p.name}, corrected`;
    pic.append(img);
    tile.append(pic, tagOf('interior'));
    interiorHost.appendChild(tile);
  }
  const interiorItems = interiors.map((p) => canvasItem(p.interior, p.name, 'interior', () => saveInterior(p)));
  [...interiorHost.children].forEach((tile, i) => { tile.onclick = () => openLightbox(interiorItems, i); });

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
      const k = 640 / Math.max(canvas.width, canvas.height);
      const c = makeCanvas(Math.round(canvas.width * k), Math.round(canvas.height * k));
      ctxOf(c).drawImage(canvas, 0, 0, c.width, c.height);
      const img = el('img');
      canvasToBlob(c, 'image/jpeg', 0.85).then((b) => { img.src = URL.createObjectURL(b); });
      img.alt = `${label} still from ${p.name}`;
      pic.append(img);
      tile.append(pic, tagOf(angleLabel(p.angle)));
      stillItems.push(canvasItem(canvas, `${p.name} \u00b7 ${label}`, angleLabel(p.angle), () => saveOne(p, fmt)));
      const at = stillItems.length - 1;
      tile.onclick = () => openLightbox(stillItems, at);
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
      v.src = URL.createObjectURL(blob);
      v.controls = true; v.loop = true; v.muted = true; v.playsInline = true;
      v.preload = 'metadata';
      const cap = el('figcaption', 'xs dim',
        `${OPTS.VIDEO_FORMATS[fmt].label} \u00b7 ${(blob.size / 1e6).toFixed(1)} MB`);
      wrap.append(v, cap);
      videoHost.appendChild(wrap);
    }
  }

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


function toggleRow(label, hint, checked, onChange) {
  const row = el('div', 'opt');
  const text = el('div', 'opt-text');
  text.append(el('strong', null, label), el('span', null, hint));
  const sw = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  input.onchange = () => onChange(input.checked);
  sw.append(input, el('i'));
  row.append(text, sw);
  return row;
}

function selectRow(label, hint, value, choices, onChange) {
  const row = el('div', 'opt');
  const text = el('div', 'opt-text');
  text.append(el('strong', null, label), el('span', null, hint));
  const sel = document.createElement('select');
  sel.className = 'field';
  for (const c of choices) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    if (c === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => onChange(sel.value);
  row.append(text, sel);
  return row;
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
    placeholders: { subtitle: state.dealer.greeting || null, titleText: vehicleTitleWords() || null },
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

/* What a swatch shows. Gradients are drawn by the core from the
 * preview's own subject (its paint, or the sample's), stock assets come
 * as thumbnails from the server, the user's images are themselves, and
 * glow colours are the spec's. */
const artCache = new Map();
function swatchArt(control, choice, values, image) {
  // Tiles live in the DOM, so these are document canvases, never the
  // offscreen ones the pipeline uses.
  const tileCanvas = () => { const c = document.createElement('canvas'); c.width = 96; c.height = 96; return c; };
  if (choice.file) {
    if (!image) return null;
    const c = tileCanvas();
    const k = Math.max(96 / image.width, 96 / image.height);
    c.getContext('2d').drawImage(image, (96 - image.width * k) / 2, (96 - image.height * k) / 2, image.width * k, image.height * k);
    return c;
  }
  if (control.key === 'glowColor') {
    const rgb = specGet('glow', 'colors')[choice.value];
    return rgb ? { color: `rgb(${rgb.join(',')})` } : null;
  }
  if (control.key === 'frameColor' || /^(text|title|subtitle|badge)Color$/.test(control.key)) {
    // White, black, or the paint as the core would read it off the subject.
    if (choice.value === 'white') return { color: '#ffffff' };
    if (choice.value === 'black') return { color: '#101010' };
    if (choice.value === 'paint') {
      const subject = preview?.subject?.();
      try {
        const sample = subject?.cutout ? ctxOf(subject.cutout, { willReadFrequently: true }).getImageData(0, 0, subject.cutout.width, subject.cutout.height) : null;
        const [start] = coreVehicleGradientColors(subject?.exterior || null, null, sample);
        return { color: `rgb(${start.join(',')})` };
      } catch { return { color: '#a0a0aa' }; }
    }
    return null;
  }
  if (choice.asset) {
    return libraryEntry(choice.expand || 'backgrounds', choice.asset)?.thumb || null;
  }
  if (control.key === 'border' && choice.value === 'line') {
    // The core draws the tile as it draws the frame, in the chosen colour.
    const key = JSON.stringify(['line', values.frameColor, values.frameWeight]);
    if (!artCache.has(key)) {
      try {
        const subject = preview?.subject?.();
        const rgba = coreDrawFrame(96, 96, { kind: 'line', color: values.frameColor || 'white', weight: Math.max(0.02, Number(values.frameWeight) || 0.008) * 2.5 },
          subject?.vehicle || {}, subject ? ctxOf(subject.cutout, { willReadFrequently: true }).getImageData(0, 0, subject.cutout.width, subject.cutout.height) : null);
        const c = tileCanvas();
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#2a2d33'; ctx.fillRect(0, 0, 96, 96);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), 96, 96), 0, 0);
        artCache.set(key, c);
      } catch (e) { console.warn('frame tile failed', e); artCache.set(key, null); }
    }
    const c = artCache.get(key);
    if (!c) return null;
    const copy = tileCanvas(); copy.getContext('2d').drawImage(c, 0, 0); return copy;
  }
  if (control.key === 'backdrop' && ['vehicle', 'generic', 'sweep', 'radial', 'horizon'].includes(choice.value)) {
    const subject = preview?.subject?.();
    // Hue bands and the sweep show the chosen colour once it is theirs.
    const color = choice.value !== 'vehicle' && values.backdrop === choice.value ? values.backdropColor || null : null;
    const key = JSON.stringify([choice.value, subject?.exterior, subject?.interior, subject?.seed, color]);
    if (!artCache.has(key)) {
      try {
        const bg = choice.value === 'generic'
          ? { kind: 'generic', seed: `${subject?.seed || 'sample'}:preview`, color }
          : { kind: choice.value, seed: `${subject?.seed || 'sample'}:preview`, exterior: subject?.exterior || null, interior: subject?.interior || null, color };
        // The sweep reads the paint off the subject when the names give none.
        const sample = subject?.cutout ? ctxOf(subject.cutout, { willReadFrequently: true }).getImageData(0, 0, subject.cutout.width, subject.cutout.height) : null;
        const held = ['sweep', 'radial', 'horizon'].includes(choice.value);
        if (held && sample) bg.sample = { $image: 0 };
        const out = held
          ? coreToImageData(coreCall({ op: 'render_frame', width: 96, height: 96, background: bg, cars: [], rgba: true }, sample ? [sample] : []))
          : coreRenderFrame([], 96, 96, bg);
        const c = tileCanvas();
        c.getContext('2d').putImageData(out, 0, 0);
        artCache.set(key, c);
      } catch (e) { console.warn('swatch art failed', e); artCache.set(key, null); }
    }
    const c = artCache.get(key);
    if (!c) return null;
    const copy = tileCanvas();
    copy.getContext('2d').drawImage(c, 0, 0);
    return copy;
  }
  return null;
}

/* A look's tile: the preview's subject composed by the core with the
 * look's values over the current ones, small. Cached per look and
 * subject; the values a look does not set (the backdrop, say) are the
 * current ones, so the tiles change with them. */
const lookArtCache = new Map();
function lookArt(lk, values) {
  const subject = preview?.subject?.();
  if (!subject) return null;
  const v = { ...values, ...lk.values };
  const key = JSON.stringify([lk.id, subject.seed, v.backdrop, v.backdropColor, v.backdropColor2, v.backdropAngle, spotlightStyle(v), v.glow, v.glowColor, v.glowRadius, v.glowIntensity,
    v.shadow, v.shadowStrength, v.reflection, v.reflectionStrength, v.border, v.frameColor, v.frameWeight]);
  if (!lookArtCache.has(key)) {
    try {
      const size = 128;
      const composed = composeHero(subject.cutout, {
        width: size, height: size, seed: `${subject.seed}:look`,
        exterior: subject.exterior, interior: subject.interior, generic: v.backdrop === 'generic', backdrop: v.backdrop,
        backdropColor: v.backdropColor || null, backdropColor2: v.backdropColor2 || null, backdropAngle: v.backdropAngle ?? null,
        spotlight: spotlightStyle(v), marginFrac: 0.08,
        glow: v.glow, glowColor: v.glowColor, glowRadius: Math.max(2, Math.round((v.glowRadius || 24) / 6)), glowIntensity: v.glowIntensity,
        border: null, borderStyle: v.border === 'line' ? { ...frameStyle(v), weight: Math.max(0.02, Number(v.frameWeight) || 0.008) * 2 } : null,
        shadow: shadowStyle(v), reflection: reflectionStyle(v),
        text: null,
      });
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      c.getContext('2d').drawImage(composed, 0, 0);
      lookArtCache.set(key, c);
    } catch (e) { console.warn('look tile failed', e); lookArtCache.set(key, null); }
  }
  const c = lookArtCache.get(key);
  if (!c) return null;
  const copy = document.createElement('canvas'); copy.width = copy.height = c.width;
  copy.getContext('2d').drawImage(c, 0, 0);
  return copy;
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
async function sortAndCut(stages) {
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
      loadModel('matte'),
    ]);
    clock('models', t0);
    stages[0].state = 'done';
    stages[0].detail = `${(T.models / 1000).toFixed(1)} s, kept on this device`;
    stages[1].state = 'active';
    renderStages(stages);

    // --- pass 1: scene. Runs on every photo, so it is the hot path.
    const total = state.photos.length;
    for (let i = 0; i < total; i++) {
      const p = state.photos[i];
      p.status = 'working';
      renderPhotos();
      try {
        t0 = performance.now();
        const bitmap = await decode(p.blob || p.url, MAX_SOURCE_SIDE);
        clock('decode', t0);
        p.bitmap = bitmap;
        if (p.userScene) { /* the person said what it is; the model does not argue */ } else {
        t0 = performance.now();
        const scene = await classifyScene(bitmap);
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
        state.errors.push(`${p.name}: ${p.error}`);
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
      for (const p of state.photos) {
        if (p.scene !== 'interior' || p.status === 'failed') continue;
        try {
          t0 = performance.now();
          p.interior = enhanceInterior(p.bitmap);
          clock('interior', t0);
        } catch (e) {
          state.errors.push(`${p.name}: ${e.message || e}`);
        }
      }
    }
    // cut_type "none" is the server's classify-only mode: sort the
    // photos, compose nothing.
    const exteriors = state.options.cutType === 'none'
      ? []
      : state.photos.filter((p) => p.scene === 'exterior' && !p.rejected);
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
        const m = await matte(p.bitmap);
        clock('matte', t0);
        t0 = performance.now();
        const cut = applyMatte(p.bitmap, m);
        clock('cut', t0);
        p.ambiguous = m.ambiguous;
        p.coverage = cut.coverage;

        if (p.onTrial) {
          // A close-up touches the frame's edges; a whole car stands clear.
          const b = cut.bbox;
          const W = p.bitmap.width, H = p.bitmap.height;
          const edges = b ? [b.x / W, b.y / H, (W - b.x - b.w) / W, (H - b.y - b.h) / H].filter((m) => m < 0.03).length : 4;
          p.onTrial = false;
          if (edges >= FRAME_FILL_MIN_EDGES) {
            p.scene = 'detail';
            p.status = 'sorted';
            setProgress(0.35 + 0.45 * ((i + 1) / Math.max(1, exteriors.length)));
            renderPhotos();
            continue;
          }
        }

        // Gate BEFORE composing. A confidently-wrong cutout does not look
        // like a failure, it looks like a post.
        const gate = gateCutout({
          ambiguous: m.ambiguous, coverage: cut.coverage, hasCanvas: !!cut.canvas,
        }, state.options.strictCutouts);
        if (!gate.ok) {
          p.rejected = gate.reason;
        } else {
          p.cutout = cut.canvas;
          const cutBitmap = await createImageBitmap(await canvasToBlob(cut.canvas));
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
        state.errors.push(`${p.name}: ${p.error}`);
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
}

/* What the photos and the options that shape a cut amount to; a
 * preparation is only reused for the same. */
function photoKey() {
  return JSON.stringify([state.photos.map((p) => [p.id, p.userScene ? (p.rejected ? 'skip' : p.scene) : null]), state.options.interiors, state.options.cutType]);
}

/* The sort-and-cut for the current photos: the preload's, awaited, when
 * it is for these photos; started here otherwise. */
async function prepared(stages) {
  const key = photoKey();
  if (state.prepared?.key === key) {
    const exteriors = await state.prepared.promise;
    for (const st of stages.slice(0, 3)) st.state = 'done';
    Object.assign(stages[0], state.prepared.stages[0]); Object.assign(stages[1], state.prepared.stages[1]); Object.assign(stages[2], state.prepared.stages[2]);
    stages[3].state = 'active';
    renderStages(stages);
    return exteriors;
  }
  return sortAndCut(stages);
}

function runStages() {
  return [
    { n: 1, label: 'Loading models', state: 'active', detail: `${(totalBytes() / 1e6).toFixed(0)} MB, first run only` },
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
  state.errors = [];
  topProgress(0, `Sorting and cutting out ${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}…`);
  renderSteps();
  const promise = (async () => {
    try {
      return await sortAndCut(stages);
    } finally {
      for (const p of state.photos) { p.bitmap?.close?.(); p.bitmap = null; }
      state.preparing = false;
      topProgress(null);
      renderPhotos();
      // A finished preparation for the same photos: prepare again if they changed meanwhile.
      if (state.prepared?.key !== photoKey()) { state.prepared = null; renderPhotos(); }
      if (preview?.getUserCutout?.()) { preview.current = 'yours'; preview.renderSamples(); preview.update(); preview.onSubjectChange?.(); }
    }
  })();
  state.prepared = { key, promise, stages };
  promise.catch((e) => { state.prepared = null; console.warn('preload failed:', e); });
}

async function run() {
  if (state.running || !state.photos.length) return;
  state.running = true;
  state.done = false;
  state.runStart = performance.now();
  let cw = null;   // the run's core worker, ended in `finally`
  if (state.prepared?.key !== photoKey()) state.errors = [];
  setRunEnabled(false);
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
    const cut = exteriors.filter((p) => p.cutout);
    const formats = state.options.heroFormats.length ? state.options.heroFormats : ['square'];
    const vid = state.vehicle.vin || state.vehicle.stock_number || 'v';

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
    const stockBorder = !delegating && state.options.border && !['none', 'custom', 'line'].includes(state.options.border)
      ? await libraryImage('borders', state.options.border) : null;
    // A name remembered from another host (a server's private frame,
    // opened later on the site) is not in this library: say so rather
    // than compose on the gradient or frameless as if nothing was asked.
    if (!delegating && state.options.backdrop === 'asset' && !stockBackground) {
      state.errors.push(`background "${state.options.background || ''}" is not in this library; the stills use the gradient`);
    }
    if (!delegating && state.options.border && !['none', 'custom', 'line'].includes(state.options.border) && !stockBorder) {
      state.errors.push(`frame "${state.options.border}" is not in this library; the stills are frameless`);
    }

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
          seed: `${vid}:${p.name}:${fmt}`,
          exterior: state.vehicle.exterior_color,
          interior: state.vehicle.interior_color,
          width: w, height: h,
          spotlight: spotlightStyle(state.options),
          marginFrac: state.options.margin,
          generic: state.options.backdrop === 'generic', backdrop: state.options.backdrop,
          backdropColor: state.options.backdropColor || null,
          backdropColor2: state.options.backdropColor2 || null,
          backdropAngle: state.options.backdropAngle ?? null,
          // The user's own images, the browser's --photo-background and
          // --border: drawn by the core exactly as the CLI's are.
          background: state.options.backdrop === 'custom' ? state.options.customBackground || null : stockBackground,
          border: state.options.border === 'custom' ? state.options.customFrame || null : stockBorder,
          borderFit: state.options.frameFit,
          borderStyle: frameStyle(state.options),
          shadow: shadowStyle(state.options), reflection: reflectionStyle(state.options),
          text: await textRequest(state.vehicle, textOptions(state.options)),
          glow: state.options.glow, glowColor: state.options.glowColor,
          glowRadius: state.options.glowRadius, glowIntensity: state.options.glowIntensity,
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
      for (const fmt of wantVideo) {
        const [w, h] = OPTS.VIDEO_FORMATS[fmt].size;
        try {
          const videoOpts = {
            angles: cut.map((p) => p.angle || null),
            width: w, height: h,
            seed: `${vid}:video:${fmt}`,
            exterior: state.vehicle.exterior_color,
            interior: state.vehicle.interior_color,
            generic: state.options.backdrop === 'generic', backdrop: state.options.backdrop,
            backdropColor: state.options.backdropColor || null,
            backdropColor2: state.options.backdropColor2 || null,
            spotlight: spotlightStyle(state.options),
            glow: state.options.glow,
            glowColor: state.options.glowColor,
            glowRadius: state.options.glowRadius,
            glowIntensity: state.options.glowIntensity,
            text: await textRequest(state.vehicle, textOptions(state.options)),
            background: videoBackground,
            frameStyle: frameStyle(state.options),
            shadow: shadowStyle(state.options), reflection: reflectionStyle(state.options),
            vehicle: state.vehicle,
            onProgress: (f) => setProgress(0.85 + 0.15 * f),
          };
          const shots = cut.map((p) => p.cutout);
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
      b.append(el('div', null, `${state.errors.length} photo(s) could not be processed: ${state.errors[0]}`));
      $('stageList').appendChild(b);
    }
  } catch (e) {
    const b = el('div', 'banner banner-err');
    b.append(el('div', null, String(e.message || e)));
    $('stageList').appendChild(b);
  } finally {
    cw?.terminate();
    // Free the decoded source bitmaps. They are the largest thing we
    // hold and nothing downstream needs them once cutouts exist.
    for (const p of state.photos) { p.bitmap?.close?.(); p.bitmap = null; }
    state.running = false;
    topProgress(null);
    setRunEnabled(state.photos.length > 0);
    renderPhotos();
    renderResults();
    // A cut-out vehicle of the user's own is now a preview subject.
    preview?.renderSamples();
  }
}

/* ---------- output -------------------------------------------------- */
let stepsTimer = null;
function renderStepsSoon() {
  clearTimeout(stepsTimer);
  stepsTimer = setTimeout(() => { renderSteps(); if (preview?.current === 'yours') preview.update(); }, 0);
}

function readVehicle() {
  renderStepsSoon();
  saveSessionSoon();
  // Spec fields come from the sticker and have no form input; carry them
  // across the rebuild rather than losing them on every run.
  const carried = {};
  for (const k of ['engine', 'transmission', 'drivetrain', 'seating']) {
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

function bundleName() {
  const t = vehicleTitle(state.vehicle).replace(/\s+/g, '-');
  const id = state.vehicle.stock_number || state.vehicle.vin;
  return [t || 'lotstretcher', id].filter(Boolean).join('-');
}

async function saveOne(photo, fmt = null) {
  const canvas = (fmt && photo.heroes?.[fmt]) || photo.hero;
  const blob = await canvasToBlob(canvas, 'image/png');
  const shape = fmt && fmt !== 'square' ? `-${fmt}` : '';
  await deliver(blob, `${bundleName()}-${photo.angle || 'hero'}${shape}.png`);
}

async function saveInterior(photo) {
  const blob = await canvasToBlob(photo.interior, 'image/jpeg', INTERIOR_JPEG_QUALITY);
  await deliver(blob, `${bundleName()}-interior-${photo.name.replace(/\.[^.]+$/, '')}.jpg`);
}

// The CLI writes bundle/interior/*.jpg at quality 92.
const INTERIOR_JPEG_QUALITY = 0.92;

async function downloadBundle() {
  const btn = $('downloadBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Packaging…';
  try {
    const files = [];
    const heroes = state.photos.filter((p) => p.hero);

    for (let i = 0; i < heroes.length; i++) {
      const p = heroes[i];
      const tag = p.angle ? `${String(i + 1).padStart(2, '0')}-${p.angle}` : String(i + 1).padStart(2, '0');
      for (const [fmt, canvas] of Object.entries(p.heroes || { square: p.hero })) {
        const blob = await canvasToBlob(canvas, 'image/png');
        files.push({ name: `${fmt}/${tag}.png`, data: blob });
        // The lead shot of each format also lands at the top level, the
        // same shape the CLI's bundle uses.
        if (i === 0) {
          files.push({
            name: fmt === 'square' ? 'hero.png' : `hero-${fmt}.png`,
            data: await canvasToBlob(canvas, 'image/png'),
          });
        }
      }
      if (p.cutout) {
        files.push({ name: `cutout/${tag}.png`, data: await canvasToBlob(p.cutout, 'image/png') });
      }
    }

    const interiors = state.photos.filter((p) => p.interior);
    for (let i = 0; i < interiors.length; i++) {
      files.push({
        name: `${specGet('library').bundle.interior}/${String(i + 1).padStart(2, '0')}.jpg`,
        data: await canvasToBlob(interiors[i].interior, 'image/jpeg', INTERIOR_JPEG_QUALITY),
      });
    }

    for (const [fmt, blob] of Object.entries(state.videos || {})) {
      files.push({ name: fmt === 'square' ? 'hero-video.mp4' : `hero-video-${fmt}.mp4`, data: blob });
    }

    if (state.posts) {
      for (const [platform, text] of Object.entries(state.posts)) {
        files.push({ name: `${platform}.txt`, data: text });
      }
    }
    files.push({ name: 'vehicle.json', data: JSON.stringify(state.vehicle, null, 2) });

    const zip = await makeZip(files);
    const how = await deliver(zip, `${bundleName()}.zip`);
    btn.textContent = how === 'shared' ? 'Shared' : 'Saved';
  } catch (e) {
    btn.textContent = 'Failed';
    console.error(e);
  } finally {
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1800);
  }
}

/* ---------- window sticker import ------------------------------------
 * The CLI shells out to poppler for this; in the browser pdf.js supplies
 * the same positioned text. Loaded lazily, so the 1.7MB costs nothing
 * unless someone actually uses it. */
async function importSticker(source, label) {
  const note = $('stickerNote');
  $('stickerRow').classList.remove('is-ok');
  note.textContent = 'Reading the PDF...';
  try {
    const { parseSticker, stickerToVehicle, stickerPriceApplies } = await import('./pipeline/sticker.js');
    const parsed = await parseSticker(source);

    if (parsed.placeholder) {
      note.textContent = 'That sticker is not published yet (the PDF just says to check back).';
      return;
    }

    const fields = stickerToVehicle(parsed);
    const map = {
      year: 'f-year', make: 'f-make', model: 'f-model', trim: 'f-trim',
      exterior_color: 'f-ext', interior_color: 'f-int', vin: 'f-vin',
    };
    let filled = 0;
    // The sticker's total is the price only when the car is sold new.
    if (fields.msrp && stickerPriceApplies($('f-cond').value, fields.year || $('f-year').value)) {
      fields.price = fields.msrp;
      map.price = 'f-price';
    }
    for (const [key, id] of Object.entries(map)) {
      // Never overwrite something the user typed themselves.
      if (fields[key] && !$(id).value.trim()) { $(id).value = fields[key]; filled++; }
    }
    /* Keep the whole parse, not just the form fields: equipment,
     * optional equipment and the spec lines feed the post copy, and
     * there is nowhere on the form to put them. */
    state.sticker = parsed;
    for (const k of ['engine', 'transmission', 'drivetrain', 'seating']) {
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
  for (const k of ['engine', 'transmission', 'drivetrain']) {
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
  if (v.window_sticker_url) importSticker(v.window_sticker_url, 'the sticker');
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
  const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', away, true); } };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
}

/* A section head's status line. */
function setStatus(id, text, tone = '') {
  const s = $(id);
  s.textContent = text;
  s.className = `head-status${tone ? ` is-${tone}` : ''}`;
}

/* ---------- lightbox: one image at full size, and the next ----------
 * Items are {src, name, tag, cors, save}: `src` a URL or a function
 * making one (a result's canvas is encoded only when looked at), `save`
 * an action for the Save button. The booth's photos and the run's
 * stills and interiors all open here. */
let lightboxItems = [];
let lightboxAt = -1;
const made = new Set();   // object URLs this box made, revoked on close
function boothItems() {
  return state.photos.map((p) => ({
    src: p.thumb, name: p.name, cors: !!p.url,
    tag: p.rejected ? 'skipped' : p.scene ? (p.angle ? `${p.scene} · ${angleLabel(p.angle)}` : p.scene) : '',
  }));
}
function canvasItem(canvas, name, tag, save, quality = 0.92) {
  let url = null;
  return {
    name, tag, save,
    src: async () => { if (!url) { url = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', quality)); made.add(url); } return url; },
  };
}
function openLightbox(items, i) {
  if (!items.length) return;
  lightboxItems = items;
  lightboxAt = Math.max(0, Math.min(i, items.length - 1));
  $('lightbox').hidden = false;
  showLightbox();
}
async function showLightbox() {
  const at = lightboxAt;
  const item = lightboxItems[at];
  if (!item) { closeLightbox(); return; }
  const img = $('lightboxImg');
  if (item.cors) img.crossOrigin = 'anonymous'; else img.removeAttribute('crossorigin');
  const src = typeof item.src === 'function' ? await item.src() : item.src;
  if (at !== lightboxAt) return;   // stepped on while encoding
  img.src = src;
  img.alt = item.name;
  $('lightboxCap').textContent = `${at + 1} of ${lightboxItems.length} · ${item.name}${item.tag ? ` · ${item.tag}` : ''}`;
  $('lightboxSave').hidden = !item.save;
  $('lightboxSave').onclick = (e) => { e.stopPropagation(); item.save?.(); };
  $('lightboxPrev').disabled = at === 0;
  $('lightboxNext').disabled = at === lightboxItems.length - 1;
}
function stepLightbox(d) { if ($('lightbox').hidden) return; lightboxAt = Math.max(0, Math.min(lightboxAt + d, lightboxItems.length - 1)); showLightbox(); }
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightboxImg').removeAttribute('src');
  for (const u of made) URL.revokeObjectURL(u);
  made.clear();
  lightboxItems = [];
}

/* The first visit downloads the models (56MB) while the person is still
 * picking photos, not after, and says so in the top bar; later visits
 * find them on the device and say nothing. Skipped on a data saver:
 * then they load when the first photo needs them. */
async function warmModels() {
  if (navigator.connection?.saveData) return;
  if (await modelsCached()) return;
  const label = `Getting ready, first visit only (${(totalBytes() / 1e6).toFixed(0)} MB)`;
  const quiet = () => state.preparing || state.running;
  if (!quiet()) topProgress(0, label);
  try {
    await prefetchModels((f) => { if (!quiet()) topProgress(f, label); });
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
  state.options = { ...controlDefaults(), ...loadOptions() };
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
    sheet.onclick = (e) => { if (e.target === sheet) sheet.hidden = true; };
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const s of document.querySelectorAll('.sheet')) s.hidden = true;
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
    $('listingUrlInput').placeholder = can('scrape')
      ? 'Paste the vehicle page address, a VIN, or the page source'
      : 'Paste the vehicle page address, a VIN, or the page source';
    $('listingHint').textContent = can('scrape')
      ? 'Or load the page you saved from the listing.'
      : 'For the photos and the price too: on the listing press Ctrl+U, select all, copy, and paste that here; or save the page (Ctrl+S, "HTML only") and load it.';
    readState('idle');
    setTimeout(() => $('listingUrlInput').focus(), 50);
    openSheet('listingSheet');
  };
  /* A saved copy of the listing page, or its pasted source: read here,
   * with the same reader the scraper uses on the live page. */
  const readListingHtml = (html, label) => {
    const note = $('listingUrlNote');
    let raw;
    try { raw = recordFromHtml(html); } catch (e) { note.textContent = String(e.message || e); return false; }
    if (!raw.payload && !raw.ldCar) {
      note.textContent = `No vehicle data in ${label}. Save the page as "Webpage, HTML only" once the listing has fully loaded.`;
      note.className = 'small is-err';
      return false;
    }
    closeSheet('listingSheet');
    applyVehicle(normalizeListing(raw));
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
    if (f) importSticker(await f.arrayBuffer(), f.name);
  };
  const takeSticker = () => {
    const url = $('stickerUrlInput').value.trim();
    if (!url) return;
    $('stickerUrlInput').value = '';
    closeSheet('stickerSheet');
    importSticker(url, 'the sticker');
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
    getUserCutouts: () => state.photos.filter((p) => p.cutout).map((p) => p.cutout),
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
  preview.textTarget = (hit) => {
    const tab = openSubTab('text');
    if (tab && tab !== 'all') return tab;
    if (hit && state.options[`${hit}Position`]) return hit;
    return null;
  };
  preview.load().then(() => renderOptions());

  // Settings: the dealer and this host. Dealer edits are kept as typed
  // and reach the Studio's Text tool as its default line.
  $('settingsBtn').onclick = () => { renderHost(); openSheet('settingsSheet'); };
  for (const id of ['f-dealer', 'f-greeting', 'f-address', 'f-citytags']) {
    $(id).addEventListener('change', () => { readVehicle(); renderOptions(); });
  }

  $('clearBtn').onclick = clearPhotos;
  $('lightboxClose').onclick = closeLightbox;
  $('lightboxPrev').onclick = (e) => { e.stopPropagation(); stepLightbox(-1); };
  $('lightboxNext').onclick = (e) => { e.stopPropagation(); stepLightbox(1); };
  $('lightbox').onclick = (e) => { if (e.target === $('lightbox')) closeLightbox(); };
  window.addEventListener('keydown', (e) => {
    if ($('lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
  });
  // A swipe on the photo steps it.
  let touchX = null;
  $('lightbox').addEventListener('touchstart', (e) => { touchX = e.touches[0]?.clientX ?? null; }, { passive: true });
  $('lightbox').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) stepLightbox(dx < 0 ? 1 : -1);
  });

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
    scanAbort = new AbortController();
    try {
      const { scanVin } = await import('./pipeline/scan.js');
      const vin = await scanVin($('scanVideo'), { onStatus: (m) => { $('scanStatus').textContent = m; }, signal: scanAbort.signal });
      if (vin) tookVin(vin);
    } catch (e) {
      $('scanStatus').textContent = /NotAllowed|Permission/i.test(String(e)) ? 'The camera was refused. A photo of the barcode works too.' : String(e.message || e);
    }
  };
  $('scanCancel').onclick = () => { scanAbort?.abort(); closeSheet('scanSheet'); };
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
  $('downloadBtn').onclick = downloadBundle;

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
