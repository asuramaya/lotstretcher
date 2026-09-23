/* The studio's widgets, one module: every lever the Studio draws is
 * built here (a toggle, a select, a line of text, a colour, a slider
 * with Auto, a segment row, the place grid, colour dots, a file, a
 * chip, a plain segment) so a control and the stage bar are the same
 * pieces, not bespoke copies. Nothing here knows the spec: a builder
 * takes a control-shaped object and the choices it should offer. */

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export function buildToggle(control, value, onChange, disabled) {
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

export function buildSelect(control, value, onChange, disabled, choices = control.choices || [], locked = () => null) {
  const sel = document.createElement('select');
  sel.className = 'field';
  sel.disabled = disabled;
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
    const why = locked(c);
    if (why) {
      o.disabled = true;
      o.textContent += ` (${why})`;
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
export function buildText(control, value, onChange, disabled, placeholder = null) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.value = value ?? '';
  input.placeholder = placeholder || control.placeholder || '';
  input.maxLength = control.maxLength || 80;
  input.disabled = disabled;
  input.setAttribute('aria-label', control.label);
  input.oninput = () => onChange(input.value, true);
  input.onchange = () => onChange(input.value);
  return input;
}

/* A colour of the user's own, or none: the picker is the platform's,
 * and "Paint" hands the choice back to the vehicle (null). Dragging in
 * the picker is live, closing it commits, as a slider does. */
export function buildColor(control, value, onChange, disabled) {
  const wrap = el('div', 'color-wrap');
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'color-input';
  input.value = value || '#4a6fa5';
  input.disabled = disabled;
  input.setAttribute('aria-label', control.label);
  if (!value) wrap.classList.add('is-auto');
  input.oninput = () => { wrap.classList.remove('is-auto'); onChange(input.value, true); };
  input.onchange = () => onChange(input.value);
  const word = el('span', 'color-word', value ? value.toUpperCase() : (control.auto || 'Auto'));
  const clear = el('button', 'btn btn-ghost btn-sm', control.auto || 'Auto');
  clear.type = 'button';
  clear.title = control.auto ? "Back to the vehicle's own paint" : 'Computed';
  clear.hidden = !value;
  clear.disabled = disabled;
  clear.onclick = () => onChange(null);
  wrap.append(input, word, clear);
  return wrap;
}

/* A slider reports every movement as a LIVE change (the preview follows
 * the thumb) and the final value on release as a real one; re-rendering
 * the pane on every movement would rebuild the very slider being
 * dragged. */
export function buildRange(control, value, onChange, disabled) {
  const wrap = el('div', 'range-wrap');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = control.min;
  input.max = control.max;
  input.step = control.step;
  // A nullable lever (an angle that is seeded unless set) reads Auto
  // at null; moving the slider sets it, the Auto button clears it.
  const isAuto = control.nullable && (value === null || value === undefined);
  input.value = isAuto ? control.min : value;
  input.disabled = disabled;
  input.setAttribute('aria-label', control.label);
  const out = el('span', 'range-out', isAuto ? 'Auto' : formatValue(control, value));
  input.oninput = () => {
    out.textContent = formatValue(control, Number(input.value));
    wrap.classList.remove('is-auto');
    onChange(Number(input.value), true);
  };
  input.onchange = () => onChange(Number(input.value));
  wrap.append(input, out);
  if (control.nullable) {
    if (isAuto) wrap.classList.add('is-auto');
    const auto = el('button', 'btn btn-ghost btn-sm', 'Auto');
    auto.type = 'button';
    auto.hidden = isAuto;
    auto.onclick = () => onChange(null);
    wrap.appendChild(auto);
  }
  return wrap;
}

/* A select's choices as one segment row: the compact form a
 * configurator wants for its style (Paint | Bands | Sweep ...). */
export function buildSegment(control, values, onChange, disabled, choices, locked = () => null) {
  const seg = el('div', 'segment seg-wrap');
  seg.setAttribute('role', 'radiogroup');
  const current = values[control.key] ?? control.default;
  for (const choice of choices) {
    const b = el('button', 'seg', choice.label ?? String(choice.value));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(String(current) === String(choice.value)));
    b.title = choice.hint || '';
    b.disabled = disabled || !!locked(choice);
    b.onclick = () => {
      if (choice.sets) for (const [k, v] of Object.entries(choice.sets)) onChange(k, v, true);
      onChange(control.key, choice.value);
    };
    seg.appendChild(b);
  }
  return seg;
}

/* The six text positions as a 3x2 grid of cells: where the words go,
 * seen as a place rather than read as a name. */
export function buildPlace(control, value, onChange, disabled) {
  const grid = el('div', 'place');
  for (const pos of ['tl', 'tc', 'tr', 'bl', 'bc', 'br']) {
    const choice = (control.choices || []).find((c) => c.value === pos);
    const b = el('button', 'place-cell');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === pos));
    b.setAttribute('aria-label', choice?.label || pos);
    b.title = choice?.label || pos;
    b.disabled = disabled;
    b.appendChild(el('i'));
    b.onclick = () => onChange(pos);
    grid.appendChild(b);
  }
  return grid;
}

/* A colour lever as a row of dots: the named choices (white, black,
 * the paint) as coloured dots, then the picker dot for a colour of the
 * user's own. `thumbFor` supplies each named dot's colour. */
export function buildDots(control, values, onChange, disabled, thumbFor, choices = control.choices || []) {
  const row = el('div', 'dots');
  const current = values[control.key] ?? control.default;
  for (const choice of choices) {
    const dot = el('button', 'dot');
    dot.type = 'button';
    dot.setAttribute('aria-pressed', String(String(current) === String(choice.value)));
    dot.setAttribute('aria-label', choice.label ?? String(choice.value));
    dot.title = choice.label ?? String(choice.value);
    dot.disabled = disabled;
    const art = thumbFor ? thumbFor(control, choice, values, null) : null;
    if (art && art.color) dot.style.background = art.color;
    else dot.classList.add('is-plain');
    dot.onclick = () => onChange(control.key, choice.value);
    row.appendChild(dot);
  }
  if (control.custom) {
    const isHex = typeof current === 'string' && /^#[0-9a-f]{3,6}$/i.test(current);
    const wrap = el('span', `dot dot-custom${isHex ? '' : ' is-auto'}`);
    wrap.setAttribute('aria-pressed', String(isHex));
    const input = document.createElement('input');
    input.type = 'color';
    input.value = isHex && current.length === 7 ? current : '#4a6fa5';
    input.disabled = disabled;
    input.setAttribute('aria-label', `${control.label}: your own`);
    input.title = isHex ? current.toUpperCase() : 'Your own';
    input.oninput = () => { wrap.classList.remove('is-auto'); onChange(control.key, input.value, true); };
    input.onchange = () => onChange(control.key, input.value);
    wrap.appendChild(input);
    row.appendChild(wrap);
  }
  return row;
}

/* An image of the user's own: a picker, a thumbnail once chosen, and a
 * way to drop it. The value is a canvas (with .sourceBlob and .name),
 * kept in memory and in IndexedDB by the app; it never goes into the
 * options blob, which is JSON. */
export function buildFile(control, value, onChange, disabled) {
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
export function pickImage(fileControl, onPicked) {
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

export function formatValue(control, value) {
  if (control.unit === 's') return `${value}s`;
  if (control.unit === 'px') return `${value}px`;
  if (control.unit === 'fraction') return `${Math.round(value * 100)}%`;
  return String(value);
}

/* A plain segment: `items` are { value, label, hint? }, one pressed. */
export function segment(items, current, onPick, cls = '') {
  const seg = el('div', `segment ${cls}`.trim());
  seg.setAttribute('role', 'tablist');
  for (const it of items) {
    const b = el('button', 'seg', it.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-pressed', String(it.value === current));
    if (it.hint) b.title = it.hint;
    b.dataset.value = it.value;
    b.onclick = () => onPick(it.value);
    seg.appendChild(b);
  }
  return seg;
}

/* A chip with a tick: tap the chip to pick it (onPick), tap the tick to
 * switch it on or off (onTick); `pressed` is the pick, `on` the tick. */
export function chip({ label, sub = null, pressed = false, on = null, onPick = null, onTick = null, tickLabel = '' }) {
  const b = el('button', 'chip');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  if (on !== null) {
    b.classList.add('fmt');
    if (on) b.classList.add('is-on');
    const tick = el('span', 'fmt-check');
    tick.setAttribute('role', 'checkbox');
    tick.setAttribute('aria-checked', String(on));
    if (tickLabel) tick.setAttribute('aria-label', tickLabel);
    tick.title = on ? 'In the run; tap to leave it out' : 'Not made; tap to make it';
    tick.onclick = (e) => { e.stopPropagation(); onTick?.(); };
    b.appendChild(tick);
  }
  const text = el('span', on !== null ? 'fmt-text' : 'chip-text');
  text.appendChild(el('strong', null, label));
  if (sub) text.appendChild(el('span', null, sub));
  b.appendChild(text);
  if (onPick) b.onclick = () => onPick();
  return b;
}
