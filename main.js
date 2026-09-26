// Nebula — main process: window, filesystem scanning, duplicate detection, file ops.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DEBUG = !!process.env.NEBULA_DEBUG;

let win = null;

// All scan data lives in the main process; the renderer queries slices of it
// over IPC so payloads stay small even for million-file trees.
const state = {
  root: null,
  rootNode: null,
  files: [],            // flat list: { path, name, size, ext, mtime }
  dirIndex: new Map(),  // dir path -> tree node
  scanning: false,
  scanCancelled: false,
  dupeRunning: false,
  dupeCancelled: false,
  duplicates: null,     // { groups, totalWasted, ... }
  photoRunning: false,
  photoCancelled: false,
  similar: null,        // { clusters, totalSavings, ... }
  prevSnapshot: null,   // previous scan of the same root, for the Changes view
  hashCache: new Map(), // path -> { size, mtime, quick, full } — survives restarts
  hashCacheRoot: null,  // which root the cache above was loaded for
  dupesSavedAt: null,   // when state.duplicates was last persisted
  trashCancelled: false,
};

// ---------------------------------------------------------------- categories

const CATEGORY_DEFS = [
  ['Images',        ['jpg','jpeg','png','gif','webp','heic','heif','svg','tif','tiff','bmp','ico','raw','cr2','cr3','nef','arw','dng','psd','ai','sketch','eps','avif']],
  ['Video',         ['mp4','mov','avi','mkv','webm','m4v','flv','wmv','mpg','mpeg','mts','m2ts','3gp','hevc','vob']],
  ['Audio',         ['mp3','wav','aac','flac','m4a','ogg','oga','aiff','aif','wma','mid','midi','opus','m4b']],
  ['Documents',     ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','rtf','odt','ods','odp','pages','numbers','key','epub','mobi','csv','tsv','ics','eml','msg']],
  ['Code & Data',   ['js','mjs','cjs','ts','jsx','tsx','py','ipynb','java','c','cpp','cc','h','hpp','cs','go','rs','rb','php','swift','kt','kts','m','mm','html','htm','css','scss','less','json','xml','yml','yaml','toml','sh','zsh','bash','bat','ps1','sql','db','sqlite','log','lock','map','wasm','pkl','parquet','npy']],
  ['AI Models',     ['gguf','safetensors','pt','pth','ckpt','onnx','mlmodel','mlpackage','tflite','llamafile']],
  ['Archives',      ['zip','rar','7z','tar','gz','tgz','bz2','xz','zst','dmg','iso','img','pkg','deb','rpm','jar','war','apk','ipa','crx','xip']],
  ['Apps & System', ['app','exe','msi','dll','dylib','so','framework','sys','kext','bin','dat','plist','icns','ttf','otf','woff','woff2','tmp','cache','part','swp','ds_store']],
];
const CATEGORY_ORDER = [...CATEGORY_DEFS.map(d => d[0]), 'Other'];
const EXT_TO_CATEGORY = new Map();
for (const [cat, exts] of CATEGORY_DEFS) {
  for (const e of exts) EXT_TO_CATEGORY.set('.' + e, cat);
}
// Ollama and Hugging Face store models as content-addressed blobs with no file
// extension, so those stores are recognized by path instead.
const MODEL_STORE_RE = /[\\/](?:\.ollama[\\/]models|huggingface[\\/]hub[\\/]models--)[\\/]/;
function categoryOf(ext, filePath) {
  if (filePath && MODEL_STORE_RE.test(filePath)) return 'AI Models';
  return EXT_TO_CATEGORY.get(ext) || 'Other';
}

// ---------------------------------------------------------------- utilities

class Semaphore {
  constructor(n) { this.free = n; this.queue = []; }
  async acquire() {
    if (this.free > 0) { this.free--; return; }
    await new Promise(res => this.queue.push(res));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.free++;
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Destructive/read operations are only honored inside folders the user has
// explicitly opened (scan, compare, organize). A compromised renderer cannot
// reach outside them.
const authorizedRoots = new Set();
function authorize(p) { if (p) authorizedRoots.add(p); }
function isAuthorized(p) {
  if (typeof p !== 'string' || !p) return false;
  for (const r of authorizedRoots) {
    if (p === r || (p.startsWith(r) && (r.endsWith(path.sep) || p[r.length] === path.sep))) return true;
  }
  return false;
}

function fileInfo(f) {
  return {
    name: f.name,
    path: f.path,
    dir: path.dirname(f.path),
    size: f.size,
    ext: f.ext,
    mtime: f.mtime,
    category: categoryOf(f.ext, f.path),
  };
}

// ---------------------------------------------------------------- scanning

async function runScan(root) {
  authorize(root);
  state.root = root;
  state.files = [];
  state.dirIndex = new Map();
  state.duplicates = null;
  state.scanCancelled = false;
  state.scanning = true;

  const started = Date.now();
  const progress = { files: 0, dirs: 0, bytes: 0, errors: 0, lastSent: 0 };
  const rootNode = { name: path.basename(root) || root, path: root, size: 0, isDir: true, fileCount: 0, children: [] };
  state.rootNode = rootNode;
  state.dirIndex.set(root, rootNode);

  const sem = new Semaphore(48); // bound concurrent fs handles

  function report(current) {
    const now = Date.now();
    if (now - progress.lastSent > 80) {
      progress.lastSent = now;
      send('scan:progress', {
        files: progress.files, dirs: progress.dirs,
        bytes: progress.bytes, errors: progress.errors, current,
      });
    }
  }

  async function walk(dirPath, node) {
    if (state.scanCancelled) return;
    let entries;
    await sem.acquire();
    try { entries = await fsp.readdir(dirPath, { withFileTypes: true }); }
    catch { progress.errors++; return; }
    finally { sem.release(); }

    const dirEnts = [];
    const fileEnts = [];
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue; // never follow links: avoids cycles and double-counting
      if (ent.isDirectory()) dirEnts.push(ent);
      else if (ent.isFile()) fileEnts.push(ent);
    }

    for (let i = 0; i < fileEnts.length; i += 64) {
      if (state.scanCancelled) return;
      const chunk = fileEnts.slice(i, i + 64);
      await Promise.all(chunk.map(async ent => {
        const full = path.join(dirPath, ent.name);
        await sem.acquire();
        let st;
        try { st = await fsp.stat(full); }
        catch { progress.errors++; return; }
        finally { sem.release(); }
        const ext = path.extname(ent.name).toLowerCase();
        state.files.push({ path: full, name: ent.name, size: st.size, ext, mtime: st.mtimeMs });
        node.children.push({ name: ent.name, path: full, size: st.size, isDir: false, ext, mtime: st.mtimeMs });
        node.size += st.size;
        node.fileCount += 1;
        progress.files++;
        progress.bytes += st.size;
      }));
      report(dirPath);
    }

    await Promise.all(dirEnts.map(async ent => {
      if (state.scanCancelled) return;
      const full = path.join(dirPath, ent.name);
      const child = { name: ent.name, path: full, size: 0, isDir: true, fileCount: 0, children: [] };
      node.children.push(child);
      state.dirIndex.set(full, child);
      progress.dirs++;
      await walk(full, child);
      node.size += child.size;
      node.fileCount += child.fileCount;
    }));
    report(dirPath);
  }

  await walk(root, rootNode);
  sortTree(rootNode);
  state.scanning = false;
  return {
    root,
    name: rootNode.name,
    totalBytes: rootNode.size,
    fileCount: progress.files,
    dirCount: progress.dirs,
    errors: progress.errors,
    elapsedMs: Date.now() - started,
    cancelled: state.scanCancelled,
  };
}

function sortTree(n) {
  n.children.sort((a, b) => b.size - a.size);
  for (const c of n.children) if (c.isDir) sortTree(c);
}

// ------------------------------------------------------- persistent index

const INDEX_VERSION = 1;

function indexPaths() {
  const dir = app.getPath('userData');
  return { data: path.join(dir, 'index-v1.gz'), meta: path.join(dir, 'index-meta.json') };
}

async function saveIndex() {
  if (!state.rootNode || state.scanning) return;
  const { data, meta } = indexPaths();
  const payload = {
    v: INDEX_VERSION,
    root: state.root,
    savedAt: Date.now(),
    files: state.files.map(f => [f.path, f.size, Math.round(f.mtime)]),
  };
  await fsp.writeFile(data, await gzip(JSON.stringify(payload)));
  await fsp.writeFile(meta, JSON.stringify({
    v: INDEX_VERSION,
    root: state.root,
    name: state.rootNode.name,
    savedAt: payload.savedAt,
    fileCount: state.files.length,
    totalBytes: state.rootNode.size,
  }));
}

let saveTimer = null;
function scheduleSaveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveIndex().catch(() => {}), 1500);
}

async function loadIndex() {
  const { data } = indexPaths();
  const payload = JSON.parse((await gunzip(await fsp.readFile(data))).toString());
  if (payload.v !== INDEX_VERSION) throw new Error('saved index is from an incompatible version');
  const root = payload.root;
  authorize(root); // the index only ever contains a root the user picked to scan

  state.root = root;
  state.files = [];
  state.dirIndex = new Map();
  state.duplicates = null;
  const rootNode = { name: path.basename(root) || root, path: root, size: 0, isDir: true, fileCount: 0, children: [] };
  state.rootNode = rootNode;
  state.dirIndex.set(root, rootNode);

  const ensureDir = dirPath => {
    let node = state.dirIndex.get(dirPath);
    if (node) return node;
    const parent = ensureDir(path.dirname(dirPath));
    node = { name: path.basename(dirPath), path: dirPath, size: 0, isDir: true, fileCount: 0, children: [] };
    parent.children.push(node);
    state.dirIndex.set(dirPath, node);
    return node;
  };

  for (const [p, size, mtime] of payload.files) {
    if (p !== root && !p.startsWith(root)) continue;
    const name = path.basename(p);
    const ext = path.extname(name).toLowerCase();
    state.files.push({ path: p, name, size, ext, mtime });
    ensureDir(path.dirname(p)).children.push({ name, path: p, size, isDir: false, ext, mtime });
    let d = path.dirname(p);
    while (true) {
      const n = state.dirIndex.get(d);
      if (n) { n.size += size; n.fileCount += 1; }
      if (d === root) break;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  sortTree(rootNode);
  return {
    root,
    name: rootNode.name,
    totalBytes: rootNode.size,
    fileCount: state.files.length,
    dirCount: state.dirIndex.size - 1,
    savedAt: payload.savedAt,
    restored: true,
  };
}

// ------------------------------------------------- persistent analysis cache
//
// Duplicate analysis on a big volume is expensive (millions of files, GBs of
// hashing), so both the result and the per-file content hashes are persisted
// next to the scan index. A later run reuses every hash whose size+mtime still
// match and only re-reads files that actually changed, and the Duplicates view
// can come back after a restart without re-analyzing anything.

const DUPES_VERSION = 1;

function dupesPaths() {
  const dir = app.getPath('userData');
  return { data: path.join(dir, 'dupes-v1.gz'), meta: path.join(dir, 'dupes-meta.json') };
}

const cacheMtime = mtime => Math.round(mtime || 0);

function cachedHash(f, kind) {
  const c = state.hashCache.get(f.path);
  if (!c || c.size !== f.size || c.mtime !== cacheMtime(f.mtime)) return null;
  return (kind === 'quick' ? c.quick : c.full) || null;
}

function rememberHash(f, kind, h) {
  let c = state.hashCache.get(f.path);
  if (!c || c.size !== f.size || c.mtime !== cacheMtime(f.mtime)) {
    c = { size: f.size, mtime: cacheMtime(f.mtime) };
    state.hashCache.set(f.path, c);
  }
  c[kind] = h;
}

// The analysis file is gzipped JSON-lines: the first line is the header (root,
// saved timestamp, result), every following line is one cached fingerprint.
// Streaming keeps saving/loading flat in memory even for millions of entries —
// building one giant JSON string would reintroduce the very spike that used to
// kill the app on big volumes.
function dupesStream() {
  const src = fs.createReadStream(dupesPaths().data);
  const gz = zlib.createGunzip();
  // A missing/corrupt file must reject the read, not throw an unhandled stream
  // error that would take the whole main process down on first run.
  src.on('error', err => gz.destroy(err));
  const rl = require('readline').createInterface({ input: src.pipe(gz), crlfDelay: Infinity });
  return { src, gz, rl };
}

async function readDupesHeader() {
  const { src, gz, rl } = dupesStream();
  try {
    for await (const line of rl) {
      if (line.trim()) return JSON.parse(line);
    }
    throw new Error('saved analysis file is empty');
  } finally {
    rl.close();
    gz.destroy();
    src.destroy();
  }
}

async function streamHashes(onHash) {
  const { src, gz, rl } = dupesStream();
  let first = true;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (first) { first = false; continue; } // header line
      const [p, size, mtime, quick, full] = JSON.parse(line);
      if (typeof p !== 'string' || !p) continue;
      onHash(p, { size, mtime, quick: quick || null, full: full || null });
    }
  } finally {
    rl.close();
    gz.destroy();
    src.destroy();
  }
}

async function writeDupesState() {
  const { data, meta } = dupesPaths();
  const live = new Set(state.files.map(f => f.path)); // drop hashes for files that are gone
  const header = {
    v: DUPES_VERSION,
    root: state.root,
    savedAt: state.dupesSavedAt || Date.now(),
    duplicates: state.duplicates,
  };
  const tmp = data + '.tmp';
  let cachedHashes = 0;

  async function* lines() {
    yield JSON.stringify(header) + '\n';
    let batch = [];
    for (const [p, c] of state.hashCache) {
      if (!live.has(p)) continue;
      cachedHashes++;
      batch.push(JSON.stringify(c.full ? [p, c.size, c.mtime, c.quick || null, c.full] : [p, c.size, c.mtime, c.quick || null]) + '\n');
      if (batch.length >= 2000) { yield batch.join(''); batch = []; }
    }
    if (batch.length) yield batch.join('');
  }

  try {
    // pipeline() owns the whole chain, so the gzip stream is always ended and
    // errors surface instead of leaving a truncated file behind.
    await pipeline(lines(), zlib.createGzip(), fs.createWriteStream(tmp));
    await fsp.rename(tmp, data); // atomic swap: a crash never leaves a half file
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await fsp.writeFile(meta, JSON.stringify({
    v: DUPES_VERSION,
    root: state.root,
    name: path.basename(state.root) || state.root,
    savedAt: header.savedAt,
    groupCount: state.duplicates ? state.duplicates.groupCount : 0,
    totalWasted: state.duplicates ? state.duplicates.totalWasted : 0,
    scannedFiles: state.duplicates ? state.duplicates.scannedFiles : state.files.length,
    cachedHashes,
  }));
}

// Reuse the hashes of a previous run for this root (unchanged files only).
async function loadHashCache(root) {
  if (!root || state.hashCacheRoot === root) return state.hashCache.size;
  const cache = new Map();
  state.hashCache = cache;
  state.hashCacheRoot = root;
  try {
    const header = await readDupesHeader();
    if (header.v !== DUPES_VERSION || header.root !== root) return 0;
    await streamHashes((p, c) => cache.set(p, c));
    return cache.size;
  } catch {
    return 0;
  }
}

async function saveDupesState() {
  if (!state.root || state.scanning) return;
  await writeDupesState();
}

let dupesSaveTimer = null;
function scheduleSaveDupes() {
  clearTimeout(dupesSaveTimer);
  dupesSaveTimer = setTimeout(() => saveDupesState().catch(() => {}), 1500);
}

async function dupesInfo() {
  try {
    const meta = JSON.parse(await fsp.readFile(dupesPaths().meta, 'utf8'));
    return meta.v === DUPES_VERSION ? meta : null;
  } catch { return null; }
}

// Bring a saved analysis back into the session (no re-hashing). Only usable for
// the root that is currently open, since every stored path must be re-authorized.
async function loadDupesState() {
  try {
    if (!state.root) throw new Error('open or resume a folder first');
    const header = await readDupesHeader();
    if (header.v !== DUPES_VERSION) throw new Error('saved analysis is from an incompatible version');
    if (header.root !== state.root) throw new Error(`saved analysis belongs to ${header.root}`);
    if (!header.duplicates) throw new Error('no saved duplicate analysis');
    authorize(header.root);
    const cache = new Map();
    state.hashCache = cache;
    state.hashCacheRoot = state.root;
    await streamHashes((p, c) => cache.set(p, c));
    state.duplicates = { ...header.duplicates, restored: true, savedAt: header.savedAt };
    state.dupesSavedAt = header.savedAt;
    return state.duplicates;
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

// ---------------------------------------------------------------- overview

function buildOverview() {
  const rootNode = state.rootNode;
  if (!rootNode) return null;

  const catAgg = new Map();
  const extAgg = new Map();
  for (const f of state.files) {
    const cat = categoryOf(f.ext, f.path);
    let a = catAgg.get(cat);
    if (!a) catAgg.set(cat, a = { bytes: 0, count: 0 });
    a.bytes += f.size; a.count++;
    const ex = f.ext || '(none)';
    let x = extAgg.get(ex);
    if (!x) extAgg.set(ex, x = { bytes: 0, count: 0 });
    x.bytes += f.size; x.count++;
  }
  const categories = CATEGORY_ORDER
    .map(key => ({ key, ...(catAgg.get(key) || { bytes: 0, count: 0 }) }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const topExtensions = [...extAgg.entries()]
    .map(([ext, v]) => ({ ext, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  const largest = [...state.files].sort((a, b) => b.size - a.size).slice(0, 12).map(fileInfo);

  const topDirs = rootNode.children
    .filter(c => c.isDir)
    .slice(0, 12)
    .map(d => ({ name: d.name, path: d.path, size: d.size, fileCount: d.fileCount }));
  const looseFiles = rootNode.children.filter(c => !c.isDir);
  const looseBytes = looseFiles.reduce((s, c) => s + c.size, 0);

  return {
    root: state.root,
    name: rootNode.name,
    totalBytes: rootNode.size,
    fileCount: rootNode.fileCount,
    dirCount: state.dirIndex.size - 1,
    categories,
    topExtensions,
    largest,
    topDirs,
    looseBytes,
    looseCount: looseFiles.length,
    duplicates: state.duplicates
      ? { totalWasted: state.duplicates.totalWasted, groupCount: state.duplicates.groupCount }
      : null,
  };
}

// ---------------------------------------------------------------- hashing

function hashRange(filePath, start, length) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath, length != null ? { start, end: start + length - 1 } : {});
    stream.on('data', d => h.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

const QUICK_BYTES = 131072;      // 128 KB head hash for first-pass grouping
const FULL_HASH_LIMIT = 1.5e9;   // above this, sample instead of full read
const SAMPLE_BYTES = 4 * 1024 * 1024;
const HASH_BATCH = 1024;         // candidates hashed per round; keeps Promise.all bounded
const MAX_GROUP_FILES = 1000;    // per duplicate set kept for the UI (totals stay exact)

// Hash a candidate list in bounded rounds. A large volume can hold millions of
// same-size files; fanning every one of them out into a single Promise.all
// spikes memory (~KB per candidate) and eventually throws V8's
// "Too many elements passed to Promise.all", killing the duplicate/compare
// runs on big disks. Rounding keeps at most HASH_BATCH promises in flight.
// `lookup` (optional) returns a hash cached from an earlier run, so only new or
// changed files are ever read from disk.
async function hashInRounds({ items, phase, total, sem, channel, cancelled, hashFile, remember, lookup, stats }) {
  let done = 0, lastSent = 0;
  for (let i = 0; i < items.length; i += HASH_BATCH) {
    if (cancelled()) return false;
    const chunk = items.slice(i, i + HASH_BATCH);
    await Promise.all(chunk.map(async it => {
      if (cancelled()) return; // nothing new queued once a stop was requested
      const cached = lookup ? lookup(it) : null;
      if (cached == null) {
        await sem.acquire();
        try {
          if (cancelled()) return; // cancelled while queued — hand the slot back
          const h = await hashFile(it);
          if (h != null) remember(it, h);
        } catch { /* unreadable: drop from candidates */ }
        finally { sem.release(); }
      } else {
        if (stats) stats.reused++;
        remember(it, cached);
      }
      done++;
      const now = Date.now();
      if (now - lastSent > 100 || done === total) {
        lastSent = now;
        send(channel, { phase, done, total, reused: stats ? stats.reused : 0 });
      }
    }));
  }
  return true;
}

async function sampledHash(filePath, size) {
  const h = crypto.createHash('sha1');
  const fd = await fsp.open(filePath, 'r');
  try {
    const offsets = [0, Math.max(0, Math.floor(size / 2) - SAMPLE_BYTES / 2), Math.max(0, size - SAMPLE_BYTES)];
    const buf = Buffer.alloc(SAMPLE_BYTES);
    for (const off of offsets) {
      const { bytesRead } = await fd.read(buf, 0, Math.min(SAMPLE_BYTES, size - off), off);
      h.update(buf.subarray(0, bytesRead));
    }
    h.update(String(size));
    return h.digest('hex');
  } finally {
    await fd.close();
  }
}

async function findDuplicates() {
  state.dupeRunning = true;
  state.dupeCancelled = false;

  // Pass 1: group by exact size — different sizes can never be duplicates.
  const bySize = new Map();
  for (const f of state.files) {
    if (f.size === 0) continue;
    let arr = bySize.get(f.size);
    if (!arr) bySize.set(f.size, arr = []);
    arr.push(f);
  }
  const sizeGroups = [...bySize.values()].filter(a => a.length > 1);
  const quickList = sizeGroups.flat();

  // Reuse hashes from the previous run on this root so an unchanged volume is
  // a fast no-op pass instead of re-reading everything.
  await loadHashCache(state.root);
  const cacheStats = { reused: 0 };

  const sem = new Semaphore(6);

  // Pass 2: hash the first 128 KB of every size-collision file.
  send('dupes:progress', { phase: 'quick', done: 0, total: quickList.length, reused: 0 });
  const quickHashes = new Map(); // file path -> quick hash
  const quickDone = await hashInRounds({
    items: quickList, phase: 'quick', total: quickList.length, sem,
    channel: 'dupes:progress', cancelled: () => state.dupeCancelled,
    hashFile: f => hashRange(f.path, 0, Math.min(f.size, QUICK_BYTES)),
    lookup: f => cachedHash(f, 'quick'),
    remember: (f, h) => { quickHashes.set(f.path, h); rememberHash(f, 'quick', h); },
    stats: cacheStats,
  });
  if (!quickDone) { state.dupeRunning = false; return null; }

  const byQuick = new Map();
  for (const f of quickList) {
    const qh = quickHashes.get(f.path);
    if (!qh) continue;
    const key = f.size + ':' + qh;
    let arr = byQuick.get(key);
    if (!arr) byQuick.set(key, arr = []);
    arr.push(f);
  }

  // Pass 3: confirm with a full-content hash (sampled for huge files).
  const fullList = [...byQuick.values()].filter(a => a.length > 1).flat()
    .filter(f => f.size > QUICK_BYTES); // small files: quick hash already covered every byte
  send('dupes:progress', { phase: 'full', done: 0, total: fullList.length, reused: 0 });
  const fullHashes = new Map();
  const fullDone = await hashInRounds({
    items: fullList, phase: 'full', total: fullList.length, sem,
    channel: 'dupes:progress', cancelled: () => state.dupeCancelled,
    hashFile: async f => {
      if (f.size > FULL_HASH_LIMIT) return 'S:' + await sampledHash(f.path, f.size);
      return 'F:' + await hashRange(f.path, 0, null);
    },
    lookup: f => cachedHash(f, 'full'),
    remember: (f, h) => { fullHashes.set(f.path, h); rememberHash(f, 'full', h); },
    stats: cacheStats,
  });
  if (!fullDone) { state.dupeRunning = false; return null; }

  const finalGroups = new Map();
  for (const arr of byQuick.values()) {
    if (arr.length < 2) continue;
    for (const f of arr) {
      let key;
      if (f.size <= QUICK_BYTES) key = 'Q:' + f.size + ':' + quickHashes.get(f.path);
      else {
        const fh = fullHashes.get(f.path);
        if (!fh) continue;
        key = fh + ':' + f.size;
      }
      let g = finalGroups.get(key);
      if (!g) finalGroups.set(key, g = []);
      g.push(f);
    }
  }

  let groups = [];
  let id = 0;
  for (const [key, arr] of finalGroups.entries()) {
    if (arr.length < 2) continue;
    const size = arr[0].size;
    // A set can contain hundreds of thousands of copies (a mirrored tree on a
    // big volume). Keep the stats exact but only ship a bounded number of rows
    // to the UI — otherwise the IPC payload and the renderer both blow up.
    const rows = arr
      .map(f => ({ path: f.path, name: f.name, dir: path.dirname(f.path), mtime: f.mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    const count = rows.length;
    if (rows.length > MAX_GROUP_FILES) rows.length = MAX_GROUP_FILES;
    groups.push({
      id: id++,
      size,
      count,
      wasted: size * (count - 1),
      verified: !key.startsWith('S:'), // sampled-hash groups are high-confidence, not byte-verified
      ext: arr[0].ext,
      category: categoryOf(arr[0].ext, arr[0].path),
      files: rows,
      more: count - rows.length, // copies beyond the rows kept, still counted above
    });
  }
  groups.sort((a, b) => b.wasted - a.wasted);
  const totalWasted = groups.reduce((s, g) => s + g.wasted, 0);
  const totalGroups = groups.length;
  groups = groups.slice(0, 400);

  state.duplicates = {
    groups,
    groupCount: totalGroups,
    shown: groups.length,
    totalWasted,
    scannedFiles: state.files.length,
    candidates: quickList.length,
    cachedHashes: cacheStats.reused, // fingerprints reused instead of re-read
    analyzedAt: Date.now(),
  };
  state.dupeRunning = false;
  state.dupesSavedAt = state.duplicates.analyzedAt;
  // Persist before handing the result back: a restart (or a crash) right after
  // the analysis must not cost the user another full run.
  await saveDupesState().catch(() => {});
  return state.duplicates;
}

// ------------------------------------------------------- auto-organize
//
// Builds a *plan* (never executes directly): loose files at the TOP LEVEL of
// a folder are classified into destination subfolders by name patterns and
// type. The renderer shows the plan for per-file approval; apply is a batch
// of same-volume renames with collision-safe names; undo restores everything.

const INSTALLER_EXTS = new Set(['.dmg', '.pkg', '.msi', '.exe', '.deb', '.rpm', '.xip', '.appimage']);
const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

function classifyForOrganize(name, ext, mtime, byYear) {
  const year = new Date(mtime).getFullYear();
  const y = d => (byYear ? path.join(d, String(year)) : d);
  if (/^(screen\s?shot|screenshot|screencap|screen\s?recording)/i.test(name)) {
    return { dest: y('Screenshots'), reason: 'Screenshot' };
  }
  if (/^(img|dsc|dscn|pxl|gopr|dji)[_\- ]?\d/i.test(name) && categoryOf(ext) === 'Images') {
    return { dest: y('Photos'), reason: 'Camera photo' };
  }
  if (INSTALLER_EXTS.has(ext)) return { dest: 'Installers', reason: 'Installer' };
  if (FONT_EXTS.has(ext)) return { dest: 'Fonts', reason: 'Font' };
  switch (categoryOf(ext)) {
    case 'Archives': return { dest: 'Archives', reason: 'Archive' };
    case 'Images': return { dest: y('Images'), reason: 'Image' };
    case 'Video': return { dest: y('Videos'), reason: 'Video' };
    case 'Audio': return { dest: y('Music'), reason: 'Audio' };
    case 'Documents': return { dest: y('Documents'), reason: 'Document' };
    case 'Code & Data': return { dest: 'Code & Data', reason: 'Data file' };
    case 'AI Models': return { dest: 'AI Models', reason: 'AI model' };
    default: return null; // unknown or system files stay put
  }
}

async function buildOrganizePlan(folder, opts = {}) {
  authorize(folder);
  const byYear = !!opts.byYear;
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  const moves = [];
  let staying = 0;
  for (const ent of entries) {
    if (ent.isSymbolicLink() || !ent.isFile()) continue;
    if (ent.name.startsWith('.') || ent.name.toLowerCase() === 'desktop.ini') continue;
    const full = path.join(folder, ent.name);
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    const ext = path.extname(ent.name).toLowerCase();
    const c = classifyForOrganize(ent.name, ext, st.mtimeMs, byYear);
    if (!c) { staying++; continue; }
    moves.push({ from: full, name: ent.name, size: st.size, mtime: st.mtimeMs, destDir: c.dest, reason: c.reason });
  }
  moves.sort((a, b) => a.destDir.localeCompare(b.destDir) || a.name.localeCompare(b.name));
  return { folder, moves, staying };
}

let lastOrganize = null;

function uniqueDest(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  for (let i = 2; i < 1000; i++) {
    const p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('too many name collisions');
}

async function applyOrganize(folder, moves) {
  const moved = [];
  const failed = [];
  for (const m of moves) {
    try {
      const destDirAbs = path.join(folder, m.destDir);
      await fsp.mkdir(destDirAbs, { recursive: true });
      const to = uniqueDest(path.join(destDirAbs, path.basename(m.from)));
      await fsp.rename(m.from, to);
      moved.push({ from: m.from, to });
    } catch (err) {
      failed.push({ from: m.from, error: String(err.message || err) });
    }
  }
  if (moved.length) {
    // accumulate within the same folder so undo restores the whole session,
    // even when the user applies destination-by-destination
    if (lastOrganize && lastOrganize.folder === folder) lastOrganize.moved.push(...moved);
    else lastOrganize = { folder, moved, at: Date.now() };
  }
  return { moved, failed };
}

async function undoOrganize() {
  if (!lastOrganize) return { error: 'Nothing to undo.' };
  const restored = [];
  const failed = [];
  const dirs = new Set();
  for (const m of lastOrganize.moved) {
    try {
      const back = uniqueDest(m.from);
      await fsp.rename(m.to, back);
      restored.push(back);
      dirs.add(path.dirname(m.to));
    } catch (err) {
      failed.push({ path: m.to, error: String(err.message || err) });
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await fsp.rmdir(d); } catch { /* not empty — keep */ }
  }
  lastOrganize = null;
  return { restored: restored.length, failed };
}

// ------------------------------------------------------- compare two roots
//
// Scans two folders (any drives) in parallel, then content-matches files
// across them with the same size → quick-hash → full-hash pipeline as the
// duplicate finder. Only groups with copies on BOTH sides are reported.

const cmp = { running: false, cancelled: false };

async function collectFiles(root, sideLabel) {
  const files = [];
  let errors = 0, bytes = 0, lastSent = 0;
  const sem = new Semaphore(32);
  async function walk(dirPath) {
    if (cmp.cancelled) return;
    let entries;
    await sem.acquire();
    try { entries = await fsp.readdir(dirPath, { withFileTypes: true }); }
    catch { errors++; return; }
    finally { sem.release(); }
    const dirEnts = [], fileEnts = [];
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) dirEnts.push(ent);
      else if (ent.isFile()) fileEnts.push(ent);
    }
    for (let i = 0; i < fileEnts.length; i += 64) {
      if (cmp.cancelled) return;
      await Promise.all(fileEnts.slice(i, i + 64).map(async ent => {
        const full = path.join(dirPath, ent.name);
        await sem.acquire();
        let st;
        try { st = await fsp.stat(full); }
        catch { errors++; return; }
        finally { sem.release(); }
        files.push({ path: full, name: ent.name, size: st.size, ext: path.extname(ent.name).toLowerCase(), mtime: st.mtimeMs });
        bytes += st.size;
      }));
      const now = Date.now();
      if (now - lastSent > 100) {
        lastSent = now;
        send('compare:progress', { phase: 'scan', side: sideLabel, files: files.length, bytes });
      }
    }
    await Promise.all(dirEnts.map(ent => walk(path.join(dirPath, ent.name))));
  }
  await walk(root);
  send('compare:progress', { phase: 'scan', side: sideLabel, files: files.length, bytes, done: true });
  return { files, errors, bytes };
}

async function compareRoots(rootA, rootB) {
  authorize(rootA);
  authorize(rootB);
  cmp.running = true;
  cmp.cancelled = false;

  const [a, b] = await Promise.all([collectFiles(rootA, 'A'), collectFiles(rootB, 'B')]);
  if (cmp.cancelled) { cmp.running = false; return null; }

  // candidates: any size collision in the combined corpus — this lets one pass
  // report matches across the sides AND duplicates within each side
  const bySize = new Map();
  const addSide = (files, side) => {
    for (const f of files) {
      if (f.size === 0) continue;
      let arr = bySize.get(f.size);
      if (!arr) bySize.set(f.size, arr = []);
      arr.push({ f, side });
    }
  };
  addSide(a.files, 'A');
  addSide(b.files, 'B');
  const candidates = [...bySize.values()].filter(arr => arr.length > 1).flat();

  const sem = new Semaphore(6);
  // Warm the hash cache when one of the compared roots is the open root; the
  // cache itself is keyed by path+size+mtime, so reusing it is always safe.
  if (state.root === rootA || state.root === rootB) await loadHashCache(state.root);

  send('compare:progress', { phase: 'quick', done: 0, total: candidates.length, reused: 0 });
  const quickDone = await hashInRounds({
    items: candidates, phase: 'quick', total: candidates.length, sem,
    channel: 'compare:progress', cancelled: () => cmp.cancelled,
    hashFile: c => hashRange(c.f.path, 0, Math.min(c.f.size, QUICK_BYTES)),
    lookup: c => cachedHash(c.f, 'quick'),
    remember: (c, h) => { c.qh = h; rememberHash(c.f, 'quick', h); },
  });
  if (!quickDone) { cmp.running = false; return null; }

  const byQuick = new Map();
  for (const c of candidates) {
    if (!c.qh) continue;
    const k = c.f.size + ':' + c.qh;
    let arr = byQuick.get(k);
    if (!arr) byQuick.set(k, arr = []);
    arr.push(c);
  }

  const fullList = [...byQuick.values()]
    .filter(arr => arr.length > 1)
    .flat()
    .filter(c => c.f.size > QUICK_BYTES);
  send('compare:progress', { phase: 'full', done: 0, total: fullList.length, reused: 0 });
  const fullDone = await hashInRounds({
    items: fullList, phase: 'full', total: fullList.length, sem,
    channel: 'compare:progress', cancelled: () => cmp.cancelled,
    hashFile: async c => {
      if (c.f.size > FULL_HASH_LIMIT) return 'S:' + await sampledHash(c.f.path, c.f.size);
      return 'F:' + await hashRange(c.f.path, 0, null);
    },
    lookup: c => cachedHash(c.f, 'full'),
    remember: (c, h) => { c.fh = h; rememberHash(c.f, 'full', h); },
  });
  if (!fullDone) { cmp.running = false; return null; }
  scheduleSaveDupes(); // refresh the hash cache for next time

  const finalMap = new Map();
  for (const arr of byQuick.values()) {
    if (arr.length < 2) continue;
    for (const c of arr) {
      let key;
      if (c.f.size <= QUICK_BYTES) key = 'Q:' + c.f.size + ':' + c.qh;
      else { if (!c.fh) continue; key = c.fh + ':' + c.f.size; }
      let g = finalMap.get(key);
      if (!g) finalMap.set(key, g = []);
      g.push(c);
    }
  }

  let groups = [];
  let id = 0, overlapA = 0, overlapB = 0, overlapFilesA = 0, overlapFilesB = 0;
  let withinWastedA = 0, withinWastedB = 0;
  for (const [key, arr] of finalMap.entries()) {
    if (arr.length < 2) continue;
    const countA = arr.filter(c => c.side === 'A').length;
    const countB = arr.length - countA;
    const size = arr[0].f.size;
    // scope: on both sides → cross; multiple copies on one side only → within that side
    let scope;
    if (countA && countB) {
      scope = 'cross';
      overlapA += size * countA;
      overlapB += size * countB;
      overlapFilesA += countA;
      overlapFilesB += countB;
    } else if (countA > 1) { scope = 'a'; withinWastedA += size * (countA - 1); }
    else { scope = 'b'; withinWastedB += size * (countB - 1); }
    // Keep stats exact but bound the rows shipped to the UI. Split per side
    // (newest first on each) so one side can't starve the other out of the
    // visible list when a set has hundreds of thousands of copies.
    const aKept = [], bKept = [];
    for (const c of arr) (c.side === 'A' ? aKept : bKept).push(c);
    aKept.sort((x, y) => y.f.mtime - x.f.mtime);
    bKept.sort((x, y) => y.f.mtime - x.f.mtime);
    aKept.length = Math.min(aKept.length, MAX_GROUP_FILES);
    bKept.length = Math.min(bKept.length, MAX_GROUP_FILES);
    const files = [...aKept, ...bKept]
      .map(c => ({ path: c.f.path, name: c.f.name, dir: path.dirname(c.f.path), mtime: c.f.mtime, side: c.side }));
    groups.push({
      id: id++, size, countA, countB, count: arr.length, scope,
      bytes: size * arr.length,
      wasted: size * (arr.length - 1),
      verified: !key.startsWith('S:'),
      ext: arr[0].f.ext,
      category: categoryOf(arr[0].f.ext, arr[0].f.path),
      files,
      more: arr.length - files.length,
    });
  }
  groups.sort((x, y) => y.bytes - x.bytes);
  const scopeCounts = {
    cross: groups.filter(g => g.scope === 'cross').length,
    a: groups.filter(g => g.scope === 'a').length,
    b: groups.filter(g => g.scope === 'b').length,
  };
  const groupCount = groups.length;
  groups = groups.slice(0, 600);

  cmp.running = false;
  return {
    a: { root: rootA, name: path.basename(rootA) || rootA, files: a.files.length, bytes: a.bytes, errors: a.errors, overlapBytes: overlapA, overlapFiles: overlapFilesA, withinWasted: withinWastedA },
    b: { root: rootB, name: path.basename(rootB) || rootB, files: b.files.length, bytes: b.bytes, errors: b.errors, overlapBytes: overlapB, overlapFiles: overlapFilesB, withinWasted: withinWastedB },
    groups, groupCount, scopeCounts, shown: groups.length,
  };
}

// ------------------------------------------------------- similar photos
//
// dHash (difference hash): decode with Electron's native image codec, shrink
// to 9×8 grayscale, compare horizontal neighbours → 64-bit fingerprint.
// Visually similar images (resized, re-exported, lightly edited) land within
// a small Hamming distance of each other.

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
const CFG = { photoMinBytes: 10 * 1024 };
const PHOTO_CAP = 30000;
const HAM_THRESHOLD = 6;

function pop32(x) {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}
const hamming = (a, b) => pop32((a.hi ^ b.hi) >>> 0) + pop32((a.lo ^ b.lo) >>> 0);

function dhashImage(img) {
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const bmp = img.resize({ width: 9, height: 8, quality: 'good' }).toBitmap();
  if (bmp.length < 9 * 8 * 4) return null;
  const gray = new Float32Array(72);
  for (let i = 0; i < 72; i++) {
    const o = i * 4; // BGRA
    gray[i] = 0.114 * bmp[o] + 0.587 * bmp[o + 1] + 0.299 * bmp[o + 2];
  }
  let hi = 0, lo = 0, bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++, bit++) {
      const i = y * 9 + x;
      const b = gray[i] > gray[i + 1] ? 1 : 0;
      if (bit < 32) hi = ((hi << 1) | b) >>> 0;
      else lo = ((lo << 1) | b) >>> 0;
    }
  }
  return { hi, lo, w: width, h: height };
}

async function findSimilarPhotos() {
  state.photoRunning = true;
  state.photoCancelled = false;

  let images = state.files.filter(f => PHOTO_EXTS.has(f.ext) && f.size >= CFG.photoMinBytes);
  let capped = false;
  if (images.length > PHOTO_CAP) {
    images = [...images].sort((a, b) => b.size - a.size).slice(0, PHOTO_CAP);
    capped = true;
  }

  const items = [];
  let done = 0, lastSent = 0;
  for (const f of images) {
    if (state.photoCancelled) { state.photoRunning = false; return null; }
    try {
      const h = dhashImage(nativeImage.createFromPath(f.path));
      if (h) items.push({ f, h });
    } catch { /* undecodable — skip */ }
    done++;
    const now = Date.now();
    if (now - lastSent > 120) { lastSent = now; send('photos:progress', { done, total: images.length }); }
    if (done % 8 === 0) await new Promise(r => setImmediate(r)); // keep IPC responsive
  }
  send('photos:progress', { done, total: images.length });

  // Candidate pairing: split each hash into 8 bytes — two hashes within
  // Hamming distance 7 must share at least one byte (pigeonhole), so we only
  // compare within shared-byte buckets instead of all N².
  const n = items.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const bandsOf = h => [
    h.hi >>> 24 & 255, h.hi >>> 16 & 255, h.hi >>> 8 & 255, h.hi & 255,
    h.lo >>> 24 & 255, h.lo >>> 16 & 255, h.lo >>> 8 & 255, h.lo & 255,
  ];
  const buckets = Array.from({ length: 8 }, () => new Map());
  const BUCKET_CAP = 2000; // degenerate buckets (e.g. thousands of near-blank images) get skipped
  for (let i = 0; i < n; i++) {
    const bs = bandsOf(items[i].h);
    for (let b = 0; b < 8; b++) {
      let arr = buckets[b].get(bs[b]);
      if (!arr) buckets[b].set(bs[b], arr = []);
      arr.push(i);
    }
  }
  const compared = new Set();
  for (let b = 0; b < 8; b++) {
    for (const arr of buckets[b].values()) {
      if (arr.length < 2 || arr.length > BUCKET_CAP) continue;
      for (let x = 0; x < arr.length; x++) {
        for (let y = x + 1; y < arr.length; y++) {
          const key = arr[x] * n + arr[y];
          if (compared.has(key)) continue;
          compared.add(key);
          if (hamming(items[arr[x]].h, items[arr[y]].h) <= HAM_THRESHOLD) union(arr[x], arr[y]);
        }
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, g = []);
    g.push(i);
  }
  let clusters = [];
  let id = 0;
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let maxD = 0;
    for (let x = 0; x < idxs.length && x < 12; x++)
      for (let y = x + 1; y < idxs.length && y < 12; y++)
        maxD = Math.max(maxD, hamming(items[idxs[x]].h, items[idxs[y]].h));
    const files = idxs
      .map(i => ({
        path: items[i].f.path, name: items[i].f.name, dir: path.dirname(items[i].f.path),
        size: items[i].f.size, mtime: items[i].f.mtime, w: items[i].h.w, h: items[i].h.h,
      }))
      .sort((a, b) => (b.w * b.h) - (a.w * a.h) || b.size - a.size); // best resolution first
    const bytes = files.reduce((s, f) => s + f.size, 0);
    clusters.push({ id: id++, files, count: files.length, bytes, savings: bytes - files[0].size, near: maxD <= 2 });
  }
  clusters.sort((a, b) => b.savings - a.savings);
  const totalSavings = clusters.reduce((s, c) => s + c.savings, 0);
  const clusterCount = clusters.length;
  clusters = clusters.slice(0, 300);

  state.similar = { clusters, clusterCount, totalSavings, scanned: images.length, capped };
  state.photoRunning = false;
  return state.similar;
}

// ------------------------------------------------------- changes (diff)

async function capturePrevSnapshot(root) {
  try {
    const meta = JSON.parse(await fsp.readFile(indexPaths().meta, 'utf8'));
    if (meta.v !== INDEX_VERSION || meta.root !== root) { state.prevSnapshot = null; return; }
    const payload = JSON.parse((await gunzip(await fsp.readFile(indexPaths().data))).toString());
    state.prevSnapshot = { savedAt: payload.savedAt, files: new Map(payload.files.map(([p, s]) => [p, s])) };
  } catch {
    state.prevSnapshot = null;
  }
}

function computeDiff() {
  if (!state.prevSnapshot || !state.rootNode) return null;
  const prev = state.prevSnapshot;
  const cur = new Map(state.files.map(f => [f.path, f.size]));

  const dirDelta = new Map();
  const bump = (p, d) => {
    let dir = path.dirname(p);
    while (true) {
      dirDelta.set(dir, (dirDelta.get(dir) || 0) + d);
      if (dir === state.root) break;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  };

  let addedBytes = 0, removedBytes = 0, grownBytes = 0, shrunkBytes = 0;
  const newFiles = [], deletedFiles = [], changedFiles = [];
  for (const [p, size] of cur) {
    const old = prev.files.get(p);
    if (old == null) { addedBytes += size; newFiles.push({ path: p, size }); bump(p, size); }
    else if (old !== size) {
      const d = size - old;
      if (d > 0) grownBytes += d; else shrunkBytes -= d;
      changedFiles.push({ path: p, delta: d, size });
      bump(p, d);
    }
  }
  for (const [p, size] of prev.files) {
    if (!cur.has(p)) { removedBytes += size; deletedFiles.push({ path: p, size }); bump(p, -size); }
  }

  const sep = process.platform === 'win32' ? '\\' : '/';
  const rootDepth = state.root.split(sep).length;
  const dirs = [...dirDelta.entries()]
    .filter(([p, d]) => d !== 0 && p !== state.root && p.split(sep).length <= rootDepth + 2)
    .map(([p, d]) => ({ path: p, name: path.basename(p), delta: d }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 15);

  const describe = f => ({ ...f, name: path.basename(f.path), dir: path.dirname(f.path) });
  return {
    prevAt: prev.savedAt,
    net: addedBytes + grownBytes - removedBytes - shrunkBytes,
    addedBytes, removedBytes, grownBytes, shrunkBytes,
    addedCount: newFiles.length,
    removedCount: deletedFiles.length,
    changedCount: changedFiles.length,
    dirs,
    newFiles: newFiles.sort((a, b) => b.size - a.size).slice(0, 20).map(describe),
    deletedFiles: deletedFiles.sort((a, b) => b.size - a.size).slice(0, 20).map(describe),
    grownFiles: changedFiles.filter(f => f.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 20).map(describe),
  };
}

// ------------------------------------------------------- index maintenance

function removeFromIndex(filePath) {
  const dir = path.dirname(filePath);
  const parent = state.dirIndex.get(dir);
  let size = 0;
  if (parent) {
    const idx = parent.children.findIndex(c => c.path === filePath);
    if (idx >= 0) {
      size = parent.children[idx].size;
      parent.children.splice(idx, 1);
    }
  }
  let d = dir;
  while (true) {
    const node = state.dirIndex.get(d);
    if (node) { node.size -= size; node.fileCount -= 1; }
    if (d === state.root) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('app:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Choose a folder to analyze',
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('app:quickFolders', () => {
  const home = os.homedir();
  const candidates = [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
    ['Downloads', path.join(home, 'Downloads')],
    ['Pictures', path.join(home, 'Pictures')],
    ['Movies', path.join(home, 'Movies')],
    ['Videos', path.join(home, 'Videos')],
    ['Music', path.join(home, 'Music')],
  ];
  const seen = new Set();
  const out = candidates
    .filter(([, p]) => { if (seen.has(p) || !fs.existsSync(p)) return false; seen.add(p); return true; })
    .map(([label, p]) => ({ label, path: p }));
  // Mounted volumes (external drives, network shares) as one-click targets.
  if (process.platform === 'darwin') {
    try {
      for (const ent of fs.readdirSync('/Volumes', { withFileTypes: true })) {
        if (ent.isSymbolicLink()) continue; // skip the boot-volume alias
        const p = path.join('/Volumes', ent.name);
        if (!seen.has(p)) { seen.add(p); out.push({ label: `⏏ ${ent.name}`, path: p }); }
      }
    } catch { /* /Volumes unreadable — skip */ }
  }
  return out;
});

ipcMain.handle('scan:start', async (_e, root) => {
  if (state.scanning) return { error: 'A scan is already running.' };
  try {
    await capturePrevSnapshot(root); // keep the old index of this root for the Changes view
    state.similar = null;
    const res = await runScan(root);
    if (!res.cancelled) saveIndex().catch(() => {});
    return res;
  } catch (err) {
    state.scanning = false;
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('photos:find', async () => {
  if (state.photoRunning) return { error: 'Photo analysis is already running.' };
  try {
    const res = await findSimilarPhotos();
    return res || { cancelled: true };
  } catch (err) {
    state.photoRunning = false;
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('photos:cancel', () => { state.photoCancelled = true; return true; });

ipcMain.handle('diff:get', () => computeDiff());

ipcMain.handle('compare:run', async (_e, rootA, rootB) => {
  if (cmp.running) return { error: 'A comparison is already running.' };
  try {
    const res = await compareRoots(rootA, rootB);
    return res || { cancelled: true };
  } catch (err) {
    cmp.running = false;
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('compare:cancel', () => { cmp.cancelled = true; return true; });

ipcMain.handle('org:plan', async (_e, folder, opts) => {
  try { return await buildOrganizePlan(folder, opts); }
  catch (err) { return { error: String(err.message || err) }; }
});

ipcMain.handle('org:apply', async (_e, folder, moves) => {
  try {
    if (!isAuthorized(folder)) return { error: 'Folder not authorized — preview it first.' };
    if (!Array.isArray(moves)) return { error: 'Invalid move list.' };
    for (const m of moves) {
      if (!isAuthorized(m.from) || path.dirname(m.from) !== folder) return { error: 'Move source outside the organized folder.' };
      if (typeof m.destDir !== 'string' || path.isAbsolute(m.destDir) || m.destDir.split(/[\\/]/).some(s => s === '..' || s === '')) {
        return { error: 'Invalid destination folder.' };
      }
    }
    const res = await applyOrganize(folder, moves);
    return { moved: res.moved.length, failed: res.failed };
  } catch (err) { return { error: String(err.message || err) }; }
});

ipcMain.handle('org:undo', async () => {
  try { return await undoOrganize(); }
  catch (err) { return { error: String(err.message || err) }; }
});

ipcMain.handle('index:info', async () => {
  try {
    const meta = JSON.parse(await fsp.readFile(indexPaths().meta, 'utf8'));
    return meta.v === INDEX_VERSION ? meta : null;
  } catch { return null; }
});

ipcMain.handle('index:load', async () => {
  try { return await loadIndex(); }
  catch (err) { return { error: String(err.message || err) }; }
});

ipcMain.handle('scan:cancel', () => { state.scanCancelled = true; return true; });

ipcMain.handle('data:overview', () => buildOverview());

ipcMain.handle('dir:node', (_e, dirPath) => {
  const node = state.dirIndex.get(dirPath);
  if (!node) return null;
  const LIMIT = 500;
  return {
    name: node.name,
    path: node.path,
    size: node.size,
    fileCount: node.fileCount,
    children: node.children.slice(0, LIMIT).map(c => ({
      name: c.name, path: c.path, size: c.size, isDir: c.isDir,
      fileCount: c.isDir ? c.fileCount : undefined,
      ext: c.ext, mtime: c.mtime,
      category: c.isDir ? undefined : categoryOf(c.ext, c.path),
    })),
    truncated: Math.max(0, node.children.length - LIMIT),
  };
});

ipcMain.handle('files:largest', (_e, opts = {}) => {
  const { limit = 100, category = null, query = '' } = opts;
  let list = state.files;
  if (category) list = list.filter(f => categoryOf(f.ext, f.path) === category);
  if (query) {
    const q = query.toLowerCase();
    list = list.filter(f => f.path.toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => b.size - a.size).slice(0, limit).map(fileInfo);
});

ipcMain.handle('dupes:find', async () => {
  if (state.dupeRunning) return { error: 'Duplicate analysis is already running.' };
  try {
    const res = await findDuplicates();
    return res || { cancelled: true };
  } catch (err) {
    state.dupeRunning = false;
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('dupes:cancel', () => { state.dupeCancelled = true; return true; });

// Meta of the last saved analysis, so the Duplicates view can offer to bring it
// back (with its cached hashes) instead of re-reading the whole volume.
ipcMain.handle('dupes:info', () => dupesInfo());

ipcMain.handle('dupes:load', async () => {
  try {
    const res = await loadDupesState();
    if (res && res.error) return res;
    return res;
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// ------------------------------------------------------------- trash helpers
//
// "Move to Trash" has to be honest on removable volumes: files on an external
// drive go to that drive's own Trash (<volume>/.Trashes/<uid>), which Finder
// often does not show, and the space is only reclaimed when that drive's Trash
// is emptied. So every move is verified, the destination is reported back, and
// emptying a drive's Trash is an explicit, separate action.

function volumeOf(p) {
  if (process.platform === 'win32') {
    const m = /^([A-Za-z]:\\)/.exec(p);
    return m ? m[1] : null;
  }
  const parts = p.split(path.sep);
  if (parts.length > 2 && parts[1] === 'Volumes') return path.join(path.sep, parts[1], parts[2]);
  return path.sep;
}

function volumeTrashDir(volume) {
  if (!volume) return null;
  if (process.platform === 'win32') return null; // Recycle Bin has no browsable path
  return path.join(volume, '.Trashes', String(process.getuid()));
}

// A volume is actionable if the user opened a folder on it (or below it).
function isAuthorizedVolume(volume) {
  if (!volume) return false;
  if (isAuthorized(volume)) return true;
  for (const r of authorizedRoots) {
    if (r === volume || r.startsWith(volume.endsWith(path.sep) ? volume : volume + path.sep)) return true;
  }
  return false;
}

async function dirStats(dir, cap = 200000) {
  let items = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      items++;
      if (items > cap) return { items, bytes, capped: true };
      try { bytes += (await fsp.stat(full)).size; } catch { /* gone already */ }
    }
  }
  return { items, bytes, capped: false };
}

const withTimeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_res, rej) => setTimeout(() => rej(new Error(message)), ms)),
]);

async function trashFiles(paths) {
  const trashed = [];
  const failed = [];
  const volumes = new Map(); // volume -> { trashed, bytes }
  if (!Array.isArray(paths)) return { trashed, failed, volumes: [] };
  state.trashCancelled = false;

  let done = 0;
  let lastSent = 0;
  for (const p of paths) {
    if (state.trashCancelled) { failed.push({ path: p, error: 'cancelled' }); continue; }
    if (!isAuthorized(p)) { failed.push({ path: p, error: 'outside authorized folders' }); continue; }
    let size = 0;
    try { size = (await fsp.stat(p)).size; } catch { /* size is only for the report */ }
    try {
      // Bound each move: a stalled filesystem must not freeze the whole run.
      await withTimeout(shell.trashItem(p), 30000, 'timed out moving to Trash');
      // Verify against the filesystem — never trust the call alone, or the UI
      // (and the index) would claim a delete that never happened.
      if (fs.existsSync(p)) throw new Error('file is still on disk after the Trash move was reported as successful');
      trashed.push(p);
      removeFromIndex(p);
      const vol = volumeOf(p);
      const v = volumes.get(vol) || { volume: vol, trashDir: volumeTrashDir(vol), files: 0, bytes: 0 };
      v.files++; v.bytes += size;
      volumes.set(vol, v);
    } catch (err) {
      failed.push({ path: p, error: String((err && err.message) || err) });
    }
    done++;
    const now = Date.now();
    if (now - lastSent > 100 || done === paths.length) {
      lastSent = now;
      send('trash:progress', { done, total: paths.length, trashed: trashed.length, failed: failed.length });
    }
  }
  return { trashed, failed, volumes: [...volumes.values()] };
}

// Move files to the Trash and fold the outcome into the session state. Only
// files verified as gone leave the index, so a failed move can never make the
// UI (or the saved analysis) claim a cleanup that did not happen.
async function trashAndUpdate(paths) {
  const { trashed, failed, volumes } = await trashFiles(paths);
  if (trashed.length) {
    const gone = new Set(trashed);
    state.files = state.files.filter(f => !gone.has(f.path));
    if (state.duplicates) {
      // Row lists per group are capped (MAX_GROUP_FILES), while count/wasted
      // are exact totals — so update totals by what left each set, not by how
      // many rows remain.
      const kept = [];
      for (const g of state.duplicates.groups) {
        const before = g.files.length;
        g.files = g.files.filter(f => !gone.has(f.path));
        if (before - g.files.length > 0) {
          g.count = Math.max(g.files.length, g.count - (before - g.files.length));
          g.more = Math.max(0, g.count - g.files.length);
          g.wasted = g.size * Math.max(0, g.count - 1);
        }
        if (g.count > 1) kept.push(g);
      }
      state.duplicates.groups = kept;
      state.duplicates.groupCount = state.duplicates.groups.length;
      state.duplicates.shown = state.duplicates.groups.length;
      state.duplicates.totalWasted = state.duplicates.groups.reduce((s, g) => s + g.wasted, 0);
    }
    if (state.similar) {
      state.similar.clusters = state.similar.clusters
        .map(c => ({ ...c, files: c.files.filter(f => !gone.has(f.path)) }))
        .filter(c => c.files.length > 1)
        .map(c => {
          const bytes = c.files.reduce((s, f) => s + f.size, 0);
          return { ...c, count: c.files.length, bytes, savings: bytes - c.files[0].size };
        });
      state.similar.clusterCount = state.similar.clusters.length;
      state.similar.totalSavings = state.similar.clusters.reduce((s, c) => s + c.savings, 0);
    }
    scheduleSaveIndex();
    scheduleSaveDupes(); // the analysis itself changed (groups lost copies)
  }
  return { trashed, failed, volumes };
}

ipcMain.handle('files:trash', (_e, paths) => trashAndUpdate(paths));

ipcMain.handle('trash:cancel', () => { state.trashCancelled = true; return true; });

// How much is sitting in a volume's own Trash (external drives keep their own),
// and whether we are allowed to look at it.
ipcMain.handle('trash:volumeInfo', async (_e, volume) => {
  try {
    if (!isAuthorizedVolume(volume)) return { error: 'Open a folder on that volume first.' };
    const dir = volumeTrashDir(volume);
    if (!dir) return { volume, trashDir: null, ok: false, error: 'This platform has no browsable Trash path.' };
    const st = await fsp.stat(dir).catch(() => null);
    if (!st) return { volume, trashDir: dir, ok: true, items: 0, bytes: 0, empty: true };
    const { items, bytes, capped } = await dirStats(dir);
    return { volume, trashDir: dir, ok: true, items, bytes, capped, empty: items === 0 };
  } catch (err) {
    return { volume, trashDir: volumeTrashDir(volume), ok: false, error: String((err && err.message) || err) };
  }
});

// Permanently empty a drive's Trash — the step that actually frees the space.
// Explicitly requested by the user (never automatic) and confirmed in the UI.
ipcMain.handle('trash:emptyVolume', async (_e, volume) => {
  try {
    if (!isAuthorizedVolume(volume)) return { error: 'Open a folder on that volume first.' };
    const dir = volumeTrashDir(volume);
    if (!dir) return { error: 'No browsable Trash for this platform.' };
    const before = await dirStats(dir);
    let entries;
    try { entries = await fsp.readdir(dir); }
    catch (err) {
      return {
        error: `macOS would not let Nebula read ${dir} (${(err && err.message) || err}). ` +
          'Empty it from Finder instead: click the Trash icon in the Dock while holding Option, ' +
          'then choose “Empty Trash” for this drive — or grant Nebula Full Disk Access in ' +
          'System Settings → Privacy & Security.',
        dir, freed: 0, items: 0,
      };
    }
    let removed = 0;
    const failed = [];
    for (const name of entries) {
      try { await fsp.rm(path.join(dir, name), { recursive: true, force: true }); removed++; }
      catch (err) { failed.push({ path: path.join(dir, name), error: String((err && err.message) || err) }); }
    }
    return { dir, items: before.items, bytes: before.bytes, removed, failed };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.handle('files:reveal', (_e, p) => {
  if (!isAuthorized(p)) return false;
  shell.showItemInFolder(p);
  return true;
});

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0a0c11',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  if (DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${path.basename(sourceId || '')}:${line})`);
    });
  }
}

// Lock down every web contents: no popups, no navigation away from the app,
// no permission grants (camera, geolocation, …) — the UI never needs any.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', e => e.preventDefault());
});

app.whenReady().then(() => {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  if (!process.env.NEBULA_NO_WINDOW) createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !process.env.NEBULA_NO_WINDOW) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Exposed for the headless test harness only.
module.exports.__test = {
  state, CFG, runScan, findDuplicates, findSimilarPhotos, compareRoots,
  saveIndex, loadIndex, capturePrevSnapshot, computeDiff, dhashImage, hamming,
  buildOrganizePlan, applyOrganize, undoOrganize,
  saveDupesState, loadDupesState, loadHashCache, dupesInfo, trashFiles, trashAndUpdate, volumeOf,
  volumeTrashDir, dirStats, cachedHash, rememberHash,
};
