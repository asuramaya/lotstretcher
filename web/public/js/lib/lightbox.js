/* The lightbox: one image at full size, and the next.
 * Items are {src, name, tag, cors, save, alt}: `alt` an optional second
 * view of the same item ({src, label}: a booth photo's cutout), which
 * Show cutout / Show photo (or C) flips to and keeps while stepping; `src` a URL or a function
 * making one (a result's canvas is encoded only when looked at), `save`
 * an action for the Save button. The booth's photos and the run's
 * stills and interiors all open here. */

import { canvasToBlob } from './imageio.js';
import { deliver } from './zip.js';
import { STRETCHES, stretchLabel } from './stretch.js';

const $ = (id) => document.getElementById(id);
let lightboxItems = [];
let lightboxAt = -1;
const made = new Set();   // object URLs this box made, revoked on close
export function canvasItem(canvas, name, tag, save, quality = 0.92, stretch = null) {
  let url = null;
  return {
    name, tag, save, stretch,
    // Encoded again once the box has closed and revoked the last one.
    src: async () => { if (!made.has(url)) { url = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', quality)); made.add(url); } return url; },
  };
}
export function openLightbox(items, i, { alt = false } = {}) {
  if (!items.length) return;
  altOn = alt;
  lightboxItems = items;
  lightboxAt = Math.max(0, Math.min(i, items.length - 1));
  $('lightbox').hidden = false;
  showLightbox();
}
/* Showing a still is async (it is encoded when first looked at); Stretch
 * waits for the one in flight, or a late arrival repaints the plain
 * still over the limo and resets its length. */
let showing = Promise.resolve();
function showLightbox() {
  showing = paintLightbox();
  return showing;
}
async function paintLightbox() {
  const at = lightboxAt;
  const item = lightboxItems[at];
  if (!item) { closeLightbox(); return; }
  stretchAt = 0;
  $('lightboxStretch').hidden = !item.stretch;
  $('lightboxStretch').textContent = stretchLabel(0);
  const img = $('lightboxImg');
  const showAlt = altOn && !!item.alt;
  const view = showAlt ? item.alt : item;
  $('lightboxView').hidden = !item.alt;
  $('lightboxView').textContent = showAlt ? 'Show photo' : `Show ${item.alt?.label || 'cutout'}`;
  if (item.cors && !showAlt) img.crossOrigin = 'anonymous'; else img.removeAttribute('crossorigin');
  const src = typeof view.src === 'function' ? await view.src() : view.src;
  img.classList.toggle('is-cutout', showAlt);
  if (at !== lightboxAt) return;   // stepped on while encoding
  img.src = src;
  img.alt = item.name;
  $('lightboxCap').textContent = `${at + 1} of ${lightboxItems.length} · ${item.name}${item.tag ? ` · ${item.tag}` : ''}${showAlt ? ` · ${item.alt.label || 'cutout'}` : ''}`;
  $('lightboxSave').hidden = !item.save;
  $('lightboxSave').onclick = (e) => { e.stopPropagation(); item.save?.(); };
  $('lightboxPrev').disabled = at === 0;
  $('lightboxNext').disabled = at === lightboxItems.length - 1;
}
/* The second view (a photo's cutout), kept on while stepping so a run's
 * cutouts can be flicked through. */
let altOn = false;
function flipLightbox() {
  if ($('lightbox').hidden || !lightboxItems[lightboxAt]?.alt) return;
  altOn = !altOn;
  showLightbox();
}

/* Stretch (lib/stretch.js): each press a longer car, then back. The
 * stretched still is what Save gives while it is showing. */
let stretchAt = 0;
async function stretchLightbox() {
  await showing;
  const at = lightboxAt;
  const item = lightboxItems[at];
  if (!item?.stretch) return;
  stretchAt = (stretchAt + 1) % STRETCHES.length;
  const k = STRETCHES[stretchAt];
  const btn = $('lightboxStretch');
  btn.disabled = true;
  try {
    if (k === 1) { await showLightbox(); return; }
    const canvas = await item.stretch(k);
    if (at !== lightboxAt) return;
    const url = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.92));
    made.add(url);
    $('lightboxImg').src = url;
    $('lightboxCap').textContent = `${at + 1} of ${lightboxItems.length} · ${item.name} · ${k}× the car it was`;
    $('lightboxSave').onclick = async (e) => {
      e.stopPropagation();
      const base = item.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await deliver(await canvasToBlob(canvas, 'image/png'), `${base}-stretched-${k}x.png`);
    };
    btn.textContent = stretchLabel(stretchAt);
  } finally {
    btn.disabled = false;
  }
}

function stepLightbox(d) { if ($('lightbox').hidden) return; lightboxAt = Math.max(0, Math.min(lightboxAt + d, lightboxItems.length - 1)); showLightbox(); }
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightboxImg').removeAttribute('src');
  for (const u of made) URL.revokeObjectURL(u);
  made.clear();
  lightboxItems = [];
}

/* Close, step, swipe and keys; once, at start-up. */
export function wireLightbox() {
  $('lightboxClose').onclick = closeLightbox;
  $('lightboxStretch').onclick = (e) => { e.stopPropagation(); stretchLightbox(); };
  $('lightboxView').onclick = (e) => { e.stopPropagation(); flipLightbox(); };
  $('lightboxPrev').onclick = (e) => { e.stopPropagation(); stepLightbox(-1); };
  $('lightboxNext').onclick = (e) => { e.stopPropagation(); stepLightbox(1); };
  $('lightbox').onclick = (e) => { if (e.target === $('lightbox')) closeLightbox(); };
  window.addEventListener('keydown', (e) => {
    if ($('lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === 'c' || e.key === 'C') flipLightbox();
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
}
