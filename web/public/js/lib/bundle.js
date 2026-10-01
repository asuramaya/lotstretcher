/* What a run hands over: one still, one interior, or the whole bundle as
 * a zip, named and laid out as the CLI's bundle/ is (spec library.bundle). */

import { canvasToBlob } from './imageio.js';
import { makeZip, deliver } from './zip.js';
import { get as specGet } from '../spec.js';
import { vehicleTitle } from '../pipeline/copy.js';
import { walkaround } from '../pipeline/shots.js';

const $ = (id) => document.getElementById(id);

function bundleName(state) {
  const t = vehicleTitle(state.vehicle).replace(/\s+/g, '-');
  const id = state.vehicle.stock_number || state.vehicle.vin;
  return [t || 'lotstretcher', id].filter(Boolean).join('-');
}

export async function saveOne(state, photo, fmt = null) {
  const canvas = (fmt && photo.heroes?.[fmt]) || photo.hero;
  const blob = await canvasToBlob(canvas, 'image/png');
  const shape = fmt && fmt !== 'square' ? `-${fmt}` : '';
  await deliver(blob, `${bundleName(state)}-${photo.angle || 'hero'}${shape}.png`);
}

export async function saveInterior(state, photo) {
  const blob = await canvasToBlob(photo.interior, 'image/jpeg', interiorQuality());
  await deliver(blob, `${bundleName(state)}-interior-${photo.name.replace(/\.[^.]+$/, '')}.jpg`);
}

// The bundle's names and the interiors' JPEG quality, as the CLI's
// (spec library.bundle).
const bundleSpec = () => specGet('library').bundle;
const interiorQuality = () => bundleSpec().interiorQuality / 100;

export async function downloadBundle(state) {
  const btn = $('downloadBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Packaging…';
  try {
    const files = [];
    const bundle = bundleSpec();
    const heroes = walkaround(state.photos.filter((p) => p.hero));

    for (let i = 0; i < heroes.length; i++) {
      const p = heroes[i];
      const tag = p.angle ? `${String(i + 1).padStart(2, '0')}-${p.angle}` : String(i + 1).padStart(2, '0');
      for (const [fmt, canvas] of Object.entries(p.heroes || { square: p.hero })) {
        const blob = await canvasToBlob(canvas, 'image/png');
        files.push({ name: `${fmt}/${tag}.png`, data: blob });
        // The lead shot of each format also lands at the top level, the
        // same shape the CLI's bundle uses.
        if (i === 0) {
          const top = { square: bundle.hero, portrait: bundle.heroPortrait, horizontal: bundle.heroHorizontal }[fmt];
          files.push({ name: top || `hero-${fmt}.png`, data: blob });
        }
      }
      if (p.cutout) {
        files.push({ name: `cutout/${tag}.png`, data: await canvasToBlob(p.cutout, 'image/png') });
      }
    }

    const interiors = state.photos.filter((p) => p.interior);
    for (let i = 0; i < interiors.length; i++) {
      files.push({
        name: `${bundle.interior}/${String(i + 1).padStart(2, '0')}.jpg`,
        data: await canvasToBlob(interiors[i].interior, 'image/jpeg', interiorQuality()),
      });
    }

    for (const [fmt, blob] of Object.entries(state.videos || {})) {
      files.push({ name: bundle.videos[fmt] || `hero-video-${fmt}.mp4`, data: blob });
    }

    if (state.posts) {
      for (const [platform, text] of Object.entries(state.posts)) {
        files.push({ name: bundle.posts[platform] || `${platform}.txt`, data: text });
      }
    }
    files.push({ name: 'vehicle.json', data: JSON.stringify(state.vehicle, null, 2) });

    const zip = await makeZip(files);
    const how = await deliver(zip, `${bundleName(state)}.zip`);
    btn.textContent = how === 'shared' ? 'Shared' : 'Saved';
  } catch (e) {
    btn.textContent = 'Failed';
    console.error(e);
  } finally {
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1800);
  }
}
