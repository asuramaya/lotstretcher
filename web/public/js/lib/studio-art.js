/* The Studio's pictures: what each swatch shows and each look's tile,
 * drawn by the core from the preview's subject (its paint, its cutout),
 * so a choice looks like what it will make. */

import { get as specGet } from '../spec.js';
import { ctxOf } from './imageio.js';
import { entry as libraryEntry } from './library.js';
import { stillOptions, spotlightStyle } from './text.js';
import { composeHero } from '../pipeline/compose.js';
import { call as coreCall, toImageData as coreToImageData, renderFrame as coreRenderFrame,
  drawFrame as coreDrawFrame, vehicleGradientColors as coreVehicleGradientColors } from '../core.js';

/* `getSubject()` is the preview's subject ({cutout, exterior, interior,
 * seed, vehicle}) or null. */
export function studioArt(getSubject) {
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
        const subject = getSubject();
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
          const subject = getSubject();
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
      const subject = getSubject();
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
    const subject = getSubject();
    if (!subject) return null;
    const v = { ...values, ...lk.values };
    const key = JSON.stringify([lk.id, subject.seed, v.backdrop, v.backdropColor, v.backdropColor2, v.backdropAngle, spotlightStyle(v), v.glow, v.glowColor, v.glowRadius, v.glowIntensity,
      v.shadow, v.shadowStrength, v.reflection, v.reflectionStrength, v.border, v.frameColor, v.frameWeight]);
    if (!lookArtCache.has(key)) {
      try {
        const size = 128;
        // The run's look, drawn small: a wider margin, a tighter glow and
        // a heavier line, so they read at tile size.
        const look = stillOptions(v);
        const composed = composeHero(subject.cutout, {
          ...look,
          width: size, height: size, seed: `${subject.seed}:look`,
          exterior: subject.exterior, interior: subject.interior,
          marginFrac: 0.08,
          glowRadius: Math.max(2, Math.round((v.glowRadius || 24) / 6)),
          border: null, borderStyle: look.borderStyle ? { ...look.borderStyle, weight: Math.max(0.02, Number(v.frameWeight) || 0.008) * 2 } : null,
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
  return { swatchArt, lookArt };
}
