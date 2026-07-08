/* Nebula renderer — all views, charts, and interactions. */
'use strict';

const api = window.nebula;

// ------------------------------------------------------------- constants

// Fixed color per category (validated dark-surface categorical palette).
// Color follows the entity: a category keeps its hue regardless of rank.
const CAT_COLORS = {
  'Images': '#3987e5',
  'Video': '#199e70',
  'Audio': '#c98500',
  'Documents': '#008300',
  'Code & Data': '#9085e9',
  'Archives': '#e66767',
  'Apps & System': '#d55181',
  'Other': '#6b7280',
};
const catColor = c => CAT_COLORS[c] || CAT_COLORS.Other;

// Sequential blue ramp (dark → light with magnitude), white text stays legible on every step.
const SIZE_RAMP = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7'];

const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 5a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8l1.2 1.6a1 1 0 0 0 .8.4H19a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V8h4.5L13 3.5Z"/></svg>';
const ICON_REVEAL = '<svg viewBox="0 0 24 24"><path d="M12 5c5 0 9 4.3 10 7-1 2.7-5 7-10 7S3 14.7 2 12c1-2.7 5-7 10-7Zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9Z"/></svg>';

// ------------------------------------------------------------- state

const S = {
  view: 'welcome',
  root: null,
  overview: null,
  storageDir: null,     // current path in storage map
  storageNode: null,
  dupes: null,          // duplicates result (renderer copy)
  dupeSelection: new Set(),
  dupeGroupsShown: 80,
  dupeFilters: { sameName: false, minSize: 0, query: '' },
  dupeExpanded: new Set(),
  dupeStrategy: 'smart',
  largest: { category: null, query: '', rows: [] },
  similar: null,
  photoSelection: new Set(),
  scanning: false,
};

// ------------------------------------------------------------- helpers

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n, dec) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n, i = -1;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = dec != null ? dec : (v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${v.toFixed(d)} ${units[i]}`;
}

function fmtBytesParts(n) {
  const s = fmtBytes(n);
  const m = s.match(/^([\d.,]+)\s*(.+)$/);
  return m ? { num: m[1], unit: m[2] } : { num: s, unit: '' };
}

const fmtNum = n => (n == null ? '—' : n.toLocaleString());

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function extLabel(ext) {
  const e = (ext || '').replace('.', '').toUpperCase();
  return e ? e.slice(0, 4) : 'FILE';
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ------------------------------------------------------------- tooltip

const tooltipEl = $('#tooltip');
function showTooltip(html, x, y) {
  tooltipEl.innerHTML = html;
  tooltipEl.hidden = false;
  moveTooltip(x, y);
}
function moveTooltip(x, y) {
  const r = tooltipEl.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > window.innerWidth - 12) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 12) top = y - r.height - 14;
  tooltipEl.style.left = `${Math.max(8, left)}px`;
  tooltipEl.style.top = `${Math.max(8, top)}px`;
}
function hideTooltip() { tooltipEl.hidden = true; }

// ------------------------------------------------------------- toast & modal

function toast(msg, ok = true, ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-dot ${ok ? 'ok' : 'err'}"></span><span>${esc(msg)}</span>`;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <p>${body}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-m="cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-m="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    root.hidden = false;
    const done = v => { root.hidden = true; root.innerHTML = ''; resolve(v); };
    root.querySelector('[data-m="ok"]').addEventListener('click', () => done(true));
    root.querySelector('[data-m="cancel"]').addEventListener('click', () => done(false));
    root.addEventListener('click', e => { if (e.target === root) done(false); }, { once: true });
  });
}

// ------------------------------------------------------------- navigation

function setView(name) {
  S.view = name;
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${name}`; });
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'dashboard') renderDashboard();
  if (name === 'storage') { if (!S.storageDir) S.storageDir = S.root; loadStorage(S.storageDir); }
  if (name === 'dupes') renderDupes();
  if (name === 'largest') refreshLargest();
  if (name === 'photos') renderPhotos();
  if (name === 'changes') renderChanges();
}

$$('.nav-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

function enableNav() {
  $$('.nav-item').forEach(b => { b.disabled = false; });
}

// ------------------------------------------------------------- scan flow

async function startScan(root) {
  if (S.scanning) return;
  S.scanning = true;
  S.root = root;
  S.storageDir = null;
  S.dupes = null;
  S.dupeSelection = new Set();
  S.similar = null;
  S.photoSelection = new Set();
  $('#dupe-badge').hidden = true;

  setView('scanning');
  $('#scan-target').textContent = root;
  $('#scan-bytes').textContent = '0 B';
  $('#scan-files').textContent = '0';
  $('#scan-dirs').textContent = '0';
  $('#scan-current').textContent = ' ';

  const res = await api.scan(root);
  S.scanning = false;

  if (res && res.error) {
    toast(`Scan failed: ${res.error}`, false);
    setView(S.overview ? 'dashboard' : 'welcome');
    return;
  }

  S.overview = await api.overview();
  enableNav();
  updateRootCard(res);

  if (res.cancelled) toast('Scan cancelled — showing partial results');
  else if (res.errors > 0) toast(`Scan complete. ${fmtNum(res.errors)} items were skipped (no permission).`);
  else toast(`Scanned ${fmtNum(res.fileCount)} files in ${(res.elapsedMs / 1000).toFixed(1)}s`);

  setView('dashboard');
}

api.onScanProgress(p => {
  if (!S.scanning) return;
  $('#scan-bytes').textContent = fmtBytes(p.bytes);
  $('#scan-files').textContent = fmtNum(p.files);
  $('#scan-dirs').textContent = fmtNum(p.dirs);
  if (p.current) $('#scan-current').textContent = p.current;
});

function updateRootCard(res) {
  $('#root-card').hidden = false;
  $('#root-card-name').textContent = res.root || S.root;
  $('#root-card-meta').textContent = `${fmtBytes(res.totalBytes)} · ${fmtNum(res.fileCount)} files`;
}

$('#btn-cancel-scan').addEventListener('click', () => api.cancelScan());
$('#btn-rescan').addEventListener('click', () => { if (S.root) startScan(S.root); });
$('#btn-newscan').addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (p) startScan(p);
});
$('#btn-choose').addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (p) startScan(p);
});

(async function initQuickFolders() {
  const folders = await api.quickFolders();
  $('#quick-row').innerHTML = folders
    .map(f => `<button class="quick-chip" data-path="${esc(f.path)}">${esc(f.label)}</button>`)
    .join('');
  $('#quick-row').addEventListener('click', e => {
    const chip = e.target.closest('.quick-chip');
    if (chip) startScan(chip.dataset.path);
  });
})();

(async function initResume() {
  const info = await api.indexInfo();
  if (!info) return;
  $('#resume-holder').innerHTML = `
    <div class="quick-label">previous session</div>
    <button class="btn btn-ghost" id="btn-resume">⚡ Resume ${esc(info.name || info.root)} — ${esc(fmtBytes(info.totalBytes))} · ${fmtNum(info.fileCount)} files · scanned ${esc(fmtDate(info.savedAt))}</button>`;
  $('#btn-resume').addEventListener('click', async () => {
    const btn = $('#btn-resume');
    btn.disabled = true;
    btn.textContent = 'Restoring index…';
    const res = await api.indexLoad();
    if (res && res.error) {
      toast(`Couldn't restore: ${res.error}`, false);
      btn.disabled = false;
      btn.textContent = 'Resume last session';
      return;
    }
    S.root = res.root;
    S.storageDir = null;
    S.overview = await api.overview();
    enableNav();
    updateRootCard(res);
    toast('Previous scan restored instantly — hit Rescan if the folder changed');
    setView('dashboard');
  });
})();

// ------------------------------------------------------------- dashboard

async function renderDashboard() {
  S.overview = await api.overview();
  const o = S.overview;
  const el = $('#view-dashboard');
  if (!o) { el.innerHTML = '<div class="empty-note">No scan data yet.</div>'; return; }

  const total = fmtBytesParts(o.totalBytes);
  const dupeKpi = o.duplicates
    ? `<div class="kpi-value">${fmtBytesParts(o.duplicates.totalWasted).num}<small>${fmtBytesParts(o.duplicates.totalWasted).unit}</small></div>
       <div class="kpi-sub good">${fmtNum(o.duplicates.groupCount)} duplicate sets found</div>`
    : `<div class="kpi-value">—</div>
       <div class="kpi-sub">Not analyzed yet</div>
       <div class="kpi-action"><button class="btn btn-ghost btn-small" data-action="go-dupes">Analyze now</button></div>`;

  el.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Dashboard</div>
        <div class="view-sub">${esc(o.root)}</div>
      </div>
    </div>

    <div class="kpi-row">
      <div class="kpi">
        <div class="kpi-label">Total size</div>
        <div class="kpi-value">${total.num}<small>${total.unit}</small></div>
        <div class="kpi-sub">across all scanned items</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Files</div>
        <div class="kpi-value">${fmtNum(o.fileCount)}</div>
        <div class="kpi-sub">${fmtNum(o.topExtensions.length ? o.topExtensions[0].count : 0)} of the top type “${esc(o.topExtensions.length ? o.topExtensions[0].ext : '—')}”</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Folders</div>
        <div class="kpi-value">${fmtNum(o.dirCount)}</div>
        <div class="kpi-sub">${fmtNum(o.looseCount)} loose files at top level</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Reclaimable (duplicates)</div>
        ${dupeKpi}
      </div>
    </div>

    <div class="dash-grid">
      <div class="panel">
        <div class="panel-title">Storage by type</div>
        <div class="donut-wrap">
          <div id="donut-holder"></div>
          <div class="legend" id="donut-legend"></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">Top folders <span class="panel-hint">click to explore</span></div>
        <div class="bar-list" id="dash-topdirs"></div>
      </div>
    </div>

    <div class="dash-grid-2">
      <div class="panel">
        <div class="panel-title">Largest files <span class="panel-hint">click to reveal</span></div>
        <div id="dash-largest"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Top extensions</div>
        <div class="bar-list" id="dash-exts"></div>
      </div>
    </div>`;

  buildDonut(o);
  buildTopDirs(o);
  buildDashLargest(o);
  buildTopExts(o);

  el.querySelectorAll('[data-action="go-dupes"]').forEach(b =>
    b.addEventListener('click', () => { setView('dupes'); runDupeAnalysis(); }));
}

function buildDonut(o) {
  const holder = $('#donut-holder');
  const cats = o.categories;
  const totalB = cats.reduce((s, c) => s + c.bytes, 0) || 1;
  const size = 190, cx = size / 2, cy = size / 2, r = 74, sw = 24;

  let svg = `<svg class="donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  if (cats.length === 1) {
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${catColor(cats[0].key)}" stroke-width="${sw}" data-i="0"/>`;
  } else {
    const gap = 0.035; // radians — the 2px spacer between segments
    let a = -Math.PI / 2;
    cats.forEach((c, i) => {
      const frac = c.bytes / totalB;
      const sweep = Math.max(0.008, frac * Math.PI * 2 - gap);
      const a2 = a + sweep;
      const x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a);
      const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      const large = sweep > Math.PI ? 1 : 0;
      svg += `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${catColor(c.key)}" stroke-width="${sw}" data-i="${i}"/>`;
      a = a2 + gap;
    });
  }
  svg += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-center-value">${esc(fmtBytes(totalB))}</text>`;
  svg += `<text x="${cx}" y="${cy + 15}" text-anchor="middle" class="donut-center-label">total</text>`;
  svg += `</svg>`;
  holder.innerHTML = svg;

  $('#donut-legend').innerHTML = cats.map((c, i) => `
    <div class="legend-item" data-i="${i}">
      <span class="legend-chip" style="background:${catColor(c.key)}"></span>
      <span class="legend-name">${esc(c.key)}</span>
      <span class="legend-value">${fmtBytes(c.bytes)}</span>
      <span class="legend-pct">${((c.bytes / totalB) * 100).toFixed(1)}%</span>
    </div>`).join('');

  const svgEl = holder.querySelector('svg');
  const highlight = i => {
    svgEl.querySelectorAll('[data-i]').forEach(p => p.classList.toggle('dim', i != null && p.dataset.i !== String(i)));
  };
  const onOver = e => {
    const t = e.target.closest('[data-i]');
    if (!t) return;
    const c = cats[+t.dataset.i];
    highlight(+t.dataset.i);
    showTooltip(
      `<div class="tt-title">${esc(c.key)}</div>
       <div class="tt-line">${esc(fmtBytes(c.bytes))} · ${fmtNum(c.count)} files · ${((c.bytes / totalB) * 100).toFixed(1)}%</div>`,
      e.clientX, e.clientY);
  };
  svgEl.addEventListener('mousemove', onOver);
  svgEl.addEventListener('mouseleave', () => { highlight(null); hideTooltip(); });
  $('#donut-legend').addEventListener('mousemove', onOver);
  $('#donut-legend').addEventListener('mouseleave', () => { highlight(null); hideTooltip(); });
}

function buildTopDirs(o) {
  const max = Math.max(...o.topDirs.map(d => d.size), o.looseBytes, 1);
  const rows = o.topDirs.map(d => ({ ...d, isDir: true }));
  if (o.looseBytes > 0) rows.push({ name: `(${fmtNum(o.looseCount)} loose files)`, path: null, size: o.looseBytes, isDir: false });
  rows.sort((a, b) => b.size - a.size);

  $('#dash-topdirs').innerHTML = rows.map((d, i) => `
    <div class="bar-row" data-i="${i}" title="${esc(d.path || '')}">
      <div class="bar-row-name">${d.isDir ? ICON_FOLDER : ICON_FILE}<span>${esc(d.name)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${((d.size / max) * 100).toFixed(1)}%"></div></div>
      <div class="bar-row-size">${fmtBytes(d.size)}</div>
    </div>`).join('');

  $('#dash-topdirs').addEventListener('click', e => {
    const row = e.target.closest('.bar-row');
    if (!row) return;
    const d = rows[+row.dataset.i];
    if (d && d.path) { S.storageDir = d.path; setView('storage'); }
  });
}

function buildDashLargest(o) {
  $('#dash-largest').innerHTML = o.largest.map((f, i) => `
    <div class="file-row" data-i="${i}" title="${esc(f.path)}">
      <div class="file-chip" style="background:${catColor(f.category)}">${esc(extLabel(f.ext))}</div>
      <div class="file-row-main">
        <div class="file-row-name">${esc(f.name)}</div>
        <div class="file-row-path">${esc(f.dir)}</div>
      </div>
      <div class="file-row-size">${fmtBytes(f.size)}</div>
    </div>`).join('');
  $('#dash-largest').addEventListener('click', e => {
    const row = e.target.closest('.file-row');
    if (row) api.reveal(o.largest[+row.dataset.i].path);
  });
}

function buildTopExts(o) {
  const max = Math.max(...o.topExtensions.map(x => x.bytes), 1);
  $('#dash-exts').innerHTML = o.topExtensions.map(x => `
    <div class="bar-row" style="cursor:default">
      <div class="bar-row-name"><span>${esc(x.ext)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${((x.bytes / max) * 100).toFixed(1)}%;background:#9085e9"></div></div>
      <div class="bar-row-size">${fmtBytes(x.bytes)}</div>
    </div>`).join('');
}

// ------------------------------------------------------------- storage map

async function loadStorage(dirPath) {
  const node = await api.dirNode(dirPath);
  if (!node) { toast('Folder not found in scan index — rescan may be needed.', false); return; }
  S.storageDir = dirPath;
  S.storageNode = node;
  renderStorage();
}

function crumbsFor(dirPath) {
  const root = S.root;
  const sep = api.platform === 'win32' ? '\\' : '/';
  const crumbs = [{ name: S.overview ? S.overview.name : root, path: root }];
  if (dirPath !== root && dirPath.startsWith(root)) {
    let rel = dirPath.slice(root.length);
    if (rel.startsWith(sep)) rel = rel.slice(1);
    let acc = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      acc = acc + sep + part;
      crumbs.push({ name: part, path: acc });
    }
  }
  return crumbs;
}

function renderStorage() {
  const el = $('#view-storage');
  const node = S.storageNode;
  const crumbs = crumbsFor(node.path);

  el.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Storage Map</div>
        <div class="view-sub">${fmtBytes(node.size)} · ${fmtNum(node.fileCount)} files in this folder tree</div>
      </div>
      <button class="btn btn-ghost btn-small" data-action="reveal-dir">${ICON_REVEAL} Show in ${api.platform === 'darwin' ? 'Finder' : 'Explorer'}</button>
    </div>
    <div class="crumbs">${crumbs.map((c, i) =>
      `<button class="crumb ${i === crumbs.length - 1 ? 'current' : ''}" data-path="${esc(c.path)}">${esc(c.name)}</button>${i < crumbs.length - 1 ? '<span class="crumb-sep">›</span>' : ''}`
    ).join('')}</div>
    <div class="storage-layout">
      <div class="panel" style="padding:12px">
        <div id="treemap"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Contents <span class="panel-hint">${node.truncated ? `top 500 of ${fmtNum(node.truncated + 500)}` : `${node.children.length} items`}</span></div>
        <div class="dir-list" id="dir-list"></div>
      </div>
    </div>`;

  el.querySelector('.crumbs').addEventListener('click', e => {
    const c = e.target.closest('.crumb:not(.current)');
    if (c) loadStorage(c.dataset.path);
  });
  el.querySelector('[data-action="reveal-dir"]').addEventListener('click', () => api.reveal(node.path));

  renderTreemap(node);
  renderDirList(node);
}

// Squarified treemap layout — items must be sorted by value desc.
function squarify(items, width, height) {
  const total = items.reduce((s, it) => s + it.value, 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];
  const scaled = items.map(it => ({ ...it, area: (it.value / total) * width * height }));
  const rects = [];
  let x = 0, y = 0, w = width, h = height;
  let row = [];

  const worst = (r, len) => {
    const s = r.reduce((a, q) => a + q.area, 0);
    let m = 0;
    for (const q of r) m = Math.max(m, Math.max((len * len * q.area) / (s * s), (s * s) / (len * len * q.area)));
    return m;
  };
  const layoutRow = r => {
    const s = r.reduce((a, q) => a + q.area, 0);
    const horiz = w >= h;             // row runs along the shorter side
    const len = horiz ? h : w;
    const thick = s / len;
    let off = 0;
    for (const q of r) {
      const l = q.area / thick;
      if (horiz) rects.push({ ...q, x, y: y + off, w: thick, h: l });
      else rects.push({ ...q, x: x + off, y, w: l, h: thick });
      off += l;
    }
    if (horiz) { x += thick; w -= thick; } else { y += thick; h -= thick; }
  };

  let i = 0;
  while (i < scaled.length) {
    const len = Math.min(w, h);
    if (len <= 0) break;
    const it = scaled[i];
    if (row.length === 0 || worst([...row, it], len) <= worst(row, len)) { row.push(it); i++; }
    else { layoutRow(row); row = []; }
  }
  if (row.length) layoutRow(row);
  return rects;
}

function renderTreemap(node) {
  const holder = $('#treemap');
  const W = holder.clientWidth, H = holder.clientHeight;
  if (!W || !H) return;

  const MAXR = 50;
  let items = node.children.filter(c => c.size > 0).map(c => ({
    value: c.size, name: c.name, path: c.path, isDir: c.isDir,
    fileCount: c.fileCount, category: c.category,
  }));
  if (!items.length) {
    holder.innerHTML = '<div class="empty-note">This folder is empty (or unreadable).</div>';
    return;
  }
  if (items.length > MAXR) {
    const rest = items.slice(MAXR);
    items = items.slice(0, MAXR);
    items.push({
      value: rest.reduce((s, r) => s + r.value, 0),
      name: `+${fmtNum(rest.length)} more`, path: null, isDir: false, isRest: true,
    });
    items.sort((a, b) => b.value - a.value);
  }

  const GAP = 2;
  const maxV = items[0].value;
  const rects = squarify(items, W, H);

  holder.innerHTML = rects.map((r, i) => {
    const w = Math.max(0, r.w - GAP), h = Math.max(0, r.h - GAP);
    if (w < 3 || h < 3) return '';
    let bg;
    if (r.isRest) bg = 'rgba(255,255,255,0.08)';
    else if (r.isDir) bg = SIZE_RAMP[Math.min(SIZE_RAMP.length - 1, Math.round(Math.sqrt(r.value / maxV) * (SIZE_RAMP.length - 1)))];
    else bg = '#3a4152';
    const showText = w > 64 && h > 34;
    return `<div class="tm-rect ${r.isDir ? '' : 'tm-file'}" data-i="${i}"
      style="left:${r.x + GAP / 2}px;top:${r.y + GAP / 2}px;width:${w}px;height:${h}px;background:${bg}">
      ${showText ? `<div class="tm-name">${esc(r.name)}</div><div class="tm-size">${esc(fmtBytes(r.value))}</div>` : ''}
    </div>`;
  }).join('');

  holder.onclick = e => {
    const t = e.target.closest('.tm-rect');
    if (!t) return;
    const r = rects[+t.dataset.i];
    if (r.isDir) loadStorage(r.path);
    else if (r.path) api.reveal(r.path);
  };
  holder.onmousemove = e => {
    const t = e.target.closest('.tm-rect');
    if (!t) { hideTooltip(); return; }
    const r = rects[+t.dataset.i];
    showTooltip(
      `<div class="tt-title">${esc(r.name)}</div>
       <div class="tt-line">${esc(fmtBytes(r.value))}${r.isDir ? ` · ${fmtNum(r.fileCount)} files · click to open` : r.isRest ? '' : ' · click to reveal'}</div>`,
      e.clientX, e.clientY);
  };
  holder.onmouseleave = hideTooltip;
}

new ResizeObserver(debounce(() => {
  if (S.view === 'storage' && S.storageNode) renderTreemap(S.storageNode);
}, 120)).observe(document.getElementById('main'));

function renderDirList(node) {
  const list = $('#dir-list');
  const max = Math.max(...node.children.map(c => c.size), 1);
  list.innerHTML = node.children.map((c, i) => `
    <div class="dir-row ${c.isDir ? 'is-dir' : ''}" data-i="${i}" title="${esc(c.path)}">
      ${c.isDir ? ICON_FOLDER : ICON_FILE}
      <div>
        <div class="dir-row-name">${esc(c.name)}</div>
        ${c.isDir ? `<div class="dir-row-count">${fmtNum(c.fileCount)} files</div>` : ''}
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${((c.size / max) * 100).toFixed(1)}%;${c.isDir ? '' : 'background:#6b7280'}"></div></div>
      <div class="bar-row-size">${fmtBytes(c.size)}</div>
    </div>`).join('') || '<div class="empty-note">Empty folder</div>';

  list.addEventListener('click', e => {
    const row = e.target.closest('.dir-row');
    if (!row) return;
    const c = node.children[+row.dataset.i];
    if (c.isDir) loadStorage(c.path);
    else api.reveal(c.path);
  });
}

// ------------------------------------------------------------- duplicates

function renderDupes() {
  const el = $('#view-dupes');

  if (!S.dupes) {
    el.innerHTML = `
      <div class="view-head"><div>
        <div class="view-title">Duplicates</div>
        <div class="view-sub">Byte-accurate duplicate detection across every file type and size</div>
      </div></div>
      <div class="panel dupe-idle">
        <div class="dupe-idle-icon"><svg viewBox="0 0 24 24"><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2Zm2 0h5a2 2 0 0 1 2 2v5h2V5h-9v2Z"/></svg></div>
        <h3>Find duplicate files</h3>
        <p>Nebula groups files by exact size, fingerprints candidates, then confirms matches with full content hashes — so identical names aren't enough and identical content never escapes.</p>
        <button class="btn btn-primary" id="btn-run-dupes">Analyze ${S.overview ? fmtNum(S.overview.fileCount) + ' files' : 'scan'}</button>
      </div>`;
    $('#btn-run-dupes').addEventListener('click', runDupeAnalysis);
    return;
  }

  const d = S.dupes;
  if (!d.groups.length) {
    el.innerHTML = `
      <div class="view-head"><div>
        <div class="view-title">Duplicates</div>
        <div class="view-sub">${fmtNum(d.scannedFiles)} files analyzed</div>
      </div></div>
      <div class="panel dupe-idle">
        <div class="dupe-idle-icon"><svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg></div>
        <h3>No duplicates found</h3>
        <p>Every file in this folder tree has unique content. Nothing to reclaim.</p>
        <button class="btn btn-ghost" id="btn-rerun-dupes">Re-analyze</button>
      </div>`;
    $('#btn-rerun-dupes').addEventListener('click', runDupeAnalysis);
    return;
  }

  const groups = filteredDupeGroups();
  const wastedFiltered = groups.reduce((s, g) => s + g.wasted, 0);
  const selCount = S.dupeSelection.size;
  const selBytes = selectionBytes();
  const shown = Math.min(S.dupeGroupsShown, groups.length);
  const flt = S.dupeFilters;

  el.innerHTML = `
    <div class="view-head"><div>
      <div class="view-title">Duplicates</div>
      <div class="view-sub">${fmtNum(groups.length)} sets${groups.length !== d.groupCount ? ` (filtered from ${fmtNum(d.groupCount)})` : ''} · <strong style="color:#ff9d9d">${fmtBytes(wastedFiltered)}</strong> reclaimable</div>
    </div></div>

    <div class="dupe-toolbar">
      <label class="dupe-filter"><input type="checkbox" id="flt-samename" ${flt.sameName ? 'checked' : ''}> Same name only</label>
      <select class="select" id="flt-minsize">
        <option value="0" ${!flt.minSize ? 'selected' : ''}>Any size</option>
        <option value="1048576" ${flt.minSize === 1048576 ? 'selected' : ''}>≥ 1 MB</option>
        <option value="10485760" ${flt.minSize === 10485760 ? 'selected' : ''}>≥ 10 MB</option>
        <option value="104857600" ${flt.minSize === 104857600 ? 'selected' : ''}>≥ 100 MB</option>
      </select>
      <input class="search-input" id="flt-query" style="margin-left:0;min-width:170px" type="text" placeholder="Filter by name or path…" value="${esc(flt.query)}">
      <div class="dupe-toolbar-spacer"></div>
      <div class="dupe-toolbar-info"><strong>${fmtNum(selCount)}</strong> selected · <strong>${fmtBytes(selBytes)}</strong></div>
      <select class="select" id="sel-strategy" title="Which copy to keep when auto-selecting">
        <option value="smart" ${S.dupeStrategy === 'smart' ? 'selected' : ''}>Smart (location + name)</option>
        <option value="newest" ${S.dupeStrategy === 'newest' ? 'selected' : ''}>Keep newest</option>
        <option value="oldest" ${S.dupeStrategy === 'oldest' ? 'selected' : ''}>Keep oldest</option>
      </select>
      <button class="btn btn-ghost btn-small" id="btn-auto-select">Auto-select</button>
      <button class="btn btn-ghost btn-small" id="btn-clear-select" ${selCount ? '' : 'disabled'}>Clear</button>
      <button class="btn btn-danger" id="btn-trash-selected" ${selCount ? '' : 'disabled'}>${ICON_TRASH} Move ${selCount ? fmtNum(selCount) + ' files' : ''} to Trash</button>
    </div>

    <div id="dupe-groups">${groups.slice(0, shown).map(dupeGroupHtml).join('') || '<div class="empty-note">No duplicate sets match these filters.</div>'}</div>
    ${groups.length > shown ? `<div style="text-align:center;padding:14px"><button class="btn btn-ghost" id="btn-more-groups">Show ${Math.min(80, groups.length - shown)} more sets</button></div>` : ''}`;

  $('#flt-samename').addEventListener('change', e => { S.dupeFilters.sameName = e.target.checked; renderDupes(); });
  $('#flt-minsize').addEventListener('change', e => { S.dupeFilters.minSize = +e.target.value; renderDupes(); });
  $('#flt-query').addEventListener('input', debounce(e => {
    S.dupeFilters.query = e.target.value;
    renderDupes();
    const q = $('#flt-query');
    if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }, 300));

  $('#sel-strategy').addEventListener('change', e => { S.dupeStrategy = e.target.value; });
  $('#btn-auto-select').addEventListener('click', () => {
    for (const g of groups) {
      let keep = 0; // files are sorted newest-first
      if (S.dupeStrategy === 'oldest') keep = g.files.length - 1;
      else if (S.dupeStrategy === 'smart') keep = smartKeepIndex(g);
      g.files.forEach((f, i) => {
        if (i === keep) S.dupeSelection.delete(f.path);
        else S.dupeSelection.add(f.path);
      });
    }
    renderDupes();
  });
  $('#btn-clear-select').addEventListener('click', () => { S.dupeSelection.clear(); renderDupes(); });
  $('#btn-trash-selected').addEventListener('click', trashSelectedDupes);
  const more = $('#btn-more-groups');
  if (more) more.addEventListener('click', () => { S.dupeGroupsShown += 80; renderDupes(); });

  $('#dupe-groups').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    if (cb.checked) S.dupeSelection.add(cb.dataset.path);
    else S.dupeSelection.delete(cb.dataset.path);
    updateDupeToolbar();
  });
  $('#dupe-groups').addEventListener('click', e => {
    const ex = e.target.closest('[data-expand]');
    if (ex) { S.dupeExpanded.add(+ex.dataset.expand); renderDupes(); return; }
    const col = e.target.closest('[data-collapse]');
    if (col) { S.dupeExpanded.delete(+col.dataset.collapse); renderDupes(); return; }
    const p = e.target.closest('.dupe-file-path');
    if (p) api.reveal(p.dataset.path);
  });
}

// Score each copy in a group; the highest-scoring copy is the one to KEEP.
// Prefers organized locations (Pictures, Documents…) and clean names, penalizes
// Downloads/temp locations and "copy of…" / "(1)" style names. Newest wins ties.
function smartKeepIndex(g) {
  const sep = api.platform === 'win32' ? '\\' : '/';
  const newestMtime = Math.max(...g.files.map(f => f.mtime || 0));
  const shortestName = Math.min(...g.files.map(f => f.name.length));
  let best = 0, bestScore = -Infinity;
  g.files.forEach((f, i) => {
    let s = 0;
    const dirParts = f.dir.toLowerCase().split(sep);
    if (dirParts.includes('downloads')) s -= 20;
    if (dirParts.includes('desktop')) s -= 8;
    if (dirParts.some(p => ['tmp', 'temp', 'cache', 'caches', '.trash', 'trash'].includes(p))) s -= 30;
    if (dirParts.some(p => p.includes('backup') || p === 'old')) s -= 15;
    if (dirParts.includes('pictures') || dirParts.includes('photos')) s += 15;
    if (dirParts.includes('documents')) s += 12;
    if (dirParts.includes('music') || dirParts.includes('movies') || dirParts.includes('videos')) s += 12;
    const nm = f.name.toLowerCase();
    if (/( copy| - copy)(\.| \(|$)/.test(nm) || nm.startsWith('copy of ')) s -= 25;
    if (/\(\d+\)(\.[^.]+)?$/.test(nm) || / \d+(\.[^.]+)?$/.test(nm)) s -= 15;
    if (/backup|_old\b|\bold[_\- ]/.test(nm)) s -= 15;
    if (nm.startsWith('~') || nm.startsWith('.')) s -= 10;
    if (f.name.length === shortestName) s += 6;    // "IMG.jpg" beats "IMG (1).jpg"
    if ((f.mtime || 0) === newestMtime) s += 3;    // newest as tie-break
    s += Math.max(0, 6 - dirParts.length) * 0.5;   // slightly prefer shallower, organized paths
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

function filteredDupeGroups() {
  if (!S.dupes) return [];
  const { sameName, minSize, query } = S.dupeFilters;
  const q = query.trim().toLowerCase();
  return S.dupes.groups.filter(g => {
    if (minSize && g.size < minSize) return false;
    if (sameName && new Set(g.files.map(f => f.name.toLowerCase())).size !== 1) return false;
    if (q && !g.files.some(f => f.path.toLowerCase().includes(q))) return false;
    return true;
  });
}

const GROUP_ROW_CAP = 8;

function dupeGroupHtml(g) {
  const names = new Set(g.files.map(f => f.name.toLowerCase()));
  const title = names.size === 1
    ? esc(g.files[0].name)
    : `${esc(g.files[0].name)} <span style="color:var(--text-muted);font-weight:500">+ ${fmtNum(names.size - 1)} other name${names.size > 2 ? 's' : ''}, identical content</span>`;
  const expanded = S.dupeExpanded.has(g.id);
  const rows = expanded ? g.files : g.files.slice(0, GROUP_ROW_CAP);
  const hiddenCount = g.files.length - rows.length;
  return `
    <div class="panel dupe-group">
      <div class="dupe-group-head">
        <div class="file-chip" style="background:${catColor(g.category)}">${esc(extLabel(g.ext))}</div>
        <div class="dupe-group-title">${title}</div>
        <span class="badge ${g.verified ? 'badge-verified' : 'badge-sampled'}">${g.verified ? 'content verified' : 'sampled match'}</span>
        <div class="dupe-group-meta">${fmtNum(g.count)} × ${fmtBytes(g.size)}</div>
        <div class="dupe-wasted">wastes ${fmtBytes(g.wasted)}</div>
      </div>
      ${rows.map((f, i) => `
        <div class="dupe-file">
          <input type="checkbox" data-path="${esc(f.path)}" ${S.dupeSelection.has(f.path) ? 'checked' : ''}>
          <div class="dupe-file-name">${esc(f.name)}</div>
          ${i === 0 ? '<span class="tag-newest">newest</span>' : ''}
          <div class="dupe-file-path" data-path="${esc(f.path)}" title="Reveal">${esc(f.dir)}</div>
          <div class="dupe-file-date">${fmtDate(f.mtime)}</div>
        </div>`).join('')}
      ${hiddenCount > 0
        ? `<div class="dupe-expand"><button class="btn btn-ghost btn-small" data-expand="${g.id}">Show all ${fmtNum(g.files.length)} copies</button></div>`
        : (expanded && g.files.length > GROUP_ROW_CAP
          ? `<div class="dupe-expand"><button class="btn btn-ghost btn-small" data-collapse="${g.id}">Collapse</button></div>`
          : '')}
    </div>`;
}

function selectionBytes() {
  if (!S.dupes) return 0;
  let bytes = 0;
  for (const g of S.dupes.groups)
    for (const f of g.files)
      if (S.dupeSelection.has(f.path)) bytes += g.size;
  return bytes;
}

function updateDupeToolbar() {
  const info = document.querySelector('.dupe-toolbar-info');
  if (info) info.innerHTML = `<strong>${fmtNum(S.dupeSelection.size)}</strong> selected · <strong>${fmtBytes(selectionBytes())}</strong>`;
  const trashBtn = $('#btn-trash-selected');
  const clearBtn = $('#btn-clear-select');
  if (trashBtn) {
    trashBtn.disabled = !S.dupeSelection.size;
    trashBtn.innerHTML = `${ICON_TRASH} Move ${S.dupeSelection.size ? fmtNum(S.dupeSelection.size) + ' files' : ''} to Trash`;
  }
  if (clearBtn) clearBtn.disabled = !S.dupeSelection.size;
}

async function runDupeAnalysis() {
  const el = $('#view-dupes');
  el.innerHTML = `
    <div class="view-head"><div>
      <div class="view-title">Duplicates</div>
      <div class="view-sub">Analyzing content…</div>
    </div></div>
    <div class="dupe-progress">
      <div class="dupe-progress-label" id="dupe-phase">Grouping by size…</div>
      <div class="progress-track"><div class="progress-fill" id="dupe-fill" style="width:2%"></div></div>
      <button class="btn btn-ghost" id="btn-cancel-dupes">Cancel</button>
    </div>`;
  $('#btn-cancel-dupes').addEventListener('click', () => api.cancelDupes());

  const res = await api.findDuplicates();
  if (res && res.error) { toast(res.error, false); S.dupes = null; renderDupes(); return; }
  if (res && res.cancelled) { toast('Duplicate analysis cancelled'); S.dupes = null; renderDupes(); return; }

  S.dupes = res;
  S.dupeSelection = new Set();
  S.dupeGroupsShown = 80;

  const badge = $('#dupe-badge');
  if (res.groupCount > 0) { badge.textContent = fmtNum(res.groupCount); badge.hidden = false; }
  else badge.hidden = true;

  renderDupes();
}

api.onDupeProgress(p => {
  const phase = $('#dupe-phase'), fill = $('#dupe-fill');
  if (!phase || !fill) return;
  const pct = p.total ? (p.done / p.total) * 100 : 100;
  if (p.phase === 'quick') {
    phase.textContent = `Pass 1 of 2 — fingerprinting ${fmtNum(p.total)} candidates (${fmtNum(p.done)} done)`;
    fill.style.width = `${(pct * 0.45).toFixed(1)}%`;
  } else {
    phase.textContent = `Pass 2 of 2 — verifying content of ${fmtNum(p.total)} files (${fmtNum(p.done)} done)`;
    fill.style.width = `${(45 + pct * 0.55).toFixed(1)}%`;
  }
});

async function trashSelectedDupes() {
  const paths = [...S.dupeSelection];
  if (!paths.length) return;
  const ok = await confirmModal({
    title: 'Move to Trash?',
    body: `<strong>${fmtNum(paths.length)} files</strong> (${esc(fmtBytes(selectionBytes()))}) will be moved to the ${api.platform === 'win32' ? 'Recycle Bin' : 'Trash'}. You can restore them from there at any time.`,
    confirmLabel: 'Move to Trash',
    danger: true,
  });
  if (!ok) return;

  const res = await api.trash(paths);
  const gone = new Set(res.trashed);

  // Mirror the main-process index update in the renderer's copy.
  S.dupes.groups = S.dupes.groups
    .map(g => ({ ...g, files: g.files.filter(f => !gone.has(f.path)) }))
    .map(g => ({ ...g, count: g.files.length, wasted: g.size * Math.max(0, g.files.length - 1) }))
    .filter(g => g.files.length > 1);
  S.dupes.groupCount = S.dupes.groups.length;
  S.dupes.shown = S.dupes.groups.length;
  S.dupes.totalWasted = S.dupes.groups.reduce((s, g) => s + g.wasted, 0);
  S.dupeSelection = new Set([...S.dupeSelection].filter(p => !gone.has(p)));

  const badge = $('#dupe-badge');
  if (S.dupes.groupCount > 0) { badge.textContent = fmtNum(S.dupes.groupCount); badge.hidden = false; }
  else badge.hidden = true;

  if (res.failed.length) toast(`Moved ${fmtNum(res.trashed.length)} to Trash — ${fmtNum(res.failed.length)} failed`, false);
  else toast(`Moved ${fmtNum(res.trashed.length)} files to Trash`);
  renderDupes();
}

// ------------------------------------------------------------- similar photos

function fileUrl(p) {
  const norm = api.platform === 'win32' ? '/' + p.replace(/\\/g, '/') : p;
  return 'file://' + encodeURI(norm).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function renderPhotos() {
  const el = $('#view-photos');

  if (!S.similar) {
    const imgCat = S.overview && S.overview.categories.find(c => c.key === 'Images');
    el.innerHTML = `
      <div class="view-head"><div>
        <div class="view-title">Similar Photos</div>
        <div class="view-sub">Finds resized, re-exported, and lightly edited versions of the same shot — not just exact copies</div>
      </div></div>
      <div class="panel dupe-idle">
        <div class="dupe-idle-icon"><svg viewBox="0 0 24 24"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3.5 4A2.5 2.5 0 1 0 11 9.5 2.5 2.5 0 0 0 8.5 7ZM5 19h14l-4.5-7-3.5 4.5-2-2.5L5 19Z"/></svg></div>
        <h3>Find visually similar photos</h3>
        <p>Nebula computes a perceptual fingerprint of every image and clusters ones that look alike, then recommends keeping the sharpest (highest-resolution) version of each.</p>
        <button class="btn btn-primary" id="btn-run-photos">Analyze ${imgCat ? fmtNum(imgCat.count) + ' images' : 'images'}</button>
      </div>`;
    $('#btn-run-photos').addEventListener('click', runPhotoAnalysis);
    return;
  }

  const sim = S.similar;
  if (!sim.clusters.length) {
    el.innerHTML = `
      <div class="view-head"><div>
        <div class="view-title">Similar Photos</div>
        <div class="view-sub">${fmtNum(sim.scanned)} images analyzed</div>
      </div></div>
      <div class="panel dupe-idle">
        <div class="dupe-idle-icon"><svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg></div>
        <h3>No similar photos found</h3>
        <p>Every analyzed image looks visually distinct.</p>
        <button class="btn btn-ghost" id="btn-rerun-photos">Re-analyze</button>
      </div>`;
    $('#btn-rerun-photos').addEventListener('click', runPhotoAnalysis);
    return;
  }

  const selCount = S.photoSelection.size;
  const selBytes = photoSelectionBytes();

  el.innerHTML = `
    <div class="view-head"><div>
      <div class="view-title">Similar Photos</div>
      <div class="view-sub">${fmtNum(sim.clusterCount)} groups from ${fmtNum(sim.scanned)} images · up to <strong style="color:#ff9d9d">${fmtBytes(sim.totalSavings)}</strong> reclaimable${sim.capped ? ' · largest 30k images analyzed' : ''}</div>
    </div></div>

    <div class="dupe-toolbar">
      <div class="dupe-toolbar-info"><strong>${fmtNum(selCount)}</strong> selected · <strong>${fmtBytes(selBytes)}</strong></div>
      <div class="dupe-toolbar-spacer"></div>
      <button class="btn btn-ghost btn-small" id="btn-photo-auto">Auto-select (keep sharpest)</button>
      <button class="btn btn-ghost btn-small" id="btn-photo-clear" ${selCount ? '' : 'disabled'}>Clear</button>
      <button class="btn btn-danger" id="btn-photo-trash" ${selCount ? '' : 'disabled'}>${ICON_TRASH} Move ${selCount ? fmtNum(selCount) + ' photos' : ''} to Trash</button>
    </div>

    <div id="photo-groups">${sim.clusters.map(photoClusterHtml).join('')}</div>`;

  $('#btn-photo-auto').addEventListener('click', () => {
    for (const c of sim.clusters) {
      // files sorted best-resolution first; keep [0]
      c.files.forEach((f, i) => { if (i === 0) S.photoSelection.delete(f.path); else S.photoSelection.add(f.path); });
    }
    renderPhotos();
  });
  $('#btn-photo-clear').addEventListener('click', () => { S.photoSelection.clear(); renderPhotos(); });
  $('#btn-photo-trash').addEventListener('click', trashSelectedPhotos);

  const groupsEl = $('#photo-groups');
  groupsEl.addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    if (cb.checked) S.photoSelection.add(cb.dataset.path);
    else S.photoSelection.delete(cb.dataset.path);
    cb.closest('.photo-card').classList.toggle('sel', cb.checked);
    renderPhotoToolbar();
  });
  groupsEl.addEventListener('click', e => {
    const img = e.target.closest('img');
    if (img) api.reveal(img.dataset.path);
  });
}

function photoClusterHtml(c) {
  return `
    <div class="panel dupe-group">
      <div class="dupe-group-head">
        <div class="dupe-group-title">${esc(c.files[0].name)}</div>
        <span class="badge ${c.near ? 'badge-verified' : 'badge-sampled'}">${c.near ? 'near-identical' : 'similar'}</span>
        <div class="dupe-group-meta">${fmtNum(c.count)} photos · ${fmtBytes(c.bytes)}</div>
        <div class="dupe-wasted">save up to ${fmtBytes(c.savings)}</div>
      </div>
      <div class="photo-grid">
        ${c.files.map((f, i) => `
          <div class="photo-card ${S.photoSelection.has(f.path) ? 'sel' : ''}">
            <img src="${fileUrl(f.path)}" data-path="${esc(f.path)}" loading="lazy" title="${esc(f.path)} — click to reveal">
            <input type="checkbox" data-path="${esc(f.path)}" ${S.photoSelection.has(f.path) ? 'checked' : ''}>
            ${i === 0 ? '<span class="tag-best">best</span>' : ''}
            <div class="photo-meta">${f.w}×${f.h} · ${fmtBytes(f.size)}</div>
            <div class="photo-name" title="${esc(f.dir)}">${esc(f.name)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

function photoSelectionBytes() {
  if (!S.similar) return 0;
  let bytes = 0;
  for (const c of S.similar.clusters)
    for (const f of c.files)
      if (S.photoSelection.has(f.path)) bytes += f.size;
  return bytes;
}

function renderPhotoToolbar() {
  const info = document.querySelector('#view-photos .dupe-toolbar-info');
  if (info) info.innerHTML = `<strong>${fmtNum(S.photoSelection.size)}</strong> selected · <strong>${fmtBytes(photoSelectionBytes())}</strong>`;
  const trashBtn = $('#btn-photo-trash'), clearBtn = $('#btn-photo-clear');
  if (trashBtn) {
    trashBtn.disabled = !S.photoSelection.size;
    trashBtn.innerHTML = `${ICON_TRASH} Move ${S.photoSelection.size ? fmtNum(S.photoSelection.size) + ' photos' : ''} to Trash`;
  }
  if (clearBtn) clearBtn.disabled = !S.photoSelection.size;
}

async function runPhotoAnalysis() {
  const el = $('#view-photos');
  el.innerHTML = `
    <div class="view-head"><div>
      <div class="view-title">Similar Photos</div>
      <div class="view-sub">Computing perceptual fingerprints…</div>
    </div></div>
    <div class="dupe-progress">
      <div class="dupe-progress-label" id="photo-phase">Preparing…</div>
      <div class="progress-track"><div class="progress-fill" id="photo-fill" style="width:2%"></div></div>
      <button class="btn btn-ghost" id="btn-cancel-photos">Cancel</button>
    </div>`;
  $('#btn-cancel-photos').addEventListener('click', () => api.cancelPhotos());

  const res = await api.findSimilarPhotos();
  if (res && res.error) { toast(res.error, false); S.similar = null; renderPhotos(); return; }
  if (res && res.cancelled) { toast('Photo analysis cancelled'); S.similar = null; renderPhotos(); return; }
  S.similar = res;
  S.photoSelection = new Set();
  renderPhotos();
}

api.onPhotoProgress(p => {
  const phase = $('#photo-phase'), fill = $('#photo-fill');
  if (!phase || !fill) return;
  phase.textContent = `Fingerprinting ${fmtNum(p.total)} images (${fmtNum(p.done)} done)`;
  fill.style.width = `${p.total ? ((p.done / p.total) * 100).toFixed(1) : 100}%`;
});

async function trashSelectedPhotos() {
  const paths = [...S.photoSelection];
  if (!paths.length) return;
  const ok = await confirmModal({
    title: 'Move photos to Trash?',
    body: `<strong>${fmtNum(paths.length)} photos</strong> (${esc(fmtBytes(photoSelectionBytes()))}) will be moved to the ${api.platform === 'win32' ? 'Recycle Bin' : 'Trash'}. The best version of each group stays untouched.`,
    confirmLabel: 'Move to Trash',
    danger: true,
  });
  if (!ok) return;

  const res = await api.trash(paths);
  const gone = new Set(res.trashed);
  S.similar.clusters = S.similar.clusters
    .map(c => ({ ...c, files: c.files.filter(f => !gone.has(f.path)) }))
    .filter(c => c.files.length > 1)
    .map(c => {
      const bytes = c.files.reduce((s, f) => s + f.size, 0);
      return { ...c, count: c.files.length, bytes, savings: bytes - c.files[0].size };
    });
  S.similar.clusterCount = S.similar.clusters.length;
  S.similar.totalSavings = S.similar.clusters.reduce((s, c) => s + c.savings, 0);
  S.photoSelection = new Set([...S.photoSelection].filter(p => !gone.has(p)));

  if (res.failed.length) toast(`Moved ${fmtNum(res.trashed.length)} to Trash — ${fmtNum(res.failed.length)} failed`, false);
  else toast(`Moved ${fmtNum(res.trashed.length)} photos to Trash`);
  renderPhotos();
}

// ------------------------------------------------------------- changes (diff)

async function renderChanges() {
  const el = $('#view-changes');
  const d = await api.diffGet();

  if (!d) {
    el.innerHTML = `
      <div class="view-head"><div>
        <div class="view-title">Changes</div>
        <div class="view-sub">See exactly what grew, shrank, appeared, and disappeared between scans</div>
      </div></div>
      <div class="panel dupe-idle">
        <div class="dupe-idle-icon"><svg viewBox="0 0 24 24"><path d="M3 17.5 9 11l4 4 7.3-8.2 1.4 1.3L13 18l-4-4-4.6 5H21v2H3v-3.5Z"/></svg></div>
        <h3>No comparison point yet</h3>
        <p>Nebula snapshots every completed scan. Rescan this folder — now or any time later — and this view will show precisely where new storage went.</p>
        <button class="btn btn-primary" id="btn-diff-rescan">Rescan now</button>
      </div>`;
    $('#btn-diff-rescan').addEventListener('click', () => { if (S.root) startScan(S.root); });
    return;
  }

  const net = d.net;
  const netParts = fmtBytesParts(Math.abs(net));
  const maxDir = Math.max(...d.dirs.map(x => Math.abs(x.delta)), 1);

  el.innerHTML = `
    <div class="view-head"><div>
      <div class="view-title">Changes</div>
      <div class="view-sub">Since ${esc(fmtDate(d.prevAt))} at ${esc(new Date(d.prevAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</div>
    </div></div>

    <div class="kpi-row">
      <div class="kpi">
        <div class="kpi-label">Net change</div>
        <div class="kpi-value" style="color:${net > 0 ? '#ff9d9d' : net < 0 ? '#6fdb6f' : 'inherit'}">${net > 0 ? '+' : net < 0 ? '−' : ''}${netParts.num}<small>${netParts.unit}</small></div>
        <div class="kpi-sub">${net >= 0 ? 'more' : 'less'} storage used than last scan</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Added</div>
        <div class="kpi-value">${fmtBytesParts(d.addedBytes).num}<small>${fmtBytesParts(d.addedBytes).unit}</small></div>
        <div class="kpi-sub">${fmtNum(d.addedCount)} new files</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Removed</div>
        <div class="kpi-value">${fmtBytesParts(d.removedBytes).num}<small>${fmtBytesParts(d.removedBytes).unit}</small></div>
        <div class="kpi-sub">${fmtNum(d.removedCount)} files deleted</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Grew in place</div>
        <div class="kpi-value">${fmtBytesParts(d.grownBytes).num}<small>${fmtBytesParts(d.grownBytes).unit}</small></div>
        <div class="kpi-sub">${fmtNum(d.changedCount)} files changed size</div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <div class="panel-title">Where it changed <span class="panel-hint">red grew · green shrank · click to explore</span></div>
      <div class="bar-list" id="diff-dirs">
        ${d.dirs.map((x, i) => `
          <div class="diff-row" data-i="${i}" title="${esc(x.path)}" style="cursor:pointer">
            <div class="bar-row-name">${ICON_FOLDER}<span>${esc(x.name)}</span></div>
            <div class="diff-track"><div class="${x.delta > 0 ? 'diff-fill-pos' : 'diff-fill-neg'}" style="width:${((Math.abs(x.delta) / maxDir) * 100).toFixed(1)}%"></div></div>
            <div class="${x.delta > 0 ? 'diff-delta-pos' : 'diff-delta-neg'}">${x.delta > 0 ? '+' : '−'}${fmtBytes(Math.abs(x.delta))}</div>
          </div>`).join('') || '<div class="empty-note">No folder-level changes.</div>'}
      </div>
    </div>

    <div class="dash-grid-2">
      <div class="panel">
        <div class="panel-title">Biggest new & grown files <span class="panel-hint">click to reveal</span></div>
        <div id="diff-new">
          ${[...d.newFiles.map(f => ({ ...f, delta: f.size, tag: 'new' })), ...d.grownFiles.map(f => ({ ...f, tag: 'grew' }))]
            .sort((a, b) => b.delta - a.delta).slice(0, 15).map(f => `
            <div class="file-row" data-path="${esc(f.path)}" title="${esc(f.path)}">
              <div class="file-chip" style="background:${f.tag === 'new' ? '#e66767' : '#c98500'}">${f.tag.toUpperCase()}</div>
              <div class="file-row-main">
                <div class="file-row-name">${esc(f.name)}</div>
                <div class="file-row-path">${esc(f.dir)}</div>
              </div>
              <div class="file-row-size" style="color:#ff9d9d">+${fmtBytes(f.delta)}</div>
            </div>`).join('') || '<div class="empty-note">Nothing new or grown.</div>'}
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">Deleted files</div>
        <div>
          ${d.deletedFiles.slice(0, 15).map(f => `
            <div class="file-row" style="cursor:default" title="${esc(f.path)}">
              <div class="file-chip" style="background:#3a4152">GONE</div>
              <div class="file-row-main">
                <div class="file-row-name">${esc(f.name)}</div>
                <div class="file-row-path">${esc(f.dir)}</div>
              </div>
              <div class="file-row-size" style="color:#6fdb6f">−${fmtBytes(f.size)}</div>
            </div>`).join('') || '<div class="empty-note">Nothing deleted.</div>'}
        </div>
      </div>
    </div>`;

  $('#diff-dirs').addEventListener('click', e => {
    const row = e.target.closest('.diff-row');
    if (!row) return;
    const x = d.dirs[+row.dataset.i];
    if (x) { S.storageDir = x.path; setView('storage'); }
  });
  $('#diff-new').addEventListener('click', e => {
    const row = e.target.closest('.file-row');
    if (row && row.dataset.path) api.reveal(row.dataset.path);
  });
}

// ------------------------------------------------------------- largest files

async function refreshLargest() {
  const el = $('#view-largest');
  const o = S.overview;
  const cats = o ? o.categories.map(c => c.key) : [];

  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = `
      <div class="view-head"><div>
        <div class="view-title">Largest Files</div>
        <div class="view-sub">The biggest single wins for reclaiming space</div>
      </div></div>
      <div class="filter-row" id="largest-filters"></div>
      <div class="panel" style="padding:8px 12px"><div style="overflow-x:auto"><table class="big-table">
        <thead><tr>
          <th class="td-rank">#</th><th>Name</th><th>Type</th><th style="text-align:right">Size</th><th></th><th>Modified</th><th></th>
        </tr></thead>
        <tbody id="largest-body"></tbody>
      </table></div></div>`;
  }

  $('#largest-filters').innerHTML = [
    `<button class="chip ${S.largest.category === null ? 'active' : ''}" data-cat="">All types</button>`,
    ...cats.map(c => `<button class="chip ${S.largest.category === c ? 'active' : ''}" data-cat="${esc(c)}"><span class="type-dot" style="display:inline-block;background:${catColor(c)};margin-right:6px"></span>${esc(c)}</button>`),
    `<input class="search-input" id="largest-search" type="text" placeholder="Filter by name or path…" value="${esc(S.largest.query)}">`,
  ].join('');

  $('#largest-filters').querySelectorAll('.chip').forEach(ch =>
    ch.addEventListener('click', () => { S.largest.category = ch.dataset.cat || null; refreshLargest(); }));
  $('#largest-search').addEventListener('input', debounce(e => {
    S.largest.query = e.target.value;
    fetchLargestRows();
  }, 250));

  await fetchLargestRows();
}

async function fetchLargestRows() {
  const rows = await api.largest({ limit: 150, category: S.largest.category, query: S.largest.query });
  S.largest.rows = rows;
  const body = $('#largest-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-note">No files match.</div></td></tr>';
    return;
  }
  const max = rows[0].size || 1;
  body.innerHTML = rows.map((f, i) => `
    <tr>
      <td class="td-rank">${i + 1}</td>
      <td class="td-name" title="${esc(f.path)}"><span class="nm">${esc(f.name)}</span><span class="pth">${esc(f.dir)}</span></td>
      <td><span class="type-pill"><span class="type-dot" style="background:${catColor(f.category)}"></span>${esc(f.category)}</span></td>
      <td class="td-size" style="text-align:right">${fmtBytes(f.size)}</td>
      <td class="td-bar"><div class="bar-track"><div class="bar-fill" style="width:${((f.size / max) * 100).toFixed(1)}%"></div></div></td>
      <td class="td-date">${fmtDate(f.mtime)}</td>
      <td class="td-actions">
        <button class="icon-btn" data-act="reveal" data-i="${i}" title="Reveal">${ICON_REVEAL}</button>
        <button class="icon-btn danger" data-act="trash" data-i="${i}" title="Move to Trash">${ICON_TRASH}</button>
      </td>
    </tr>`).join('');

  body.onclick = async e => {
    const btn = e.target.closest('.icon-btn');
    if (!btn) return;
    const f = S.largest.rows[+btn.dataset.i];
    if (btn.dataset.act === 'reveal') api.reveal(f.path);
    if (btn.dataset.act === 'trash') {
      const ok = await confirmModal({
        title: 'Move to Trash?',
        body: `<strong>${esc(f.name)}</strong> (${esc(fmtBytes(f.size))}) will be moved to the ${api.platform === 'win32' ? 'Recycle Bin' : 'Trash'}.`,
        confirmLabel: 'Move to Trash',
        danger: true,
      });
      if (!ok) return;
      const res = await api.trash([f.path]);
      if (res.failed.length) toast(`Couldn't trash: ${res.failed[0].error}`, false);
      else { toast(`Moved “${f.name}” to Trash`); fetchLargestRows(); }
    }
  };
}
