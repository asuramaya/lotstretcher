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

function choicesFor(control) {
  if (!control.dynamic) return control.choices || [];
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

/* `showWhen` is either a key (shown while that value is truthy) or
 * { key, equals } (shown while that value matches). The second form is
 * what lets a dependent select follow one choice of another select, as
 * the background picker follows "Stock background". */
export function shownBy(control, values) {
  const cond = control.showWhen;
  if (!cond) return true;
  if (typeof cond === 'string') return !!values[cond];
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
  input.oninput = () => { out.textContent = formatValue(control, Number(input.value)); };
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
export function renderControls(host, values, onChange) {
  host.innerHTML = '';

  for (const group of get('controls', 'groups')) {
    const visible = group.controls.filter((c) => shownBy(c, values));
    if (!visible.length) continue;

    const usable = visible.some((c) => availability(c).ok);
    const section = el('details', 'ctrl-group');
    section.open = openState.has(group.id) ? openState.get(group.id) : usable;
    section.ontoggle = () => openState.set(group.id, section.open);
    const summary = el('summary');
    summary.appendChild(el('span', 'ctrl-group-head', group.label));
    const [text, cls] = BADGES[group.affects] || ['', ''];
    if (!usable) summary.appendChild(el('span', 'ctrl-badge is-server', isSelfHosted() ? 'Host lacks it' : 'Needs your server'));
    else if (text) summary.appendChild(el('span', `ctrl-badge ${cls}`, text));
    section.appendChild(summary);
    const body = el('div', 'ctrl-group-body');
    section.appendChild(body);

    for (const control of visible) {
      const { ok, why, onServer } = availability(control);
      const row = el('div', `opt${ok ? '' : ' is-locked'}`);

      const text = el('div', 'opt-text');
      const hint = ok
        ? [control.hint, onServer ? 'Runs on your server' : ''].filter(Boolean).join(' \u00b7 ')
        : why;
      text.append(el('strong', null, control.label), el('span', null, hint));
      row.appendChild(text);

      const value = values[control.key] ?? control.default;
      const change = (v) => onChange(control.key, v);

      let widget;
      if (control.type === 'toggle') widget = buildToggle(control, value, change, !ok);
      else if (control.type === 'select') widget = buildSelect(control, value, change, !ok);
      else if (control.type === 'range') widget = buildRange(control, value, change, !ok);
      else if (control.type === 'file') widget = buildFile(control, value, change, !ok);
      else widget = el('span', 'dim xs', control.type);

      row.appendChild(widget);
      body.appendChild(row);
    }
    host.appendChild(section);
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
      const isDefault = value === control.default;

      if (control.type === 'select' && !control.cli) {
        // The flag lives on the choice: a select whose options are not
        // all expressible on the CLI carries a flag only where one exists.
        const choice = chosen(control, value);
        if (choice?.cli) flags.push(choice.cli);
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
