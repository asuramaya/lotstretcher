/* Renders the Options pane from shared/pipeline-spec.json's `controls`
 * block.
 *
 * THE POINT: adding a control is a single spec edit plus the CLI flag it
 * names. Nothing here changes, no markup is written, and
 * tests/test_control_parity.py fails if the flag is missing. That is
 * what keeps the UI and the CLI one route rather than two that happen
 * to resemble each other today.
 *
 * Controls whose `surfaces` exclude "browser", or whose `requires`
 * capability this host lacks, are rendered DISABLED with the reason
 * rather than hidden. A control that silently disappears on the public
 * site reads as a bug; one that says "needs your own machine" explains
 * what self-hosting is for. */

import { get } from './spec.js';
import { can, isSelfHosted } from './host.js';
import { assets } from './lib/delegate.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function availability(control) {
  const surfaces = control.surfaces || ['browser', 'cli', 'server'];

  /* Three separate questions, and conflating them produced a wrong
   * answer: the pane told a self-hosted user that "Branded frame" was
   * "command line only" while running against the very server that can
   * do it.
   *
   *   1. Can the browser do this itself?      surfaces includes browser
   *   2. Can this host do it on our behalf?   surfaces includes server,
   *                                           and the host is one
   *   3. Does the host report the capability? requires
   */
  const inBrowser = surfaces.includes('browser');
  const viaServer = surfaces.includes('server') && isSelfHosted();

  if (!inBrowser && !viaServer) {
    return { ok: false, why: control.cliNote || 'Command line only.' };
  }
  if (control.requires && !can(control.requires)) {
    return {
      ok: false,
      why: isSelfHosted()
        ? `This host does not report ${control.requires}.`
        : 'Needs lotstretcher running on your own machine.',
    };
  }
  /* Previously this returned "the app cannot hand off to it yet", which
   * was true until the /compose endpoint existed. It now can, so a
   * server-capable control is simply available, and the pane says where
   * the work will happen. */
  if (!inBrowser && viaServer) {
    return { ok: true, why: null, onServer: true };
  }
  return { ok: true, why: null };
}

/* A choice with `expand` fans out into one entry per asset of that
 * kind (each carrying the asset's name and the choice's gates), so a
 * swatch grid shows the library's frames as frames rather than as a
 * select beside a "Stock" tile. With no library the tile stays as one
 * locked entry that says so. */
function expanded(control) {
  const out = [];
  for (const c of control.choices || []) {
    if (!c.expand) { out.push(c); continue; }
    const library = assets()[c.expand] || [];
    if (!library.length) { out.push({ ...c, empty: true }); continue; }
    for (const a of library) {
      out.push({
        // The tile says where the asset lives: the site's own studio
        // composes here, a server-only asset is composed by the server.
        ...c, label: a.label, hint: a.local ? 'Studio' : 'Your server', asset: a.value,
        value: c.into === control.key ? a.value : c.value,
        sets: c.into && c.into !== control.key ? { [c.into]: a.value } : null,
      });
    }
  }
  return out;
}

function choicesFor(control) {
  if (!control.dynamic) return expanded(control);
  if (control.dynamic === 'glowColors') {
    return Object.keys(get('glow', 'colors')).map((v) => ({ value: v, label: v }));
  }
  // Asset lists come from the host. A browser has none, so these are
  // empty on lotstretcher.org and real against a server.
  const library = assets();
  if (control.dynamic === 'borders') return library.borders || [];
  if (control.dynamic === 'backgrounds') return library.backgrounds || [];
  if (control.dynamic === 'audio') return library.audio || [];
  return [];
}

/* `showWhen` is either a key (shown while that value is truthy),
 * { key, equals } (shown while that value matches) or { key, notEquals }
 * (shown while it differs). The object forms let a dependent control
 * follow a select, as the background picker follows "Stock background"
 * and the frame fit follows any frame at all. */
export function shownBy(control, values) {
  const cond = control.showWhen;
  if (!cond) return true;
  if (typeof cond === 'string') return !!values[cond];
  if ('notEquals' in cond) return values[cond.key] !== cond.notEquals;
  return values[cond.key] === cond.equals;
}

/* The chosen entry of a select, if it is a static one. */
function chosen(control, value) {
  return (control.choices || []).find((c) => c.value === value);
}

function buildToggle(control, value, onChange, disabled) {
  const sw = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!value;
  input.disabled = disabled;
  input.setAttribute('aria-label', control.label);
  input.onchange = () => onChange(input.checked);
  sw.append(input, el('i'));
  return sw;
}

function buildSelect(control, value, onChange, disabled) {
  const sel = document.createElement('select');
  sel.className = 'field';
  sel.disabled = disabled;
  const choices = choicesFor(control);
  if (!choices.length) {
    const o = document.createElement('option');
    o.textContent = control.emptyNote || 'none available';
    sel.appendChild(o);
    sel.disabled = true;
    return sel;
  }
  for (const c of choices) {
    const o = document.createElement('option');
    o.value = String(c.value);
    o.textContent = c.label ?? String(c.value);
    /* A choice can be gated on its own ("Stock background" needs an
     * asset library the browser has not got). It stays listed and
     * disabled, for the same reason a whole control does: a choice that
     * vanishes reads as a bug, one that says why reads as a feature of
     * self-hosting. */
    if (c.requires && !can(c.requires)) {
      o.disabled = true;
      o.textContent += isSelfHosted() ? ' (host lacks it)' : ' (your server only)';
    }
    if (String(c.value) === String(value)) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    // Keep the original type: a select that silently turns 30 into "30"
    // breaks anything comparing against the spec's numeric default.
    const raw = sel.value;
    const match = choices.find((c) => String(c.value) === raw);
    onChange(match ? match.value : raw);
  };
  return sel;
}

/* A line of the user's own words. Every keystroke is a live change (the
 * preview redraws the title as it is typed) and leaving the box commits
 * it, the same split as a slider, for the same reason. */
function buildText(control, value, onChange, disabled) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.value = value ?? '';
  input.placeholder = control.placeholder || '';
  input.maxLength = control.maxLength || 80;
  input.disabled = disabled;
  input.setAttribute('aria-label', control.label);
  input.oninput = () => onChange(input.value, true);
  input.onchange = () => onChange(input.value);
  return input;
}

/* A slider reports every movement as a LIVE change (the preview follows
 * the thumb) and the final value on release as a real one; re-rendering
 * the pane on every movement would rebuild the very slider being
 * dragged. */
function buildRange(control, value, onChange, disabled) {
  const wrap = el('div', 'range-wrap');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = control.min;
  input.max = control.max;
  input.step = control.step;
  input.value = value;
  input.disabled = disabled;
  input.setAttribute('aria-label', control.label);
  const out = el('span', 'range-out', formatValue(control, value));
  input.oninput = () => {
    out.textContent = formatValue(control, Number(input.value));
    onChange(Number(input.value), true);
  };
  input.onchange = () => onChange(Number(input.value));
  wrap.append(input, out);
  return wrap;
}

/* An image of the user's own: a picker, a thumbnail once chosen, and a
 * way to drop it. The value is a canvas (with .sourceBlob and .name),
 * kept in memory and in IndexedDB by the app; it never goes into the
 * options blob, which is JSON. */
function buildFile(control, value, onChange, disabled) {
  const wrap = el('div', 'file-wrap');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.className = 'sr-only';
  input.setAttribute('aria-label', control.label);
  input.onchange = async () => {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    const { blobToCanvas } = await import('./lib/store.js');
    const canvas = await blobToCanvas(f);
    if (!canvas) return;
    canvas.name = f.name;
    onChange(canvas);
  };
  const pick = el('button', 'btn btn-sm', value ? 'Change' : 'Choose image');
  pick.type = 'button';
  pick.disabled = disabled;
  pick.onclick = () => input.click();
  wrap.append(input);
  if (value) {
    const thumb = document.createElement('canvas');
    thumb.className = 'file-thumb';
    const scale = 40 / Math.max(value.width, value.height);
    thumb.width = Math.max(1, Math.round(value.width * scale));
    thumb.height = Math.max(1, Math.round(value.height * scale));
    thumb.getContext('2d').drawImage(value, 0, 0, thumb.width, thumb.height);
    thumb.title = value.name || '';
    const clear = el('button', 'btn btn-ghost btn-sm', 'Remove');
    clear.type = 'button';
    clear.onclick = () => onChange(null);
    wrap.append(thumb, pick, clear);
  } else {
    wrap.append(pick);
  }
  return wrap;
}

/* An image is picked for a tile that stands for the user's own file. */
function pickImage(fileControl, onPicked) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.className = 'sr-only';
  input.onchange = async () => {
    const f = input.files?.[0];
    input.remove();
    if (!f) return;
    const { blobToCanvas } = await import('./lib/store.js');
    const canvas = await blobToCanvas(f);
    if (!canvas) return;
    canvas.name = f.name;
    onPicked(canvas);
  };
  document.body.appendChild(input);
  input.click();
}

/* Tiles instead of a <select>: each choice shows what it is (a gradient,
 * a stock photo, a frame, a colour) through `thumbFor`, supplied by the
 * app. A choice with `file` is the user's own image: its tile shows the
 * image once chosen and opens the picker when tapped. */
function buildSwatches(control, values, onChange, disabled, thumbFor, allControls) {
  const grid = el('div', 'swatches');
  const current = values[control.key] ?? control.default;
  for (const choice of choicesFor(control)) {
    const tile = el('button', 'swatch');
    tile.type = 'button';
    const locked = disabled || (choice.requires && !can(choice.requires)) || choice.empty;
    const fileControl = choice.file ? allControls.find((c) => c.key === choice.file) : null;
    const image = fileControl ? values[fileControl.key] : null;
    const pressed = String(current) === String(choice.value)
      && (!choice.sets || Object.entries(choice.sets).every(([k, v]) => String(values[k]) === String(v)));
    tile.setAttribute('aria-pressed', String(pressed));
    if (locked) tile.classList.add('is-locked');
    const thumb = el('span', 'swatch-thumb');
    const art = thumbFor ? thumbFor(control, choice, values, image) : null;
    if (art instanceof HTMLElement) thumb.appendChild(art);
    else if (art && art.color) thumb.style.background = art.color;
    else if (typeof art === 'string') { const im = document.createElement('img'); im.src = art; im.alt = ''; im.loading = 'lazy'; thumb.appendChild(im); }
    else thumb.classList.add(choice.file ? 'is-upload' : 'is-plain');
    if (choice.file && image) thumb.classList.add('has-image');
    const label = el('span', 'swatch-label', choice.label ?? String(choice.value));
    const hint = el('span', 'swatch-hint', locked
      ? (choice.empty ? (isSelfHosted() ? 'Library is empty' : 'Your server only') : (isSelfHosted() ? 'Host lacks it' : 'Your server only'))
      : (choice.file && image ? (image.name || 'chosen') : (choice.hint || '')));
    tile.append(thumb, label, hint);
    tile.title = choice.hint || '';
    tile.disabled = !!locked;
    tile.onclick = () => {
      const choose = () => {
        if (choice.sets) for (const [k, v] of Object.entries(choice.sets)) onChange(k, v, true);
        onChange(control.key, choice.value);
      };
      if (fileControl) {
        // Tap once to pick an image (and select it); tap again, once an
        // image is set, to reselect it. Change it from the small link.
        if (image) choose();
        else pickImage(fileControl, (canvas) => { onChange(fileControl.key, canvas, true); onChange(fileControl.key, canvas); choose(); });
        return;
      }
      choose();
    };
    if (fileControl && image && !locked) {
      const change = el('span', 'swatch-change', 'change');
      change.onclick = (e) => {
        e.stopPropagation();
        pickImage(fileControl, (canvas) => { onChange(fileControl.key, canvas); if (pressed) onChange(control.key, choice.value); });
      };
      tile.appendChild(change);
    }
    grid.appendChild(tile);
  }
  return grid;
}

function formatValue(control, value) {
  if (control.unit === 's') return `${value}s`;
  if (control.unit === 'px') return `${value}px`;
  if (control.unit === 'fraction') return `${Math.round(value * 100)}%`;
  return String(value);
}

/* What a group's badge says. `affects` comes from the spec: a group
 * that changes the still is what the live preview answers to; video
 * and pipeline groups are answered by the estimates instead. */
const BADGES = {
  still: ['Live preview', 'is-live'],
  video: ['Video', ''],
  pipeline: ['Pipeline', ''],
};

/* Groups the user has shut or opened stay that way for the session;
 * without this every edit re-rendered them back to their defaults. */
const openState = new Map();

/* Render every group into `host`. `values` is the live options object;
 * `onChange(key, value)` is called on every edit. Each group is a
 * collapsible: open when something in it is usable on this host, shut
 * with a "needs your server" badge when nothing is. */
export function renderControls(host, values, onChange, { thumbFor = null } = {}) {
  host.innerHTML = '';
  const allControls = get('controls', 'groups').flatMap((g) => g.controls);

  for (const group of get('controls', 'groups')) {
    // A hidden control is real (it has a flag, a value, a showWhen) but
    // is presented inside another one's swatches.
    const visible = group.controls.filter((c) => shownBy(c, values) && c.presentation !== 'hidden');
    if (!visible.length) continue;

    const usable = visible.some((c) => availability(c).ok);
    const section = el('details', 'ctrl-group');
    // Open by default: what changes the picture. The pipeline and video
    // groups start shut; the estimates beside the preview speak for them.
    section.open = openState.has(group.id) ? openState.get(group.id) : (usable && group.affects === 'still');
    section.ontoggle = () => openState.set(group.id, section.open);
    const summary = el('summary');
    summary.appendChild(el('span', 'ctrl-group-head', group.label));
    const [text, cls] = BADGES[group.affects] || ['', ''];
    if (!usable) summary.appendChild(el('span', 'ctrl-badge is-server', isSelfHosted() ? 'Host lacks it' : 'Needs your server'));
    else if (text) summary.appendChild(el('span', `ctrl-badge ${cls}`, text));
    section.appendChild(summary);
    const body = el('div', 'ctrl-group-body');
    section.appendChild(body);
    const elsewhere = [];

    for (const control of visible) {
      const { ok, why, onServer } = availability(control);
      if (control.presentation === 'swatches') {
        const block = el('div', 'opt opt-block');
        const text = el('div', 'opt-text');
        // A picker named the same as its group ("Backdrop" inside
        // Backdrop) is the group: its heading is not repeated, only its
        // one line of hint under the summary.
        if (control.label !== group.label) text.appendChild(el('strong', null, control.label));
        text.appendChild(el('span', null, ok ? control.hint : why));
        block.append(text, buildSwatches(control, values, onChange, !ok, thumbFor, allControls));
        body.appendChild(block);
        continue;
      }
      // A control this host cannot honour is not a dead widget in the
      // list; the group ends with one line naming what else the command
      // line offers, so a phone is not scrolling past greyed switches.
      if (!ok) { elsewhere.push({ label: control.label, why }); continue; }
      const row = el('div', `opt${control.type === 'text' ? ' opt-stack' : ''}`);

      const text = el('div', 'opt-text');
      const hint = ok
        ? [control.hint, onServer ? 'Runs on your server' : ''].filter(Boolean).join(' \u00b7 ')
        : why;
      text.append(el('strong', null, control.label), el('span', null, hint));
      row.appendChild(text);

      const value = values[control.key] ?? control.default;
      const change = (v, live = false) => onChange(control.key, v, live);

      let widget;
      if (control.type === 'toggle') widget = buildToggle(control, value, change, !ok);
      else if (control.type === 'select') widget = buildSelect(control, value, change, !ok);
      else if (control.type === 'range') widget = buildRange(control, value, change, !ok);
      else if (control.type === 'file') widget = buildFile(control, value, change, !ok);
      else if (control.type === 'text') widget = buildText(control, value, change, !ok);
      else widget = el('span', 'dim xs', control.type);

      row.appendChild(widget);
      body.appendChild(row);
    }
    if (elsewhere.length) {
      const row = el('div', 'opt opt-more');
      const text = el('div', 'opt-text');
      const whys = new Set(elsewhere.map((e) => e.why));
      const names = whys.size === 1
        ? elsewhere.map((e) => e.label).join(' \u00b7 ')
        : elsewhere.map((e) => `${e.label} (${e.why.replace(/\.$/, '')})`).join(' \u00b7 ');
      const heading = whys.size === 1 && /command line/i.test(elsewhere[0].why) ? 'Also on the command line'
        : whys.size === 1 ? 'Not on this host' : 'Elsewhere';
      text.append(el('strong', null, heading), el('span', null, whys.size === 1 && /command line/i.test(elsewhere[0].why) ? names : `${names}`));
      row.appendChild(text);
      body.appendChild(row);
    }
    host.appendChild(section);
  }
}

/* One-tap looks (spec controls.looks): a chip per look, pressed when
 * every value it sets is the current one. Applying one hands its
 * values to `onApply`; the same values `--look NAME` sets on the CLI. */
export function looks() { return get('controls', 'looks') || []; }

export function activeLook(values) {
  return looks().find((lk) => Object.entries(lk.values).every(([k, v]) => values[k] === v))?.id || null;
}

export function renderLooks(host, values, onApply, { tileFor = null } = {}) {
  host.innerHTML = '';
  const active = activeLook(values);
  for (const lk of looks()) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(lk.id === active));
    // A tile the core composes with the look's values on the preview's
    // own subject, so choosing a look is choosing a picture.
    const art = tileFor?.(lk, values);
    if (art) { art.className = 'chip-art'; chip.classList.add('has-art'); chip.appendChild(art); }
    const text = el('span', 'chip-text');
    text.append(el('strong', null, lk.label), el('span', null, lk.hint));
    chip.appendChild(text);
    chip.onclick = () => onApply(lk);
    host.appendChild(chip);
  }
}

/* Which groups change the still, for anything that wants to know
 * whether an edit should redraw a preview. */
export function affectsPreview(key) {
  for (const group of get('controls', 'groups')) {
    if (group.controls.some((c) => c.key === key)) return group.affects === 'still';
  }
  return false;
}

/* Defaults for every control, so a fresh install starts where the spec
 * says rather than where JavaScript happens to. */
export function controlDefaults() {
  const out = {};
  for (const group of get('controls', 'groups')) {
    for (const control of group.controls) out[control.key] = control.default;
  }
  return out;
}

/* The CLI invocation these values correspond to, built from the same
 * definitions. A control with no flag cannot appear here, which is what
 * makes the echo trustworthy rather than a hand-maintained string. */
export function controlsToFlags(values) {
  const flags = [];
  for (const group of get('controls', 'groups')) {
    for (const control of group.controls) {
      const value = values[control.key];
      if (value === undefined || value === null) continue;
      // A hidden control is not in effect, so its flag must not be
      // echoed either: --background with no stock backdrop chosen would
      // switch the CLI to a photo the UI is not showing.
      if (!shownBy(control, values)) continue;
      // A hidden select is voiced by the swatch that set it.
      if (control.presentation === 'hidden' && control.type === 'select') continue;
      const isDefault = value === control.default;

      if (control.type === 'select' && !control.cli) {
        // The flag lives on the choice: a select whose options are not
        // all expressible on the CLI carries a flag only where one exists.
        // An expanded choice names its asset (--border NAME); a file
        // choice's flag is echoed by its file control instead.
        const choice = choicesFor(control).find((c) => String(c.value) === String(value)
          && (!c.sets || Object.entries(c.sets).every(([k, v]) => String(values[k]) === String(v))));
        if (choice?.file) continue;
        // A choice's flag may carry its value (--frame-style line).
        if (choice?.cli) flags.push(choice.cliValue ? `${choice.cli} ${choice.cliValue}` : choice.cli);
        if (choice?.asset && choice.cliNamed) flags.push(`${choice.cliNamed} "${choice.asset}"`);
      } else if (control.type === 'file') {
        // A chosen image has no path here; the echo names the file so
        // the command reads as what to run with it on disk.
        if (value && control.cli) flags.push(`${control.cli} "${value.name || 'image.png'}"`);
      } else if (control.type === 'toggle') {
        // An inverted flag (--no-glow) is emitted when the value is OFF;
        // a plain flag when it is ON.
        if (control.cliInvert && !value) flags.push(control.cli);
        else if (!control.cliInvert && value) flags.push(control.cli);
      } else if (!isDefault && control.cli) {
        // Quote anything with a space, or the echo is not pasteable:
        // --border Generic Dealer Frame reads as three arguments.
        const text = String(value);
        flags.push(`${control.cli} ${/\s/.test(text) ? `"${text}"` : text}`);
      }
    }
  }
  return flags;
}
