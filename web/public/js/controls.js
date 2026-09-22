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
  if (!inBrowser && viaServer) {
    /* The host CAN do it, but the app cannot yet ask it to: there is no
     * endpoint for delegating a composition to the server. Saying so is
     * better than either hiding the control or offering one that does
     * nothing. */
    return { ok: false, why: 'Runs on your server. The app cannot hand off to it yet.' };
  }
  return { ok: true, why: null };
}

function choicesFor(control) {
  if (!control.dynamic) return control.choices || [];
  if (control.dynamic === 'glowColors') {
    return Object.keys(get('glow', 'colors')).map((v) => ({ value: v, label: v }));
  }
  // 'borders' and other asset-library lists arrive from the host; until
  // that endpoint exists the control renders with nothing to choose,
  // which is honest: there is no asset library in a browser.
  return [];
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
    o.textContent = 'none available';
    sel.appendChild(o);
    sel.disabled = true;
    return sel;
  }
  for (const c of choices) {
    const o = document.createElement('option');
    o.value = String(c.value);
    o.textContent = c.label ?? String(c.value);
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

function formatValue(control, value) {
  if (control.unit === 's') return `${value}s`;
  if (control.unit === 'px') return `${value}px`;
  if (control.unit === 'fraction') return `${Math.round(value * 100)}%`;
  return String(value);
}

/* Render every group into `host`. `values` is the live options object;
 * `onChange(key, value)` is called on every edit. */
export function renderControls(host, values, onChange) {
  host.innerHTML = '';

  for (const group of get('controls', 'groups')) {
    const visible = group.controls.filter((c) => !c.showWhen || values[c.showWhen]);
    if (!visible.length) continue;

    const section = el('div', 'ctrl-group');
    section.appendChild(el('h3', 'ctrl-group-head', group.label));

    for (const control of visible) {
      const { ok, why } = availability(control);
      const row = el('div', `opt${ok ? '' : ' is-locked'}`);

      const text = el('div', 'opt-text');
      text.append(el('strong', null, control.label),
        el('span', null, ok ? (control.hint || '') : why));
      row.appendChild(text);

      const value = values[control.key] ?? control.default;
      const change = (v) => onChange(control.key, v);

      let widget;
      if (control.type === 'toggle') widget = buildToggle(control, value, change, !ok);
      else if (control.type === 'select') widget = buildSelect(control, value, change, !ok);
      else if (control.type === 'range') widget = buildRange(control, value, change, !ok);
      else widget = el('span', 'dim xs', control.type);

      row.appendChild(widget);
      section.appendChild(row);
    }
    host.appendChild(section);
  }
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
      const isDefault = value === control.default;

      if (control.type === 'toggle') {
        // An inverted flag (--no-glow) is emitted when the value is OFF;
        // a plain flag when it is ON.
        if (control.cliInvert && !value) flags.push(control.cli);
        else if (!control.cliInvert && value) flags.push(control.cli);
      } else if (!isDefault) {
        flags.push(`${control.cli} ${value}`);
      }
    }
  }
  return flags;
}
