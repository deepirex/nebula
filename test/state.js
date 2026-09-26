// Headless tests for the big-volume fixes:
//  1. analysis + hash cache persist and are reused (no re-reading unchanged files)
//  2. cached hashes are invalidated when a file changes
//  3. trashing verifies each move, reports failures honestly and never corrupts
//     the analysis state when a move fails
//  4. per-volume Trash reporting (where files actually went)
// Run: NEBULA_NO_WINDOW=1 ELECTRON_DISABLE_SANDBOX=1 electron test/state.js <workdir>
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const work = process.argv[2] || '/tmp/nebula-state-test';
app.setPath('userData', path.join(work, 'userdata'));
const t = require('../main.js').__test;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function buildTree() {
  const dir = path.join(work, 'tree');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  const big = Buffer.alloc(300000, 5);   // > QUICK_BYTES → exercises the full-hash pass
  const small = Buffer.alloc(4096, 7);   // ≤ QUICK_BYTES → quick hash is the verification
  fs.writeFileSync(path.join(dir, 'a', 'one.bin'), big);
  fs.writeFileSync(path.join(dir, 'b', 'one-copy.bin'), big);
  fs.writeFileSync(path.join(dir, 'a', 'two.bin'), small);
  fs.writeFileSync(path.join(dir, 'b', 'two-copy.bin'), small);
  fs.writeFileSync(path.join(dir, 'unique.bin'), Buffer.alloc(12345, 9));
  return dir;
}

app.whenReady().then(async () => {
  try {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const dir = buildTree();

    // ---- 1. first analysis: nothing cached
    let scan = await t.runScan(dir);
    check('scan finds all files', scan.fileCount === 5, `fileCount=${scan.fileCount}`);
    let res = await t.findDuplicates();
    check('first run finds 2 duplicate sets', res.groupCount === 2, `groupCount=${res.groupCount}`);
    check('first run reused no hashes', res.cachedHashes === 0, `cachedHashes=${res.cachedHashes}`);

    // ---- 2. state is persisted and comes back without re-hashing
    await t.saveIndex();
    await t.saveDupesState();
    const meta = await t.dupesInfo();
    check('saved meta exists for the root', meta && meta.root === dir, JSON.stringify(meta && { root: meta.root, groupCount: meta.groupCount }));
    check('saved meta records the reclaimed total', meta.totalWasted === res.totalWasted, `meta=${meta.totalWasted} res=${res.totalWasted}`);

    // simulate a restart: drop in-memory state, then restore from disk
    const before = { groupCount: res.groupCount, totalWasted: res.totalWasted };
    t.state.root = null;
    t.state.rootNode = null;
    t.state.files = [];
    t.state.dirIndex = new Map();
    t.state.duplicates = null;
    t.state.hashCache = new Map();
    t.state.hashCacheRoot = null;
    await t.loadIndex();
    const restored = await t.loadDupesState();
    check('saved analysis restores', !restored.error && restored.groupCount === before.groupCount && restored.totalWasted === before.totalWasted,
      restored.error || `groupCount=${restored.groupCount} wasted=${restored.totalWasted}`);
    check('restored result is flagged', restored.restored === true);
    t.state.duplicates = null; // make the next run analyze for real

    // ---- 3. second analysis reuses the cache instead of re-reading files
    res = await t.findDuplicates();
    check('second run reuses cached fingerprints', res.cachedHashes >= res.candidates && res.candidates > 0,
      `cached=${res.cachedHashes} candidates=${res.candidates}`);
    check('second run finds the same sets', res.groupCount === 2 && res.totalWasted === before.totalWasted,
      `groupCount=${res.groupCount} wasted=${res.totalWasted}`);

    // ---- 4. a cached run must not need to read the files at all
    const unreadable = path.join(dir, 'b', 'one-copy.bin');
    fs.chmodSync(unreadable, 0o000);
    res = await t.findDuplicates();
    const stillGrouped = res.groups.some(g => g.files.some(f => f.name === 'one-copy.bin'));
    check('unchanged file served from cache even when unreadable', stillGrouped);
    fs.chmodSync(unreadable, 0o644);

    // ---- 5. changing a file invalidates its cached hash
    fs.appendFileSync(path.join(dir, 'b', 'two-copy.bin'), 'CHANGED');
    await t.runScan(dir);
    res = await t.findDuplicates();
    const smallGroup = res.groups.find(g => g.size === 4096);
    check('changed file drops out of its duplicate set', !smallGroup, smallGroup ? `still grouped (count=${smallGroup.count})` : 'gone as expected');
    check('unchanged big file still cached', res.groups.some(g => g.size === 300000), JSON.stringify(res.groups.map(g => g.size)));

    // ---- 6. trash: honest failures, no state corruption
    const goneFile = path.join(dir, 'a', 'one.bin');
    const outsideFile = path.join(os_tmp(), 'nebula-outside.txt');
    fs.writeFileSync(outsideFile, 'x');
    const missingFile = path.join(dir, 'does-not-exist.bin');

    const dupBefore = t.state.duplicates;
    const filesBefore = t.state.files.length;
    const bigGroupsBefore = dupBefore.groups.filter(g => g.size === 300000).length;
    const out = await t.trashAndUpdate([outsideFile, missingFile]);
    check('unauthorized path is refused', out.failed.some(f => f.error === 'outside authorized folders'),
      JSON.stringify(out.failed.map(f => f.error)));
    check('missing file is reported as failed', out.failed.length === 2, `failed=${out.failed.length}`);
    check('failed moves leave the analysis untouched', t.state.duplicates === dupBefore &&
      t.state.duplicates.groups.filter(g => g.size === 300000).length === bigGroupsBefore);
    check('failed moves remove nothing from the index', t.state.files.length === filesBefore,
      `files=${t.state.files.length} before=${filesBefore}`);
    check('nothing was reported as trashed', out.trashed.length === 0, `trashed=${out.trashed.length}`);
    fs.rmSync(outsideFile, { force: true });

    // ---- 7. volume + Trash-path reporting
    const vol = t.volumeOf(goneFile);
    const trashDir = t.volumeTrashDir(vol);
    const uid = String(process.getuid());
    check('volume detected for a path', typeof vol === 'string' && vol.length > 0, `volume=${vol}`);
    check('boot volume points at ~/.Trash', process.platform === 'win32' ? trashDir === null : trashDir === path.join(require('os').homedir(), '.Trash'),
      `trashDir=${trashDir}`);
    check('external volume points at its own .Trashes/<uid>', t.volumeTrashDir('/Volumes/Intel') === path.join('/Volumes/Intel', '.Trashes', uid),
      `trashDir=${t.volumeTrashDir('/Volumes/Intel')}`);

    // an unreadable Trash must never be reported as empty
    const locked = path.join(work, 'locked-trash');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'hidden.bin'), 'x');
    fs.chmodSync(locked, 0o000);
    const stats = await t.dirStats(locked);
    check('unreadable Trash is flagged, not counted as empty', stats.unreadable === 1 && stats.items === 0,
      JSON.stringify(stats));
    fs.chmodSync(locked, 0o755);

    // ---- 8. drive-local Nebula Trash (non-boot volumes)
    // Stand in for an external drive with a volume resolver.
    const volDir = path.join(work, 'FAKEVOL');
    fs.mkdirSync(path.join(volDir, 'photos', 'trip'), { recursive: true });
    fs.mkdirSync(path.join(volDir, 'music'), { recursive: true });
    const f1 = path.join(volDir, 'photos', 'trip', 'a.jpg');
    const f2 = path.join(volDir, 'music', 'b.mp3');
    fs.writeFileSync(f1, Buffer.alloc(1000, 1));
    fs.writeFileSync(f2, Buffer.alloc(2000, 2));
    t.setVolumeResolver(p => (p.startsWith(volDir) ? volDir : t.volumeOf(p)));

    check('external volume uses the Nebula Trash mode', t.useNebulaTrash(volDir) === true);
    const volScan = await t.runScan(volDir); // opening a folder authorizes it, as in the app
    check('fake volume scans normally', volScan.fileCount === 2, `fileCount=${volScan.fileCount}`);

    const routed = await t.trashAndUpdate([f1, f2]);
    check('files move into the drive-local folder', routed.trashed.length === 2 && routed.failed.length === 0 &&
      !fs.existsSync(f1) && !fs.existsSync(f2), JSON.stringify(routed.failed));
    const dest = (routed.destinations || [])[0] || {};
    check('destination reports Nebula Trash mode', dest.mode === 'nebula' && dest.dir && dest.dir.startsWith(t.nebulaTrashRoot(volDir)),
      JSON.stringify(dest));
    check('relative layout is preserved inside the Trash folder',
      fs.existsSync(path.join(dest.dir, 'photos', 'trip', 'a.jpg')) && fs.existsSync(path.join(dest.dir, 'music', 'b.mp3')));

    // the Trash folder must never be scanned (removed copies cannot reappear as duplicates)
    fs.writeFileSync(path.join(volDir, 'photos', 'trip', 'a-copy.jpg'), Buffer.alloc(1000, 1));
    await t.runScan(volDir);
    const scanned = t.state.files.map(f => f.path);
    check('Nebula Trash is excluded from scans, new files are not',
      !scanned.some(p => p.includes(t.NEBULA_TRASH_NAME)) && scanned.some(p => p.endsWith('a-copy.jpg')),
      `indexed=${scanned.length}`);

    // sessions + sizes are reported for the UI
    let info = await t.trashInfo(volDir);
    check('trash info lists the session with size', info.mode === 'nebula' && info.files === 2 && info.bytes === 3000 && info.sessions.length === 1,
      JSON.stringify({ mode: info.mode, files: info.files, bytes: info.bytes, sessions: info.sessions.length }));

    // restore puts them back exactly, without overwriting an occupied path
    fs.writeFileSync(f1, Buffer.alloc(555, 9)); // something new now lives at the original path
    const rest = await t.restoreNebulaTrash(volDir, null);
    check('restore returns files to their original folders', rest.restored.length === 2 && fs.existsSync(f2), JSON.stringify(rest.failed));
    check('restore never overwrites an occupied path', fs.readFileSync(f1).length === 555 && rest.restored.some(p => p !== f1 && p.startsWith(path.dirname(f1))),
      `restored=${JSON.stringify(rest.restored)}`);
    info = await t.trashInfo(volDir);
    check('emptied-out Trash reports nothing left', info.files === 0, JSON.stringify(info.sessions));

    // empty frees the space and reports it
    await t.trashAndUpdate([f2]);
    const before2 = (await t.trashInfo(volDir)).bytes;
    const emptied = await t.emptyNebulaTrash(volDir, null);
    check('empty reports the freed bytes and removes the folder', emptied.removed === 1 && emptied.bytes === before2 && !fs.existsSync(t.nebulaTrashRoot(volDir)),
      JSON.stringify(emptied));
    t.setVolumeResolver(null);

    console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL STATE/TRASH CHECKS PASSED');
    app.exit(failures ? 1 : 0);
  } catch (e) {
    console.error('FAIL', e && e.stack || e);
    app.exit(1);
  }
});

function os_tmp() { return require('os').tmpdir(); }
