// Generates build/icon.png (1024×1024): dark squircle, aurora glow, Nebula orb + ring.
// Run: NEBULA_NO_WINDOW=1 electron build/make-icon.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SZ = 1024;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));

// signed distance to a rounded rectangle centered at origin
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r;
}

app.whenReady().then(() => {
  const buf = Buffer.alloc(SZ * SZ * 4);
  const cx = SZ / 2, cy = SZ / 2;
  const margin = 60;                 // transparent border around the squircle
  const half = SZ / 2 - margin;
  const corner = 210;

  const bgTop = [22, 26, 36], bgBot = [9, 11, 16];
  const glowA = [66, 84, 176];       // violet aurora, upper left
  const glowB = [36, 96, 158];       // blue aurora, lower right
  const orbA = [74, 168, 255], orbB = [144, 133, 233];

  const ringAngle = -0.48;           // tilt of the orbital ring
  const cosA = Math.cos(ringAngle), sinA = Math.sin(ringAngle);

  for (let y = 0; y < SZ; y++) {
    for (let x = 0; x < SZ; x++) {
      const o = (y * SZ + x) * 4;
      const px = x - cx, py = y - cy;
      const d = sdRoundRect(px, py, half, half, corner);
      const shapeAlpha = clamp(0.5 - d, 0, 1); // 1px antialiased edge
      if (shapeAlpha <= 0) continue;

      // background: vertical gradient + two soft radial glows
      let c = mix(bgTop, bgBot, y / SZ);
      const gA = Math.exp(-(((x - SZ * 0.28) ** 2 + (y - SZ * 0.24) ** 2) / (2 * (SZ * 0.34) ** 2)));
      const gB = Math.exp(-(((x - SZ * 0.76) ** 2 + (y - SZ * 0.82) ** 2) / (2 * (SZ * 0.36) ** 2)));
      c = c.map((v, i) => v + glowA[i] * gA * 0.35 + glowB[i] * gB * 0.30);

      // subtle star field (deterministic hash)
      const h = ((x * 2654435761 ^ y * 40503) >>> 0) % 10000;
      if (h < 6 && Math.hypot(px, py) > 260) c = c.map(v => v + 110);

      // orbital ring (tilted ellipse band) — drawn behind the orb's top half
      const rx = px * cosA - py * sinA;
      const ry = px * sinA + py * cosA;
      const e = Math.hypot(rx / 1.0, ry / 0.34);
      const ringDist = Math.abs(e - 392);
      const ringT = clamp(1 - ringDist / 16, 0, 1);
      const behindOrb = ry < 0; // upper half of tilted plane passes behind

      const orbR = 300;
      const dist = Math.hypot(px, py - 8);
      const inOrb = dist < orbR;

      if (ringT > 0 && (!inOrb || !behindOrb)) {
        const ringC = mix(orbA, orbB, clamp((rx + 400) / 800, 0, 1)).map(v => v * 0.95 + 30);
        c = c.map((v, i) => lerp(v, ringC[i], ringT * 0.9));
      }

      // orb with soft glow halo
      const halo = Math.exp(-((dist - orbR) ** 2) / (2 * 60 ** 2));
      if (!inOrb && dist > orbR) c = c.map((v, i) => v + mix(orbA, orbB, 0.5)[i] * halo * 0.35);
      if (inOrb) {
        const t = clamp(dist / orbR, 0, 1);
        // light source upper-left
        const lx = (px + orbR * 0.45) / orbR, ly = (py + orbR * 0.5) / orbR;
        const light = clamp(1.25 - Math.hypot(lx, ly) * 0.75, 0.35, 1.35);
        let oc = mix(orbA, orbB, clamp(t * 0.6 + (px + py) / (orbR * 4) + 0.35, 0, 1));
        oc = oc.map(v => clamp(v * light, 0, 255));
        const edge = clamp((orbR - dist) / 3, 0, 1); // antialias orb edge
        c = c.map((v, i) => lerp(v, oc[i], edge));
      }

      buf[o] = clamp(Math.round(c[2]), 0, 255);     // B
      buf[o + 1] = clamp(Math.round(c[1]), 0, 255); // G
      buf[o + 2] = clamp(Math.round(c[0]), 0, 255); // R
      buf[o + 3] = Math.round(shapeAlpha * 255);    // A
    }
  }

  const img = nativeImage.createFromBitmap(buf, { width: SZ, height: SZ });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  console.log('icon.png written');
  app.exit(0);
});
