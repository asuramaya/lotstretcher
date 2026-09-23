/* The live preview beside the levers.
 *
 * Every option that changes the still redraws a real composite through
 * the core, on a sample vehicle shipped with the site (three cutouts
 * from real listings, with their real paint names) or on the user's own
 * cutout once a run has produced one. Nothing here is a mock-up: the
 * preview is the same call the run makes, at a smaller size.
 *
 * What cannot be seen is said in numbers. Formats, video length and the
 * pipeline switches turn into an estimate of what the run will produce
 * and roughly how long it will take on this device, scaled from the
 * time the preview itself just took. */

import { composeHero } from './pipeline/compose.js';
import { prepareClip, drawClipFrame } from './pipeline/video.js';
import { get as specGet } from './spec.js';
import * as OPTS from './options.js';

const SAMPLES_URL = 'demo/samples/samples.json';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

async function loadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} loading ${url}`);
  const bitmap = await createImageBitmap(await r.blob());
  const c = document.createElement('canvas');
  c.width = bitmap.width; c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return c;
}

export class Preview {
  /* `host` holds #previewCanvas, #previewSamples and #estimates.
   * `getOptions()` returns the live options; `getVehicle()` the form's
   * vehicle (for its colours); `getUserCutout()` a cutout canvas from
   * the last run, or null. */
  constructor(host, { getOptions, getVehicle, getUserCutout, getUserCutouts = null, getPhotoCount }) {
    this.host = host;
    this.canvas = host.querySelector('#previewCanvas');
    this.samplesHost = host.querySelector('#previewSamples');
    this.estimatesHost = host.querySelector('#estimates');
    this.caption = host.querySelector('#previewCaption');
    this.getOptions = getOptions;
    this.getVehicle = getVehicle;
    this.getUserCutout = getUserCutout;
    this.getUserCutouts = getUserCutouts;
    this.getPhotoCount = getPhotoCount;
    this.samples = [];
    this.current = null;      // the chosen sample's key, or 'yours'
    this.mode = 'still';      // or 'video': one frame of the clip a run would render
    this.scrub = 0.35;        // where in the clip that frame is
    this.clip = null;         // the prepared clip, keyed by what shaped it
    this.clipKey = null;
    this.modesHost = host.querySelector('#previewModes');
    this.scrubInput = host.querySelector('#previewScrub');
    for (const b of this.modesHost?.querySelectorAll('[data-mode]') || []) {
      b.onclick = () => this.setMode(b.dataset.mode);
    }
    if (this.scrubInput) {
      this.scrubInput.oninput = () => { this.scrub = Number(this.scrubInput.value) / 1000; this.update(); };
    }
    this.timer = null;
    this.lastMs = null;       // how long the last preview compose took
    this.busy = false;
    this.pending = false;
  }

  async load() {
    try {
      const list = await (await fetch(SAMPLES_URL)).json();
      this.samples = await Promise.all(list.map(async (s) => ({ ...s, cutout: await loadImage(s.file) })));
    } catch (e) {
      this.samples = [];
      this.estimatesHost.textContent = `The sample vehicles did not load: ${e.message || e}`;
    }
    this.current = this.samples[0]?.key || null;
    this.renderSamples();
    this.update();
  }

  renderSamples() {
    const host = this.samplesHost;
    host.innerHTML = '';
    const yours = this.getUserCutout();
    const options = [...this.samples.map((s) => ({ key: s.key, label: s.title, note: s.exterior }))];
    if (yours) options.unshift({ key: 'yours', label: 'Your vehicle', note: 'from this run' });
    if (this.current === 'yours' && !yours) this.current = this.samples[0]?.key || null;
    for (const o of options) {
      const b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(o.key === this.current));
      b.append(el('strong', null, o.label), el('span', null, o.note));
      b.onclick = () => { this.current = o.key; this.renderSamples(); this.update(); };
      host.appendChild(b);
    }
  }

  setMode(mode) {
    this.mode = mode;
    for (const b of this.modesHost.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    this.scrubInput.hidden = mode !== 'video';
    this.update();
  }

  /* The video mode is offered only while a clip is going to be made. */
  syncModes() {
    const o = this.getOptions();
    const wantVideo = !!(o?.videoFormats?.length);
    if (this.modesHost) this.modesHost.hidden = !wantVideo;
    if (!wantVideo && this.mode === 'video') this.setMode('still');
  }

  subjectLabel() {
    if (this.current === 'yours') return 'Your vehicle';
    return this.samples.find((x) => x.key === this.current)?.title || 'Sample';
  }

  /* The cutout and colours the preview draws: the user's own vehicle
   * takes the form's colours, a sample takes its real ones. */
  subject() {
    if (this.current === 'yours') {
      const cut = this.getUserCutout();
      if (cut) {
        const v = this.getVehicle() || {};
        return { cutout: cut, exterior: v.exterior_color || null, interior: v.interior_color || null, seed: 'yours' };
      }
    }
    const s = this.samples.find((x) => x.key === this.current) || this.samples[0];
    return s ? { cutout: s.cutout, exterior: s.exterior, interior: s.interior, seed: s.key } : null;
  }

  /* Coalesced: a slider fires many times a second and one compose is a
   * few hundredths of one, so edits collapse onto the next frame and a
   * draw in flight is followed by exactly one more. */
  update() {
    if (this.timer) return;
    this.timer = requestAnimationFrame(() => { this.timer = null; this.draw(); });
  }

  /* The size to draw at: the canvas's displayed width times the device
   * pixel ratio, so the preview is crisp on a 2x screen and never a
   * 600 px bitmap stretched across 900. Capped: the run's own size is
   * the ceiling, and the estimate scales from whatever this is. */
  targetSize(fw, fh) {
    // The stage is square; the longer side of the format fills it.
    const shown = this.canvas.parentElement?.clientWidth || this.canvas.clientWidth || 600;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.min(Math.max(fw, fh), Math.max(320, Math.round(shown * dpr)));
    const scale = px / Math.max(fw, fh);
    return [Math.max(2, Math.round(fw * scale / 2) * 2), Math.max(2, Math.round(fh * scale / 2) * 2)];
  }

  async draw() {
    if (this.busy) { this.pending = true; return; }
    const subject = this.subject();
    const o = this.getOptions();
    if (!subject || !o) { this.renderEstimates(); return; }
    this.busy = true;
    this.canvas.classList.add('is-busy');
    try {
      if (this.mode === 'video') { this.drawVideoFrame(subject, o); return; }
      // The first selected still format decides the preview's shape.
      const fmt = OPTS.HERO_FORMATS[o.heroFormats?.[0]] || OPTS.HERO_FORMATS.square || { size: [1254, 1254] };
      const [fw, fh] = fmt.size;
      const [width, height] = this.targetSize(fw, fh);
      if (this.caption) this.caption.textContent = `${this.subjectLabel()} \u00b7 ${fmt.label || o.heroFormats?.[0] || 'still'}`;
      const t0 = performance.now();
      // A frame decides the canvas size, so a large one is scaled down
      // to the preview's size first: the run uses it at full size.
      let border = o.customFrame || null;
      if (border && Math.max(border.width, border.height) > Math.max(width, height)) {
        const k = Math.max(width, height) / Math.max(border.width, border.height);
        const small = document.createElement('canvas');
        small.width = Math.max(1, Math.round(border.width * k));
        small.height = Math.max(1, Math.round(border.height * k));
        small.getContext('2d').drawImage(border, 0, 0, small.width, small.height);
        border = small;
      }
      const composed = composeHero(subject.cutout, {
        width, height,
        seed: `${subject.seed}:preview`,
        exterior: subject.exterior, interior: subject.interior,
        generic: o.backdrop === 'generic',
        background: o.backdrop === 'custom' ? o.customBackground || null : null,
        border,
        spotlight: o.spotlight,
        marginFrac: o.margin,
        glow: o.glow, glowColor: o.glowColor, glowRadius: o.glowRadius, glowIntensity: o.glowIntensity,
      });
      this.lastMs = performance.now() - t0;
      this.lastPixels = composed.width * composed.height;
      this.canvas.width = composed.width;
      this.canvas.height = composed.height;
      this.canvas.getContext('2d').drawImage(composed, 0, 0);
    } catch (e) {
      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#888'; ctx.font = '14px system-ui';
      ctx.fillText(`Preview failed: ${e.message || e}`, 12, 24);
    } finally {
      this.busy = false;
      this.canvas.classList.remove('is-busy');
      this.renderEstimates();
      if (this.pending) { this.pending = false; this.update(); }
    }
  }

  /* One frame of the clip a run would render, at the chosen video
   * format's shape: the conveyor when three shots are on hand (the
   * three samples, or the user's cutouts), the push otherwise. The
   * clip is prepared once per shape and redrawn per scrub. */
  drawVideoFrame(subject, o) {
    const fmt = OPTS.VIDEO_FORMATS[o.videoFormats?.[0]] || { size: [720, 720] };
    const [fw, fh] = fmt.size;
    const [width, height] = this.targetSize(fw, fh);
    let cutouts; let seed;
    if (this.current === 'yours') {
      cutouts = (this.getUserCutouts?.() || [subject.cutout]).slice(0, 5);
      seed = 'yours';
    } else {
      cutouts = this.samples.map((s) => s.cutout);
      seed = subject.seed;
    }
    const key = JSON.stringify([width, height, seed, o.backdrop === 'generic', o.spotlight, subject.exterior, subject.interior, cutouts.length]);
    if (key !== this.clipKey) {
      this.clip = prepareClip(cutouts, {
        width, height, seed: `${seed}:video`, exterior: subject.exterior, interior: subject.interior,
        generic: o.backdrop === 'generic', spotlight: o.spotlight,
      });
      this.clipKey = key;
    }
    if (this.caption) this.caption.textContent = `${this.subjectLabel()} \u00b7 ${fmt.label || 'video'} \u00b7 ${(this.scrub * this.clip.duration).toFixed(1)} s`;
    const t0 = performance.now();
    this.canvas.width = width; this.canvas.height = height;
    drawClipFrame(this.canvas.getContext('2d'), this.clip, this.scrub * this.clip.duration, {
      spotlight: o.spotlight, glow: o.glow, glowColor: o.glowColor, glowRadius: o.glowRadius, glowIntensity: o.glowIntensity,
    });
    this.lastMs = performance.now() - t0;
    this.lastPixels = width * height;
  }

  /* What the run will produce, and roughly what it costs. Times scale
   * from the preview's own measured compose, so they track this device
   * rather than a laptop the numbers were once measured on. */
  renderEstimates() {
    this.syncModes();
    const host = this.estimatesHost;
    host.innerHTML = '';
    const o = this.getOptions();
    if (!o) return;
    const photos = Math.max(1, this.getPhotoCount());
    const perPixelMs = this.lastMs && this.lastPixels ? this.lastMs / this.lastPixels : null;
    const row = (label, text) => {
      const r = el('div', 'estimate');
      r.append(el('strong', null, label), el('span', null, text));
      host.appendChild(r);
    };

    const stills = o.heroFormats || [];
    if (stills.length) {
      let ms = 0;
      for (const f of stills) {
        const [w, h] = OPTS.HERO_FORMATS[f]?.size || [1254, 1254];
        if (perPixelMs) ms += perPixelMs * w * h;
      }
      const per = ms ? ` · about ${fmtSeconds(ms / 1000)} per photo on this device` : '';
      row('Stills', `${stills.length} format${stills.length === 1 ? '' : 's'} × up to ${photos} photo${photos === 1 ? '' : 's'}${per}`);
    }

    const clips = o.videoFormats || [];
    if (clips.length) {
      const dur = Number(o.videoDuration) || specGet('video').fpsBrowser && 8;
      const fps = Number(o.videoFps) || specGet('video').fpsBrowser;
      let ms = 0; let mb = 0;
      for (const f of clips) {
        const fmt = OPTS.VIDEO_FORMATS[f] || {};
        const [w, h] = fmt.size || [720, 720];
        // A frame is lighter than a still (bilinear, cached cars), so
        // the still's cost is scaled down; measured about 0.4 of it.
        if (perPixelMs) ms += perPixelMs * w * h * 0.4 * dur * fps;
        mb += fmt.budgetMb || 0;
      }
      const time = ms ? `, about ${fmtSeconds(ms / 1000)} to render` : '';
      const size = mb ? `, up to ${mb} MB` : '';
      row('Video', `${clips.length} clip${clips.length === 1 ? '' : 's'} of ${dur} s at ${fps} fps${time}${size}`);
    } else {
      row('Video', 'none');
    }

    const on = [];
    if (o.photoSort) on.push('sort photos');
    if (o.interiors) on.push('keep interiors');
    if (o.strictCutouts) on.push('strict cutouts');
    if (o.upscale) on.push('upscale on your server');
    row('Pipeline', on.length ? on.join(' · ') : 'cutouts only');

    if (this.lastMs) row('Preview', `drawn in ${Math.round(this.lastMs)} ms by the core`);
  }
}

function fmtSeconds(s) {
  if (s < 1) return `${Math.max(0.1, Math.round(s * 10) / 10)} s`;
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}
