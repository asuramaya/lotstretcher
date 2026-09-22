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
  LIMITS, IMAGE_EXTS, CANVAS, PORTRAIT,
  MIN_ANGLE_CONFIDENCE, MIN_SCENE_CONFIDENCE,
} from './config.js';
import { initRuntime, runtime, loadModel, totalBytes } from './pipeline/runtime.js';
import { classifyScene, classifyAngle, loadLabels } from './pipeline/classify.js';
import { matte, applyMatte, gateCutout } from './pipeline/matte.js';
import { composeHero } from './pipeline/compose.js';
import { buildAllPosts, vehicleTitle, PLATFORMS } from './pipeline/copy.js';
import { decode, makeCanvas, ctxOf, canvasToBlob } from './lib/imageio.js';
import { makeZip, deliver } from './lib/zip.js';

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
  sticker: null,
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
  for (const p of ['source', 'details', 'results']) {
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

  const tab = document.querySelector('.nav-btn[data-go="results"]');
  tab.disabled = !state.running && heroes.length === 0;
  // A badge only while the user is looking at something else.
  $('resultsDot').classList.toggle('hidden', !(state.done && state.pane !== 'results'));

  $('heroSection').hidden = heroes.length === 0;
  $('copySection').hidden = !state.posts;
  $('resultsEmpty').hidden = heroes.length > 0 || state.running;

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
    const exteriors = state.photos.filter((p) => p.scene === 'exterior');
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
        });
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
    for (let i = 0; i < cut.length; i++) {
      const p = cut[i];
      p.hero = composeHero(p.cutout, {
        seed: `${state.vehicle.vin || state.vehicle.stock_number || 'v'}:${p.name}`,
        exterior: state.vehicle.exterior_color,
        interior: state.vehicle.interior_color,
        width: CANVAS, height: CANVAS,
      });
      // The portrait crop is a second composition, not a crop of the
      // square -- cropping a square to 4:5 cuts the vehicle's nose off.
      if (i === 0) {
        p.heroPortrait = composeHero(p.cutout, {
          seed: `${state.vehicle.vin || 'v'}:${p.name}:portrait`,
          exterior: state.vehicle.exterior_color,
          interior: state.vehicle.interior_color,
          width: PORTRAIT[0], height: PORTRAIT[1],
        });
      }
      setProgress(0.8 + 0.2 * ((i + 1) / Math.max(1, cut.length)));
      renderResults();
    }

    state.posts = buildAllPosts(state.vehicle, {
      dealer: state.dealer, sticker: state.sticker,
    });
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
  state.vehicle = {
    ...carried,
    year: $('f-year').value.trim(),
    make: $('f-make').value.trim(),
    model: $('f-model').value.trim(),
    trim: $('f-trim').value.trim(),
    exterior_color: $('f-ext').value.trim(),
    interior_color: $('f-int').value.trim(),
    price: $('f-price').value.trim(),
    mileage: $('f-miles').value.trim(),
    vin: $('f-vin').value.trim(),
    stock_number: $('f-stock').value.trim(),
  };
  state.dealer = { name: $('f-dealer').value.trim(), phone: $('f-phone').value.trim() };
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
      files.push({ name: `framed/${tag}.png`, data: await canvasToBlob(p.hero, 'image/png') });
      if (i === 0) files.push({ name: 'hero.png', data: await canvasToBlob(p.hero, 'image/png') });
      if (p.heroPortrait) {
        files.push({ name: 'hero-portrait.png', data: await canvasToBlob(p.heroPortrait, 'image/png') });
      }
      if (p.cutout) {
        files.push({ name: `cutout/${tag}.png`, data: await canvasToBlob(p.cutout, 'image/png') });
      }
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

/* ---------- wiring --------------------------------------------------- */
function init() {
  loadDealer();
  $('f-dealer').value = state.dealer.name || '';
  $('f-phone').value = state.dealer.phone || '';

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
  $('aboutBtn').onclick = () => {
    $('aboutRuntime').textContent = runtime.isolated
      ? `threads: ${runtime.threads} · SIMD: on · cross-origin isolated`
      : 'single-threaded (no cross-origin isolation)';
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

  renderPhotos();
  renderResults();
}

init();
