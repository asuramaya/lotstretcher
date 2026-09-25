/* Landing page behaviour: the brand, the sticky bar, the compare slider. */

import { mountBrand, wireSurfaceLinks, watchStuck } from './chrome.js';

mountBrand(document.getElementById('brandSlot'));
wireSurfaceLinks();

watchStuck(document.getElementById('appbar'));

/* ---------- before / after ----------
 * A range input does the work: it is draggable, keyboard-operable and
 * screen-reader-labelled for free. It sits invisible over the image and
 * drives a CSS variable; the visible handle is decorative. */
const compare = document.getElementById('compare');
const range = document.getElementById('cmpRange');
if (compare && range) {
  const apply = () => compare.style.setProperty('--split', `${range.value}%`);
  range.addEventListener('input', apply);
  apply();

  // A brief nudge on first view, so it reads as draggable rather than as
  // a static image with a decoration on it. Skipped when the visitor has
  // asked for reduced motion.
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    new IntersectionObserver((entries, obs) => {
      if (!entries[0].isIntersecting) return;
      obs.disconnect();
      const from = 50, to = 68, dur = 900;
      const t0 = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        // out-and-back, eased
        const e = Math.sin(p * Math.PI);
        range.value = String(from + (to - from) * e);
        apply();
        if (p < 1) requestAnimationFrame(tick);
      };
      setTimeout(() => requestAnimationFrame(tick), 500);
    }, { threshold: 0.6 }).observe(compare);
  }
}

/* Showing intent to open the app (a pointer over, a finger on, or focus
 * on a link to it) starts the models downloading into this origin's
 * cache, so the app is ready sooner. Never on a data saver, and once. */
let warmed = false;
function warm() {
  if (warmed || navigator.connection?.saveData) return;
  warmed = true;
  import('./pipeline/runtime.js').then((m) => m.prefetchModels()).catch(() => {});
}
for (const a of document.querySelectorAll('a[href="app.html"]')) {
  a.addEventListener('pointerenter', warm, { once: true });
  a.addEventListener('touchstart', warm, { once: true, passive: true });
  a.addEventListener('focus', warm, { once: true });
}

/* The clips: play while on screen, pause off it; a visitor who asked
 * for less motion gets the poster and the controls instead. */
const loops = [...document.querySelectorAll('video.loop')];
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (still) {
  for (const v of loops) v.controls = true;
} else if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target;
      if (e.isIntersecting) { v.preload = 'auto'; v.play().catch(() => {}); } else v.pause();
    }
  }, { threshold: 0.25 });
  for (const v of loops) io.observe(v);
}
