/* The Library pane: browse what the pipeline has produced.
 *
 * Reads a listings library through a source (see source.js) and shows
 * it: a filterable grid of vehicles, and for each one its finished
 * output, the hero stills, the framed set, the interior set, the clips,
 * the three posts, and the record they were built from.
 *
 * Nothing here knows whether the folder is on a server or on this
 * device, and nothing here is edition-aware. What a self-hosted install
 * adds (a library that is simply there, sync, reruns) it adds by
 * offering a source and capabilities, not by a different pane. */

import { get } from '../spec.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return String(v);
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function miles(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `${n.toLocaleString('en-US')} mi` : null;
}

function titleOf(card, folder) {
  return card.title || [card.year, card.make, card.model, card.trim].filter(Boolean).join(' ') || folder;
}

export class LibraryView {
  /* `ops` is the server's management surface (lib/delegate.js::libraryOps)
   * or null: rebuild in place, sync, job status. `getOptions` supplies
   * the app's current control values for a rebuild. Neither exists on
   * the edge site, and the pane simply has less to offer there. */
  constructor(host, { onLoadVehicle, ops = null, getOptions = null } = {}) {
    this.host = host;
    this.onLoadVehicle = onLoadVehicle;
    this.ops = ops;
    this.getOptions = getOptions;
    this.status = null;
    this.source = null;
    this.index = null;
    this.bucket = 'all';
    this.query = '';
    this.open = null;
    this.render();
  }

  async setSource(source) {
    if (this.source?.release) this.source.release();
    this.source = source;
    this.index = null;
    this.open = null;
    this.error = null;
    this.render();
    try {
      this.index = await source.index();
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.render();
    if (this.ops && source.kind === 'server') this.refreshStatus();
  }

  async refreshStatus() {
    try {
      this.status = await this.ops.status();
    } catch (e) {
      this.status = { error: String(e.message || e) };
    }
    if (!this.open) this.render();
  }

  /* Re-read the index after a rebuild, keeping the open vehicle open. */
  async reload() {
    const openFolder = this.open?.folder;
    try {
      this.index = await this.source.index();
    } catch (e) {
      this.error = String(e.message || e);
    }
    if (openFolder) this.open = this.index?.vehicles.find((v) => v.folder === openFolder) || null;
    this.render();
  }

  /* The management strip: what the sync last did, and the way to run
   * one. Only against a server; a folder on disk has no history to
   * show and nothing that could run. */
  renderStatus() {
    const s = this.status;
    if (!s) return null;
    const box = el('div', 'lib-status');
    if (s.error) { box.appendChild(el('span', 'small muted', `Status unavailable: ${s.error}`)); return box; }

    const facts = [];
    const last = s.lastRun;
    if (last?.run_at) {
      const n = Array.isArray(last.results) ? last.results.length : null;
      facts.push(`Last run ${new Date(last.run_at).toLocaleString()}${n !== null ? `, ${n} vehicle${n === 1 ? '' : 's'}` : ''}`);
    } else {
      facts.push('No run recorded yet');
    }
    facts.push(`${s.fetched} fetched`);
    if (s.delisted) facts.push(`${s.delisted} delisted`);
    box.appendChild(el('span', 'small muted grow', facts.join(' · ')));

    const running = (s.jobs || []).filter((j) => j.status === 'running');
    for (const j of running) {
      box.appendChild(el('span', 'pill pill-ok', `${j.kind}: ${j.target.split('/').pop()}`));
    }

    const sync = el('button', 'btn btn-sm', running.some((j) => j.kind === 'sync') ? 'Syncing...' : 'Sync now');
    sync.disabled = !s.syncConfigured || running.some((j) => j.kind === 'sync');
    sync.title = s.syncConfigured
      ? 'Run one inventory sync into this library, as inventory-sync would'
      : 'No inventory URL configured on the server (dealer config inventory_url)';
    sync.onclick = async () => {
      sync.disabled = true;
      try {
        const job = await this.ops.sync();
        this.refreshStatus();
        await this.ops.wait(job.id, () => {}, 5000);
        await this.reload();
      } catch (e) {
        this.error = String(e.message || e);
        this.render();
      }
      this.refreshStatus();
    };
    box.appendChild(sync);
    return box;
  }

  get vehicles() {
    if (!this.index) return [];
    const q = this.query.trim().toLowerCase();
    return this.index.vehicles.filter((v) => {
      if (this.bucket !== 'all' && v.bucket !== this.bucket) return false;
      if (!q) return true;
      const hay = [titleOf(v.card, v.folder), v.card.vin, v.card.stock_number, v.card.exterior_color_factory, v.folder]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  render() {
    const h = this.host;
    h.innerHTML = '';
    if (this.open) { this.renderDetail(); return; }

    const head = el('div', 'section-head');
    head.append(el('h2', null, 'Library'));
    if (this.index) head.append(el('span', 'pill', String(this.vehicles.length)));
    h.appendChild(head);

    // Where it is being read from, and the way to choose otherwise.
    const srcRow = el('div', 'row wrap', null);
    srcRow.style.gap = 'var(--s-3)';
    srcRow.style.marginBottom = 'var(--s-4)';
    const label = this.source
      ? `${this.source.kind === 'server' ? 'Served by your server from' : 'Folder'} ${this.source.label}`
      : 'No library open.';
    srcRow.append(el('span', 'small muted grow', label));
    const pick = el('button', 'btn btn-sm', this.source ? 'Open another folder' : 'Open a listings folder');
    pick.onclick = () => this.onPick?.();
    srcRow.appendChild(pick);
    h.appendChild(srcRow);

    if (this.error) {
      h.appendChild(el('div', 'banner banner-err', this.error));
      return;
    }
    if (!this.source) {
      h.appendChild(el('p', 'small muted',
        'A listings folder is what the pipeline writes: new/ and used/, one folder per '
        + 'vehicle, each with its finished bundle. Open one to browse it here. On your own '
        + 'server the configured library is opened for you.'));
      return;
    }
    if (!this.index) {
      h.appendChild(el('p', 'small muted', 'Reading the library...'));
      return;
    }

    const status = this.renderStatus();
    if (status) h.appendChild(status);

    // Filters: bucket chips and a search box.
    const bar = el('div', 'row wrap', null);
    bar.style.gap = 'var(--s-2)';
    bar.style.marginBottom = 'var(--s-4)';
    const counts = { all: this.index.vehicles.length };
    for (const v of this.index.vehicles) counts[v.bucket] = (counts[v.bucket] || 0) + 1;
    for (const b of ['all', ...this.index.buckets]) {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', this.bucket === b ? 'true' : 'false');
      chip.append(el('strong', null, b === 'all' ? 'All' : b[0].toUpperCase() + b.slice(1)),
        el('span', null, String(counts[b] || 0)));
      chip.onclick = () => { this.bucket = b; this.render(); };
      bar.appendChild(chip);
    }
    const search = el('input', 'field');
    search.type = 'search';
    search.placeholder = 'Search title, VIN, stock, colour';
    search.value = this.query;
    search.style.flex = '1 1 180px';
    search.oninput = () => { this.query = search.value; this.renderGrid(); };
    bar.appendChild(search);
    h.appendChild(bar);

    this.grid = el('div', 'grid lib-grid');
    h.appendChild(this.grid);
    this.renderGrid();
  }

  renderGrid() {
    const layout = get('library');
    const grid = this.grid;
    grid.innerHTML = '';
    const list = this.vehicles;
    if (!list.length) {
      grid.appendChild(el('p', 'small muted', 'Nothing matches.'));
      return;
    }
    for (const v of list) {
      const card = el('div', 'lib-card');
      const tile = el('div', 'tile');
      const heroRel = `${layout.bundle.dir}/${layout.bundle.hero}`;
      if (v.files.includes(heroRel)) {
        const img = el('img');
        img.loading = 'lazy';
        img.alt = '';
        Promise.resolve(this.source.url(v, heroRel)).then((u) => { img.src = u; });
        tile.appendChild(img);
      } else {
        tile.appendChild(el('div', 'lib-nohero', 'no hero'));
      }
      tile.appendChild(el('span', 'tile-tag', v.bucket));
      card.appendChild(tile);
      const body = el('div', 'lib-card-body');
      body.appendChild(el('strong', 'lib-title', titleOf(v.card, v.folder)));
      const meta = [money(v.card.display_price), miles(v.card.mileage), v.card.exterior_color_factory]
        .filter(Boolean).join(' · ');
      body.appendChild(el('span', 'xs dim', meta || v.card.stock_number || v.card.vin || ''));
      card.appendChild(body);
      card.onclick = () => { this.open = v; this.render(); };
      grid.appendChild(card);
    }
  }

  async renderDetail() {
    const layout = get('library');
    const v = this.open;
    const h = this.host;
    const src = this.source;

    const head = el('div', 'section-head');
    const back = el('button', 'btn btn-ghost btn-sm', '← Library');
    back.onclick = () => { this.open = null; this.render(); };
    head.append(back, el('h2', null, titleOf(v.card, v.folder)), el('span', 'pill', v.bucket));
    h.appendChild(head);

    const meta = [money(v.card.display_price), miles(v.card.mileage), v.card.exterior_color_factory,
      v.card.stock_number && `Stock #${v.card.stock_number}`, v.card.vin].filter(Boolean).join(' · ');
    h.appendChild(el('p', 'small muted', meta));

    // Actions. Loading the originals into the app is the way to rerun a
    // vehicle with today's options, on either surface.
    const actions = el('div', 'row wrap', null);
    actions.style.gap = 'var(--s-3)';
    actions.style.margin = 'var(--s-4) 0';
    if (v.images.length && this.onLoadVehicle) {
      const load = el('button', 'btn btn-primary btn-sm', `Load ${v.images.length} originals into the app`);
      load.onclick = async () => {
        load.disabled = true;
        load.textContent = 'Loading...';
        try {
          let details = {};
          try { details = await src.json(v, layout.details); } catch { /* thin */ }
          const files = [];
          for (const rel of v.images) files.push(await src.file(v, rel));
          this.onLoadVehicle({ details, files });
        } catch (e) {
          load.textContent = String(e.message || e);
        }
      };
      actions.appendChild(load);
    }
    /* Rebuild in place, with whatever the Options pane says right now.
     * The same rebuild the `recompose` CLI does, without the round trip
     * through the browser: the cutouts never leave the server. */
    if (this.ops && src.kind === 'server') {
      const re = el('button', 'btn btn-sm', 'Recompose on your server with current options');
      const note = el('span', 'small dim');
      re.onclick = async () => {
        re.disabled = true;
        note.textContent = 'Rebuilding...';
        try {
          const job = await this.ops.recompose(v, this.getOptions ? this.getOptions() : {});
          const done = await this.ops.wait(job.id, (j) => { note.textContent = `Rebuilding... ${j.status}`; });
          if (done.status === 'failed') {
            note.textContent = done.error;
            re.disabled = false;
            return;
          }
          const r = done.result || {};
          note.textContent = `${r.hero ? 'hero' : 'no hero'}, ${r.framed} framed${r.interior ? `, ${r.interior} interior` : ''}. Refreshing.`;
          await this.reload();
        } catch (e) {
          note.textContent = String(e.message || e);
          re.disabled = false;
        }
      };
      actions.append(re, note);
    }
    h.appendChild(actions);

    const files = new Set(v.files);
    const b = layout.bundle;

    // Hero stills.
    const stills = [[b.hero, 'Square'], [b.heroPortrait, 'Portrait']]
      .map(([name, label]) => [`${b.dir}/${name}`, label]).filter(([rel]) => files.has(rel));
    if (stills.length) h.appendChild(await this.imageRow('Hero', v, stills));

    for (const [dir, label] of [[b.framed, 'Framed'], [b.interior, 'Interior']]) {
      const prefix = `${b.dir}/${dir}/`;
      const set = v.files.filter((f) => f.startsWith(prefix)).map((rel) => [rel, rel.slice(prefix.length)]);
      if (set.length) h.appendChild(await this.imageRow(label, v, set));
    }

    // Clips.
    const clips = Object.entries(b.videos).map(([fmt, name]) => [`${b.dir}/${name}`, fmt]).filter(([rel]) => files.has(rel));
    if (clips.length) {
      const sec = el('div', 'section');
      sec.appendChild(el('h3', 'ctrl-group-head', 'Video'));
      const row = el('div', 'lib-media-row');
      for (const [rel, fmt] of clips) {
        const wrap = el('div', 'lib-media');
        const video = el('video');
        video.controls = true;
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        Promise.resolve(src.url(v, rel)).then((u) => { video.src = u; });
        wrap.append(video, el('span', 'xs dim', fmt));
        row.appendChild(wrap);
      }
      sec.appendChild(row);
      h.appendChild(sec);
    }

    // Posts, with the same copy buttons the Results pane has.
    const posts = Object.entries(b.posts).map(([platform, name]) => [`${b.dir}/${name}`, platform]).filter(([rel]) => files.has(rel));
    if (posts.length) {
      const sec = el('div', 'section');
      sec.appendChild(el('h3', 'ctrl-group-head', 'Posts'));
      for (const [rel, platform] of posts) {
        const wrap = el('div');
        wrap.style.marginBottom = 'var(--s-4)';
        const row = el('div', 'row');
        row.append(el('strong', 'grow', platform[0].toUpperCase() + platform.slice(1)));
        const box = el('div', 'copybox', 'Loading...');
        const btn = el('button', 'btn btn-sm', 'Copy');
        btn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(box.textContent);
            btn.textContent = 'Copied';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
          } catch { btn.textContent = 'Press and hold to copy'; }
        };
        row.appendChild(btn);
        wrap.append(row, box);
        sec.appendChild(wrap);
        src.text(v, rel).then((t) => { box.textContent = t; }).catch((e) => { box.textContent = String(e); });
      }
      h.appendChild(sec);
    }

    // The record, as written. Sticker and window-sticker links if present.
    const extra = el('div', 'row wrap', null);
    extra.style.gap = 'var(--s-3)';
    if (files.has(layout.sticker.pdf)) {
      const a = el('a', 'btn btn-sm btn-ghost', 'Window sticker PDF');
      a.target = '_blank';
      Promise.resolve(src.url(v, layout.sticker.pdf)).then((u) => { a.href = u; });
      extra.appendChild(a);
    }
    const dj = el('a', 'btn btn-sm btn-ghost', 'details.json');
    dj.target = '_blank';
    Promise.resolve(src.url(v, layout.details)).then((u) => { dj.href = u; });
    extra.appendChild(dj);
    h.appendChild(extra);
  }

  async imageRow(label, v, items) {
    const sec = el('div', 'section');
    sec.appendChild(el('h3', 'ctrl-group-head', label));
    const row = el('div', 'lib-media-row');
    for (const [rel, caption] of items) {
      const wrap = el('a', 'lib-media');
      wrap.target = '_blank';
      const img = el('img');
      img.loading = 'lazy';
      img.alt = caption;
      Promise.resolve(this.source.url(v, rel)).then((u) => { img.src = u; wrap.href = u; });
      wrap.append(img, el('span', 'xs dim', caption));
      row.appendChild(wrap);
    }
    sec.appendChild(row);
    return sec;
  }
}
