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
  MIN_ANGLE_CONFIDENCE, MIN_SCENE_CONFIDENCE,
} from './config.js';
import { initRuntime, runtime, loadModel, totalBytes } from './pipeline/runtime.js';
import { classifyScene, classifyAngle, loadLabels } from './pipeline/classify.js';
import { matte, applyMatte, gateCutout } from './pipeline/matte.js';
import { composeHero } from './pipeline/compose.js';
import { renderHeroVideo, isSupported as videoSupported } from './pipeline/video.js';
import { buildAllPosts, vehicleTitle, PLATFORMS } from './pipeline/copy.js';
import { decode, makeCanvas, ctxOf, canvasToBlob } from './lib/imageio.js';
import { makeZip, deliver } from './lib/zip.js';
import * as OPTS from './options.js';
import {
  loadOptions, saveOptions, resetOptions, toCliFlags, initFromSpec,
} from './options.js';
import { loadSpec, get as specGet } from './spec.js';
import { loadCore, version as coreVersion, enhanceInterior } from './core.js';
import { mountBrand, wireSurfaceLinks } from './chrome.js';
import { loadCapabilities, can, host, isSelfHosted, whyUnavailable } from './host.js';
import { renderControls, controlDefaults, controlsToFlags } from './controls.js';
import { loadAssets, needsServer, composeOnServer, scrapeOnServer, libraryOps } from './lib/delegate.js';
import { normalizeListing, takeListingFromHash, bookmarkletSource } from './pipeline/listing.js';
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
  pane: 'source',
  photos: [],            // { id, name, blob|url, thumb, status, scene, angle, cutout, hero }
  vehicle: {},
  dealer: {},
  running: false,
  done: false,
  posts: null,
  videos: null,
  sticker: null,
  options: null,
  errors: [],
};

let nextId = 1;

/* ---------- persistence -------------------------------------------
 * localStorage holds the dealer block and nothing else. It is a
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

/* ---------- navigation --------------------------------------------- */
function go(pane) {
  state.pane = pane;
  for (const p of ['source', 'details', 'options', 'results', 'library']) {
    $(`pane-${p}`).hidden = p !== pane;
  }
  for (const btn of document.querySelectorAll('.nav-btn')) {
    if (btn.dataset.go === pane) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  if (pane === 'results') $('resultsDot').classList.add('hidden');
}

function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }

/* ---------- adding photos ------------------------------------------ */
function isImageName(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

async function addFiles(files) {
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
    });
  }
  renderPhotos();
}

function addUrls(text) {
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
  $('photoCount').textContent = n;
  $('runBtn').disabled = n === 0 || state.running;

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
    img.src = p.thumb;
    img.alt = p.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    // A URL photo can fail CORS; show it as failed rather than as a
    // silently broken image icon.
    img.onerror = () => { tile.classList.add('is-pending'); tile.append(tagOf('unreachable')); };
    tile.appendChild(img);

    if (p.rejected) tile.appendChild(tagOf('skipped'));
    else if (p.scene) tile.appendChild(tagOf(p.angle ? `${p.scene} · ${p.angle}` : p.scene));

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
}

function renderResults() {
  const heroes = state.photos.filter((p) => p.hero);
  const interiors = state.photos.filter((p) => p.interior);

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
    const tile = el('div', 'tile');
    const scale = 420 / Math.max(p.interior.width, p.interior.height);
    const c = makeCanvas(Math.round(p.interior.width * scale), Math.round(p.interior.height * scale));
    ctxOf(c).drawImage(p.interior, 0, 0, c.width, c.height);
    const img = el('img');
    canvasToBlob(c, 'image/jpeg', 0.85).then((b) => { img.src = URL.createObjectURL(b); });
    img.alt = `Interior photo ${p.name}, corrected`;
    tile.append(img, tagOf('interior'));
    tile.onclick = () => saveInterior(p);
    interiorHost.appendChild(tile);
  }

  const grid = $('resultGrid');
  grid.innerHTML = '';
  for (const p of heroes) {
    const tile = el('div', 'tile');
    const c = makeCanvas(420, 420);
    ctxOf(c).drawImage(p.hero, 0, 0, 420, 420);
    const img = el('img');
    canvasToBlob(c, 'image/jpeg', 0.85).then((b) => { img.src = URL.createObjectURL(b); });
    img.alt = `Composed image from ${p.name}`;
    tile.append(img, tagOf(p.angle || 'hero'));
    tile.onclick = () => saveOne(p);
    grid.appendChild(tile);
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

/* ---------- options --------------------------------------------------
 * Built from the definitions in options.js rather than written into the
 * markup, so adding an option is a one-line change in one file and the
 * CLI echo below can never disagree with the controls above it. */
function chipRow(host, defs, selected, onToggle) {
  host.innerHTML = '';
  for (const [key, def] of Object.entries(defs)) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', selected.includes(key) ? 'true' : 'false');
    b.append(el('strong', null, def.label), el('span', null, `${def.size[0]}x${def.size[1]} ${def.note}`));
    b.onclick = () => onToggle(key);
    host.appendChild(b);
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

function renderOptions() {
  const o = state.options;

  const toggleIn = (list, key, atLeastOne = false) => {
    const i = list.indexOf(key);
    // Deselecting the last still format would leave the run with nothing
    // to produce, and it silently fell back to square anyway, so the
    // echo and the behaviour disagreed. Keep one selected instead.
    if (i >= 0 && !(atLeastOne && list.length === 1)) list.splice(i, 1);
    else if (i < 0) list.push(key);
    commitOptions();
  };

  chipRow($('heroFormats'), OPTS.HERO_FORMATS, o.heroFormats, (k) => toggleIn(o.heroFormats, k, true));
  chipRow($('videoFormats'), OPTS.VIDEO_FORMATS, o.videoFormats, (k) => toggleIn(o.videoFormats, k));
  $('videoNote').textContent = o.videoFormats.length
    ? 'Rendered after the stills. Measured around 5x realtime here, so a '
      + 'six second clip takes a second or two on a laptop.'
    : 'No video. Stills only, which is faster on a phone.';

  // One host, filled from the spec. The old hand-built Pipeline and
  // Look sections are gone: a new control now needs no code here.
  renderControls($('controlsHost'), o, (key, value) => {
    o[key] = value;
    commitOptions();
  });

  renderHost();
  // Built from the same control definitions the pane renders, so the
  // echo cannot describe a flag the UI does not actually have.
  const formatFlags = o.heroFormats.map((f) => `--hero-format ${f}`)
    .concat(o.videoFormats.length
      ? o.videoFormats.map((f) => `--video-format ${f}`)
      : ['--no-video']);
  $('cliEcho').textContent =
    `lotstretcher ./photos ${[...formatFlags, ...controlsToFlags(o)].join(' ')}`;
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

/* ---------- the run ------------------------------------------------ */
async function run() {
  if (state.running || !state.photos.length) return;
  state.running = true;
  state.done = false;
  state.errors = [];
  $('runBtn').disabled = true;
  go('results');
  $('progressSection').hidden = false;
  $('resultsEmpty').hidden = true;
  setProgress(0);

  const stages = [
    { n: 1, label: 'Loading models', state: 'active', detail: `${(totalBytes() / 1e6).toFixed(0)} MB, first run only` },
    { n: 2, label: 'Sorting photos', state: '' },
    { n: 3, label: 'Removing backgrounds', state: '' },
    { n: 4, label: 'Composing', state: '' },
  ];
  renderStages(stages);

  try {
    await initRuntime();
    $('isolationWarn').classList.toggle('hidden', runtime.isolated);

    await loadLabels();
    await Promise.all([
      loadModel('scene', (f) => setProgress(f * 0.2)),
      loadModel('angle'),
      loadModel('matte'),
    ]);
    stages[0].state = 'done';
    stages[0].detail = 'cached for next time';
    stages[1].state = 'active';
    renderStages(stages);

    // --- pass 1: scene. Runs on every photo, so it is the hot path.
    const total = state.photos.length;
    for (let i = 0; i < total; i++) {
      const p = state.photos[i];
      p.status = 'working';
      renderPhotos();
      try {
        const bitmap = await decode(p.blob || p.url);
        p.bitmap = bitmap;
        const scene = await classifyScene(bitmap);
        p.sceneConf = scene.confidence;
        // Too weak to route on. Keep the photo, do not act on the guess.
        p.scene = scene.confidence >= MIN_SCENE_CONFIDENCE ? scene.label : 'unsure';
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
          p.interior = enhanceInterior(p.bitmap);
        } catch (e) {
          state.errors.push(`${p.name}: ${e.message || e}`);
        }
      }
    }
    // cut_type "none" is the server's classify-only mode: sort the
    // photos, compose nothing.
    const exteriors = state.options.cutType === 'none'
      ? []
      : state.photos.filter((p) => p.scene === 'exterior');
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
        const m = await matte(p.bitmap);
        const cut = applyMatte(p.bitmap, m);
        p.ambiguous = m.ambiguous;
        p.coverage = cut.coverage;

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
          const angle = await classifyAngle(cutBitmap);
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
    stages[2].detail = `${exteriors.filter((p) => p.cutout).length} cut out`;
    stages[3].state = 'active';
    renderStages(stages);

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
              ...state.options,
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
        p.heroes[fmt] = composeHero(p.cutout, {
          seed: `${vid}:${p.name}:${fmt}`,
          exterior: state.vehicle.exterior_color,
          interior: state.vehicle.interior_color,
          width: w, height: h,
          spotlight: state.options.spotlight,
          marginFrac: state.options.margin,
          generic: state.options.backdrop === 'generic',
        });
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
      // Video is always rendered here, and a stock photo is a server
      // asset. Saying so beats a clip that quietly ignores the choice.
      if (state.options.backdrop === 'asset') {
        state.errors.push('video: stock backgrounds apply to stills only; the clip uses the gradient');
      }
      stages.push({ n: 5, label: 'Rendering video', state: 'active' });
      renderStages(stages);
      state.videos = {};
      for (const fmt of wantVideo) {
        const [w, h] = OPTS.VIDEO_FORMATS[fmt].size;
        try {
          state.videos[fmt] = await renderHeroVideo(cut.map((p) => p.cutout), {
            angles: cut.map((p) => p.angle || null),
            width: w, height: h,
            seed: `${vid}:video:${fmt}`,
            exterior: state.vehicle.exterior_color,
            interior: state.vehicle.interior_color,
            generic: state.options.backdrop === 'generic',
            spotlight: state.options.spotlight,
            glow: state.options.glow,
            glowColor: state.options.glowColor,
            glowRadius: state.options.glowRadius,
            glowIntensity: state.options.glowIntensity,
            onProgress: (f) => setProgress(0.85 + 0.15 * f),
          });
        } catch (e) {
          state.errors.push(`video ${fmt}: ${e.message || e}`);
        }
      }
      const made = Object.keys(state.videos).length;
      stages[4].state = 'done';
      stages[4].detail = made ? `${made} clip${made === 1 ? '' : 's'}` : 'failed';
      renderStages(stages);
    }

    state.posts = buildAllPosts(state.vehicle, { dealer: state.dealer });
    stages[3].state = 'done';
    stages[3].detail = `${cut.length} image${cut.length === 1 ? '' : 's'}`;
    renderStages(stages);
    setProgress(1);
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
    // Free the decoded source bitmaps. They are the largest thing we
    // hold and nothing downstream needs them once cutouts exist.
    for (const p of state.photos) { p.bitmap?.close?.(); p.bitmap = null; }
    state.running = false;
    $('runBtn').disabled = state.photos.length === 0;
    renderPhotos();
    renderResults();
  }
}

/* ---------- output -------------------------------------------------- */
function readVehicle() {
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

async function saveOne(photo) {
  const blob = await canvasToBlob(photo.hero, 'image/png');
  await deliver(blob, `${bundleName()}-${photo.angle || 'hero'}.png`);
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
  note.textContent = 'Reading the PDF...';
  try {
    const { parseSticker, stickerToVehicle } = await import('./pipeline/sticker.js');
    const parsed = await parseSticker(source);

    if (parsed.placeholder) {
      note.textContent = 'That sticker is not published yet (the PDF just says to check back).';
      return;
    }

    const fields = stickerToVehicle(parsed);
    const map = {
      year: 'f-year', make: 'f-make', model: 'f-model', trim: 'f-trim',
      exterior_color: 'f-ext', interior_color: 'f-int',
      price: 'f-price', vin: 'f-vin',
    };
    let filled = 0;
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

    note.textContent = [
      filled ? `Filled ${filled} field${filled === 1 ? '' : 's'}` : 'Fields were already filled',
      extras.length ? `, read ${extras.join(' and ')} for the post copy` : '',
      '.',
    ].join('');
  } catch (e) {
    // A CORS refusal is the common case and deserves a plain explanation
    // rather than the browser's own wording.
    const msg = /fetch|CORS|NetworkError/i.test(String(e))
      ? 'That host will not allow the browser to read the PDF. Download it and pick the file instead.'
      : String(e.message || e);
    note.textContent = msg;
  }
}

/* ---------- listing import --------------------------------------------
 * The bookmarklet opened this page with a vehicle record in the URL
 * fragment. Fill in what the CLI's scraper would have: the form fields,
 * the dealer, the photo links, and the spec lines the copy uses. */
function applyListing(raw) {
  if (raw.error) {
    $('warnBox').innerHTML = '';
    $('warnBox').appendChild(el('div', 'banner banner-err', raw.error));
    return;
  }
  applyVehicle(normalizeListing(raw));
}

/* Fill the app from a scrape.Vehicle-shaped record, whichever route it
 * came in by: the bookmarklet's normaliser or the server's /scrape. */
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

  addUrls(v.photo_urls.join('\n'));

  const bits = [`Imported ${v.title || 'a vehicle'} from the listing`];
  if (filled) bits.push(`${filled} field${filled === 1 ? '' : 's'}`);
  if (v.photo_urls.length) bits.push(`${v.photo_urls.length} photo link${v.photo_urls.length === 1 ? '' : 's'}`);
  const box = $('warnBox');
  box.innerHTML = '';
  const banner = el('div', 'banner', bits.join(' · ') + '.');
  box.appendChild(banner);
  for (const w of v.warnings) box.appendChild(el('div', 'banner banner-warn', w));

  /* A sticker link is the one thing worth acting on straight away: it
   * carries the option list and MSRP the analytics blob does not. */
  if (v.window_sticker_url) {
    const b = el('button', 'btn btn-sm', 'Read its window sticker too');
    b.onclick = () => { b.disabled = true; importSticker(v.window_sticker_url, 'the sticker'); };
    banner.append(' ', b);
  }
  go('source');
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
    // Bound to THIS origin: a self-hosted install's bookmarklet opens
    // that install, not lotstretcher.org.
    const src = bookmarkletSource(location.origin);
    $('bookmarkletLink').href = src;
    $('bookmarkletLink').onclick = (e) => {
      // Clicking it here would run it on this page, which has no listing.
      e.preventDefault();
      $('bookmarkletNote').textContent = 'Drag it to the bookmarks bar rather than clicking it here.';
    };
    $('bookmarkletCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(src);
        $('bookmarkletNote').textContent = 'Copied. Add a bookmark and paste this as its address.';
      } catch {
        $('bookmarkletNote').textContent = 'The browser refused the clipboard; drag the button instead.';
      }
    };
    $('bookmarkletNote').textContent = '';
    // Against a server that can scrape, the sheet also takes a URL. The
    // bookmarklet stays offered: it works from any browser, including
    // one that is not on the same machine as the server.
    $('listingUrlWrap').hidden = !can('scrape');
    $('listingUrlNote').textContent = '';
    openSheet('listingSheet');
  };
  $('listingUrlGo').onclick = async () => {
    const url = $('listingUrlInput').value.trim();
    if (!url) return;
    const note = $('listingUrlNote');
    const btn = $('listingUrlGo');
    btn.disabled = true;
    note.textContent = 'Your server is reading the page. A Cloudflare challenge can take a few seconds.';
    try {
      const v = await scrapeOnServer(url);
      closeSheet('listingSheet');
      applyVehicle(v);
      $('listingUrlInput').value = '';
    } catch (e) {
      note.textContent = String(e.message || e);
    } finally {
      btn.disabled = false;
    }
  };
  $('aboutBtn').onclick = () => {
    $('aboutRuntime').textContent = (runtime.isolated
      ? `threads: ${runtime.threads} · SIMD: on · cross-origin isolated`
      : 'single-threaded (no cross-origin isolation)')
      + ` · core: wasm v${coreVersion()}`;
    openSheet('aboutSheet');
  };

  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('folderInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('cameraInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  $('urlAdd').onclick = () => {
    addUrls($('urlInput').value);
    $('urlInput').value = '';
    closeSheet('urlSheet');
  };

  $('stickerFileBtn').onclick = () => $('stickerInput').click();
  $('stickerUrlBtn').onclick = () => openSheet('stickerSheet');
  $('stickerInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importSticker(await f.arrayBuffer(), f.name);
  };
  $('stickerUrlGo').onclick = () => {
    const url = $('stickerUrlInput').value.trim();
    closeSheet('stickerSheet');
    if (url) importSticker(url, 'the sticker');
  };

  $('resetOptions').onclick = () => { state.options = resetOptions(); renderOptions(); };

  $('clearBtn').onclick = clearPhotos;
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
  dz.addEventListener('drop', (e) => { if (e.dataTransfer?.files) addFiles(e.dataTransfer.files); });
  // Dropping anywhere but the zone should not navigate the tab to the file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // Report isolation as soon as we know, not only once a run starts --
  // it changes what the user should expect from the very first tap.
  initRuntime().then(() => {
    $('isolationWarn').classList.toggle('hidden', runtime.isolated);
  }).catch(() => { /* surfaced properly on run() */ });

  // Losing in-progress work to an accidental back-swipe would be
  // infuriating, and the work cannot be recovered -- nothing is stored.
  window.addEventListener('beforeunload', (e) => {
    if (state.running) { e.preventDefault(); e.returnValue = ''; }
  });

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
      else go('source');
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

  // Opened by the bookmarklet? The record rides in the fragment, which
  // the browser never sends anywhere; take it, then clear it.
  const listing = takeListingFromHash();
  if (listing) applyListing(listing);

  /* A debug handle.
   *
   * Deliberately exposed rather than kept private: everything here is
   * already the user's own data sitting in their own tab, there is no
   * secret to leak, and without it neither automation nor a person in
   * the console can check what the pipeline actually decided. Several
   * real bugs this session were only visible from the inside. */
  window.lotstretcher = {
    state,
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
