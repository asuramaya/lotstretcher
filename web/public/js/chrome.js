/* The shared header, used by both the landing page and the app.
 *
 * The two pages previously had separate headers that happened to look
 * similar, and there was no way back from the app: you could reach it
 * and not leave it. Same reasoning as everything else on this surface,
 * applied to chrome instead of controls: one definition, two callers.
 *
 * Each page supplies its own ACTIONS (the landing page wants "Open app",
 * the app wants About and Process). What is shared is the brand, the
 * cross-link between surfaces, and the behaviour. */

const SURFACES = {
  landing: { href: 'index.html', label: 'Home', title: 'Back to the landing page' },
  app: { href: 'app.html', label: 'Open app', title: 'Open the app' },
};

/* Where are we? Deliberately derived from the document rather than
 * passed in, so a page cannot label itself wrongly. */
export function currentSurface() {
  return document.body.classList.contains('is-app') ? 'app' : 'landing';
}

/* Fill `host` with the shared brand.
 *
 * The brand is a link to the landing page from the app, and an anchor to
 * the top from the landing page itself. A brand that navigates when you
 * are already there is a small lie and a real annoyance on mobile, where
 * it is the easiest thing to hit by accident. The cross-link to the
 * other surface is one of the page's own actions (data-go-surface), so
 * it sits with them on the right rather than crowding the brand.
 */
export function mountBrand(host) {
  if (!host) return;
  const here = currentSurface();
  const other = here === 'app' ? 'landing' : 'app';

  host.innerHTML = '';

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = here === 'app' ? SURFACES.landing.href : '#top';
  brand.title = here === 'app' ? SURFACES.landing.title : '';

  const mark = document.createElement('span');
  mark.className = 'brand-mark';
  brand.append(mark, document.createTextNode(' lotstretcher'));
  host.appendChild(brand);

  return { here, other };
}

/* Keep the header's bottom rule off until the page has scrolled under
 * it: a rule on an unscrolled page is a line for no reason. */
export function watchStuck(bar) {
  if (!bar || !('IntersectionObserver' in window)) return;
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;pointer-events:none';
  document.body.prepend(sentinel);
  new IntersectionObserver(([e]) => bar.classList.toggle('stuck', !e.isIntersecting)).observe(sentinel);
}

/* Wire any element carrying data-go-surface. Lets a page add its own
 * cross-links (a footer, an empty state) without repeating the hrefs. */
export function wireSurfaceLinks(root = document) {
  for (const el of root.querySelectorAll('[data-go-surface]')) {
    const target = SURFACES[el.dataset.goSurface];
    if (!target) continue;
    el.setAttribute('href', target.href);
    if (!el.textContent.trim()) el.textContent = target.label;
  }
}
