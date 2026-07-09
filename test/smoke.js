// Headless engine test: run with  NEBULA_NO_WINDOW=1 electron test/smoke.js <workdir>
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const t = require('../main.js').__test;

const work = process.argv[2];

function makeBitmap(w, h, fn) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const [r, g, bl] = fn(x, y);
      b[o] = bl; b[o + 1] = g; b[o + 2] = r; b[o + 3] = 255; // BGRA
    }
  }
  return b;
}

app.whenReady().then(async () => {
  try {
    const dir = path.join(work, 'photodiff');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    // --- synthetic photos: two similar gradients + one noise image
    const W = 256, H = 256;
    const grad = makeBitmap(W, H, (x, y) => [x % 256, y % 256, 128]);
    const grad2 = makeBitmap(W, H, (x, y) => [Math.min(255, (x % 256) + 6), y % 256, 122]);
    const noise = makeBitmap(W, H, (x, y) => [(x * 73 + y * 151) % 256, (x * 31 + y * 17 * x) % 256, (x * y) % 256]);
    for (const [name, bmp] of [['a_grad.png', grad], ['b_grad_edit.png', grad2], ['c_noise.png', noise]]) {
      fs.writeFileSync(path.join(dir, name), nativeImage.createFromBitmap(bmp, { width: W, height: H }).toPNG());
    }
    fs.writeFileSync(path.join(dir, 'doc.txt'), 'hello world '.repeat(500));

    t.CFG.photoMinBytes = 100; // synthetic PNGs are small
    const scan1 = await t.runScan(dir);
    console.log('SCAN1 files=%d bytes=%d', scan1.fileCount, scan1.totalBytes);

    const sim = await t.findSimilarPhotos();
    console.log('SIMILAR clusters=%d', sim.clusterCount);
    for (const c of sim.clusters) console.log('  cluster:', c.files.map(f => f.name).join(' | '), 'near=', c.near);
    const c0 = sim.clusters[0];
    const okSim = sim.clusterCount === 1 &&
      c0.files.some(f => f.name === 'a_grad.png') &&
      c0.files.some(f => f.name === 'b_grad_edit.png') &&
      !c0.files.some(f => f.name === 'c_noise.png');
    console.log(okSim ? 'SIMILAR OK' : 'SIMILAR FAIL');

    // --- diff: save index, mutate tree, rescan, compute diff
    await t.saveIndex();
    fs.writeFileSync(path.join(dir, 'newbig.bin'), Buffer.alloc(50000, 7));         // added
    fs.rmSync(path.join(dir, 'c_noise.png'));                                        // deleted
    fs.appendFileSync(path.join(dir, 'doc.txt'), 'MORE '.repeat(2000));              // grown

    await t.capturePrevSnapshot(dir);
    await t.runScan(dir);
    const diff = t.computeDiff();
    console.log('DIFF net=%d added=%d removed=%d grown=%d newFiles=%s deleted=%s',
      diff.net, diff.addedBytes, diff.removedBytes, diff.grownBytes,
      diff.newFiles.map(f => f.name).join(','), diff.deletedFiles.map(f => f.name).join(','));
    const okDiff = diff.addedCount === 1 && diff.newFiles[0].name === 'newbig.bin' &&
      diff.removedCount === 1 && diff.deletedFiles[0].name === 'c_noise.png' &&
      diff.grownBytes === 10000 && diff.net === 50000 - diff.removedBytes + 10000;
    console.log(okDiff ? 'DIFF OK' : 'DIFF FAIL');

    // --- compare: two roots sharing one file's content
    const ca = path.join(work, 'cmpA'), cb = path.join(work, 'cmpB', 'nested');
    fs.rmSync(path.join(work, 'cmpA'), { recursive: true, force: true });
    fs.rmSync(path.join(work, 'cmpB'), { recursive: true, force: true });
    fs.mkdirSync(ca, { recursive: true });
    fs.mkdirSync(cb, { recursive: true });
    const shared = Buffer.alloc(200000, 42);
    fs.writeFileSync(path.join(ca, 'holiday.mp4'), shared);
    fs.writeFileSync(path.join(ca, 'only_a.bin'), Buffer.alloc(50000, 1));
    fs.writeFileSync(path.join(ca, 'only_a copy.bin'), Buffer.alloc(50000, 1)); // within-A duplicate
    fs.writeFileSync(path.join(cb, 'holiday backup.mp4'), shared);          // same content, different name
    fs.writeFileSync(path.join(cb, 'same_size_diff.bin'), Buffer.alloc(50000, 9)); // same size, different bytes
    const cmp = await t.compareRoots(path.join(work, 'cmpA'), path.join(work, 'cmpB'));
    console.log('COMPARE scopes=%j overlapA=%d overlapB=%d withinA=%d withinB=%d',
      cmp.scopeCounts, cmp.a.overlapBytes, cmp.b.overlapBytes, cmp.a.withinWasted, cmp.b.withinWasted);
    for (const g of cmp.groups) console.log('  set[%s]:', g.scope, g.files.map(f => `${f.side}:${f.name}`).join(' | '), 'verified=', g.verified);
    const cross = cmp.groups.find(g => g.scope === 'cross');
    const okCmp = cmp.scopeCounts.cross === 1 && cmp.scopeCounts.a === 1 && cmp.scopeCounts.b === 0 &&
      cmp.a.overlapBytes === 200000 && cmp.b.overlapBytes === 200000 &&
      cmp.a.withinWasted === 50000 && cmp.b.withinWasted === 0 &&
      cross.files.some(f => f.side === 'A' && f.name === 'holiday.mp4') &&
      cross.files.some(f => f.side === 'B' && f.name === 'holiday backup.mp4') &&
      cross.verified === true;
    console.log(okCmp ? 'COMPARE OK' : 'COMPARE FAIL');

    // --- organize: plan → apply → undo round-trip
    const org = path.join(work, 'orgdir');
    fs.rmSync(org, { recursive: true, force: true });
    fs.mkdirSync(path.join(org, 'existing sub'), { recursive: true });
    fs.writeFileSync(path.join(org, 'Screenshot 2026-07-01 at 09.15.02.png'), Buffer.alloc(2000, 3));
    fs.writeFileSync(path.join(org, 'IMG_4412.jpg'), Buffer.alloc(3000, 4));
    fs.writeFileSync(path.join(org, 'setup-things.dmg'), Buffer.alloc(4000, 5));
    fs.writeFileSync(path.join(org, 'taxes 2025.pdf'), Buffer.alloc(1500, 6));
    fs.writeFileSync(path.join(org, 'song.mp3'), Buffer.alloc(2500, 7));
    fs.writeFileSync(path.join(org, 'mystery.xyz'), Buffer.alloc(500, 8));           // no rule → stays
    fs.writeFileSync(path.join(org, 'existing sub', 'inside.pdf'), Buffer.alloc(100)); // in subfolder → untouched
    const plan = await t.buildOrganizePlan(org, { byYear: false });
    console.log('ORG plan:', plan.moves.map(m => `${m.name} -> ${m.destDir}`).join(' | '), 'staying=', plan.staying);
    const dest = n => (plan.moves.find(m => m.name === n) || {}).destDir;
    const okPlan = dest('Screenshot 2026-07-01 at 09.15.02.png') === 'Screenshots' &&
      dest('IMG_4412.jpg') === 'Photos' && dest('setup-things.dmg') === 'Installers' &&
      dest('taxes 2025.pdf') === 'Documents' && dest('song.mp3') === 'Music' &&
      plan.staying === 1 && plan.moves.length === 5;
    const applied = await t.applyOrganize(org, plan.moves);
    const okApply = applied.moved.length === 5 && applied.failed.length === 0 &&
      fs.existsSync(path.join(org, 'Screenshots', 'Screenshot 2026-07-01 at 09.15.02.png')) &&
      fs.existsSync(path.join(org, 'Documents', 'taxes 2025.pdf')) &&
      fs.existsSync(path.join(org, 'mystery.xyz')) &&
      fs.existsSync(path.join(org, 'existing sub', 'inside.pdf'));
    const undone = await t.undoOrganize();
    const okUndo = undone.restored === 5 &&
      fs.existsSync(path.join(org, 'IMG_4412.jpg')) &&
      fs.existsSync(path.join(org, 'song.mp3')) &&
      !fs.existsSync(path.join(org, 'Screenshots'));
    console.log('ORG apply=%s undo=%s', okApply, okUndo);
    console.log(okPlan && okApply && okUndo ? 'ORGANIZE OK' : 'ORGANIZE FAIL');

    app.exit(okSim && okDiff && okCmp && okPlan && okApply && okUndo ? 0 : 1);
  } catch (e) {
    console.error('FAIL', e);
    app.exit(1);
  }
});
