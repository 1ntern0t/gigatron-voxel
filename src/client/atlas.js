// Procedural texture atlas: every tile is painted with code at startup (no image assets).
import { TILE_NAMES, ATLAS_GRID } from '../core/blocks.js';
import { mulberry32 } from '../core/rng.js';

const T = 16;

const PAINTERS = {
  bedrock: (p) => p.noise([18, 16, 26], 14).specks([60, 40, 90], 0.05),
  stone: (p) => p.noise([84, 92, 112], 16).cracks([54, 60, 78], 3),
  soil: (p) => p.noise([78, 58, 86], 14).specks([110, 84, 120], 0.08),
  turf_top: (p) => p.noise([16, 70, 72], 18).grid([40, 255, 210], 0.35).specks([140, 255, 240], 0.05),
  turf_side: (p) => p.noise([78, 58, 86], 14).band(0, 4, [16, 80, 82], 12).drips([40, 230, 200], 5),
  circuit: (p) => p.noise([70, 46, 30], 12).traces([255, 170, 60], 4).pads([255, 220, 120], 3),
  crystal: (p) => p.noise([200, 60, 220], 26).facets([255, 170, 255], [120, 20, 160]).specks([255, 255, 255], 0.06),
  fluid: (p) => p.noise([20, 120, 210], 20).stream([120, 240, 255], 0.5),
  sand: (p) => p.noise([168, 172, 190], 14).specks([220, 230, 255], 0.08),
  chrome: (p) => p.gradient([210, 220, 232], [120, 130, 148]).frame([235, 245, 255], [70, 80, 96]).rivets([60, 70, 80]),
  alloy: (p) => p.noise([16, 18, 22], 8).frame([46, 52, 62], [6, 6, 8]).hline(8, [0, 220, 255], 0.5),
  core: (p) => p.radial([255, 255, 255], [0, 230, 255], [0, 70, 120]),
  glass: (p) => p.fill([120, 220, 255, 40]).frame([170, 245, 255, 220], [60, 160, 220, 200]).diag([230, 255, 255, 110]),
  moss_top: (p) => p.noise([60, 170, 120], 20).specks([180, 255, 210], 0.1),
  moss_side: (p) => p.noise([94, 110, 150], 14).band(0, 3, [60, 170, 120], 16),
  aether: (p) => p.noise([94, 110, 150], 14).cracks([140, 160, 210], 2),
  wire: (p) => p.noise([30, 34, 40], 6).cross([90, 30, 30], 3).cross([150, 60, 50], 1),
  wire_on: (p) => p.noise([30, 34, 40], 6).cross([255, 60, 60], 3).cross([255, 220, 200], 1),
  node: (p) => p.frame([40, 44, 52], [20, 22, 26]).radial([255, 255, 200], [255, 190, 40], [80, 40, 10], 5),
  switch_off: (p) => p.noise([40, 44, 52], 6).frame([70, 76, 88], [20, 22, 26]).rect(5, 3, 6, 10, [90, 30, 30]).rect(6, 9, 4, 3, [200, 200, 210]),
  switch_on: (p) => p.noise([40, 44, 52], 6).frame([70, 76, 88], [20, 22, 26]).rect(5, 3, 6, 10, [40, 220, 120]).rect(6, 4, 4, 3, [240, 255, 240]),
  lamp_off: (p) => p.frame([60, 64, 74], [24, 26, 30]).rect(3, 3, 10, 10, [60, 70, 90]).grid([40, 46, 60], 1),
  lamp_on: (p) => p.frame([200, 220, 230], [80, 100, 110]).radial([255, 255, 255], [200, 250, 255], [90, 200, 255], 6),
  door: (p) => p.noise([30, 30, 40], 8).frame([100, 70, 200], [30, 20, 60]).hline(5, [150, 110, 255], 1).hline(10, [150, 110, 255], 1),
  door_open: (p) => p.fill([120, 90, 255, 30]).frame([170, 140, 255, 200], [90, 60, 200, 180]),
  not: (p) => p.noise([40, 36, 52], 6).frame([80, 70, 110], [20, 18, 30]).tri([150, 120, 200]),
  not_on: (p) => p.noise([40, 36, 52], 6).frame([200, 160, 255], [60, 40, 90]).tri([255, 220, 255]),
  hub_side: (p) => p.gradient([60, 70, 90], [20, 24, 30]).frame([0, 230, 255], [0, 80, 110]).hex([0, 255, 220]),
  hub_top: (p) => p.fill([20, 24, 30]).radial([200, 255, 255], [0, 220, 255], [10, 30, 40], 7).frame([0, 230, 255], [0, 80, 110]),
  fiber_side: (p) => p.noise([50, 40, 70], 10).vlines([120, 80, 220], 4),
  fiber_top: (p) => p.noise([50, 40, 70], 10).radial([200, 160, 255], [120, 80, 220], [50, 40, 70], 4),
  leaf: (p) => p.noise([30, 150, 170], 30).specks([180, 255, 255], 0.12).specks([255, 120, 255], 0.03),
  beacon: (p) => p.radial([255, 255, 255], [120, 255, 255], [0, 140, 200]),
  drone_pod: (p) => p.fill([0, 0, 0, 0]).rect(3, 4, 10, 8, [190, 200, 215]).rect(4, 5, 8, 6, [20, 22, 28]).rect(6, 7, 4, 2, [0, 240, 255]).rect(1, 6, 2, 1, [150, 160, 175]).rect(13, 6, 2, 1, [150, 160, 175]),
};

function painter(ctx, ox, oy, rand) {
  const img = ctx.getImageData(ox, oy, T, T);
  const d = img.data;
  const set = (x, y, c, a = c[3] ?? 255) => {
    if (x < 0 || y < 0 || x >= T || y >= T) return;
    const i = (y * T + x) * 4;
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = a;
  };
  const blend = (x, y, c, t) => {
    const i = (y * T + x) * 4;
    d[i] = d[i] + (c[0] - d[i]) * t;
    d[i + 1] = d[i + 1] + (c[1] - d[i + 1]) * t;
    d[i + 2] = d[i + 2] + (c[2] - d[i + 2]) * t;
    if (c[3] !== undefined) d[i + 3] = c[3];
  };
  const api = {
    fill(c) { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, c); return api; },
    noise(c, v) {
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        const n = (rand() - 0.5) * 2 * v;
        set(x, y, [c[0] + n, c[1] + n, c[2] + n]);
      }
      return api;
    },
    specks(c, p) { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (rand() < p) set(x, y, c); return api; },
    cracks(c, n) {
      for (let k = 0; k < n; k++) {
        let x = Math.floor(rand() * T);
        let y = Math.floor(rand() * T);
        for (let s = 0; s < 6; s++) { set(x, y, c); x += Math.round(rand() * 2 - 1); y += 1; }
      }
      return api;
    },
    grid(c, t) {
      for (let i = 0; i < T; i++) { blend(i, 0, c, t); blend(0, i, c, t); blend(i, 8, c, t * 0.6); blend(8, i, c, t * 0.6); }
      return api;
    },
    band(y0, h, c, v) {
      for (let y = y0; y < y0 + h; y++) for (let x = 0; x < T; x++) { const n = (rand() - 0.5) * v; set(x, y, [c[0] + n, c[1] + n, c[2] + n]); }
      return api;
    },
    drips(c, n) { for (let k = 0; k < n; k++) { const x = Math.floor(rand() * T); const len = 1 + Math.floor(rand() * 4); for (let y = 3; y < 3 + len; y++) set(x, y, c); } return api; },
    traces(c, n) {
      for (let k = 0; k < n; k++) {
        let x = Math.floor(rand() * T);
        let y = Math.floor(rand() * T);
        const horiz = rand() < 0.5;
        for (let s = 0; s < 10; s++) {
          set(x, y, c);
          if (horiz) x = (x + 1) % T; else y = (y + 1) % T;
          if (s === 5) { if (horiz) y = (y + 1) % T; else x = (x + 1) % T; }
        }
      }
      return api;
    },
    pads(c, n) { for (let k = 0; k < n; k++) { const x = 1 + Math.floor(rand() * 13); const y = 1 + Math.floor(rand() * 13); set(x, y, c); set(x + 1, y, c); set(x, y + 1, c); set(x + 1, y + 1, c); } return api; },
    facets(hi, lo) {
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        const f = ((x + y) % 8 < 2) ? hi : ((x - y + 16) % 8 < 1 ? lo : null);
        if (f) blend(x, y, f, 0.7);
      }
      return api;
    },
    stream(c, t) { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if ((x * 3 + y * 7) % 11 === 0 || rand() < 0.04) blend(x, y, c, t); return api; },
    gradient(a, b) {
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        const t = (x + y) / (2 * T);
        const n = (rand() - 0.5) * 6;
        set(x, y, [a[0] + (b[0] - a[0]) * t + n, a[1] + (b[1] - a[1]) * t + n, a[2] + (b[2] - a[2]) * t + n]);
      }
      return api;
    },
    frame(light, dark) {
      for (let i = 0; i < T; i++) { set(i, 0, light); set(0, i, light); set(i, T - 1, dark); set(T - 1, i, dark); }
      return api;
    },
    rivets(c) { set(2, 2, c); set(13, 2, c); set(2, 13, c); set(13, 13, c); return api; },
    hline(y, c, t) { for (let x = 1; x < T - 1; x++) blend(x, y, c, t); return api; },
    vlines(c, step) { for (let x = 1; x < T; x += step) for (let y = 0; y < T; y++) blend(x, y, c, 0.6); return api; },
    radial(inner, mid, outer, r = 8) {
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        const dd = Math.hypot(x - 7.5, y - 7.5) / r;
        if (r < 8 && dd > 1) continue;
        const c = dd < 0.4 ? inner : dd < 0.8 ? mid : outer;
        set(x, y, c);
      }
      return api;
    },
    diag(c) { for (let i = 2; i < 7; i++) set(i, i - 1, c); for (let i = 9; i < 13; i++) set(i, i - 4, c); return api; },
    cross(c, w) {
      const a = 8 - Math.ceil(w / 2);
      for (let i = 0; i < T; i++) for (let k = 0; k < w; k++) { set(i, a + k, c); set(a + k, i, c); }
      return api;
    },
    rect(x0, y0, w, h, c) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c); return api; },
    tri(c) { for (let y = 4; y < 12; y++) { const half = Math.floor((y - 4) / 2); for (let x = 8 - half; x <= 8 + half; x++) set(x, y, c); } set(8, 2, c); return api; },
    hex(c) { for (let a = 0; a < 6; a++) { const ang = (a / 6) * Math.PI * 2; set(Math.round(7.5 + Math.cos(ang) * 4), Math.round(7.5 + Math.sin(ang) * 4), c); } set(7, 7, c); set(8, 8, c); set(7, 8, c); set(8, 7, c); return api; },
    commit() { ctx.putImageData(img, ox, oy); },
  };
  return api;
}

export function createAtlasCanvas() {
  const size = ATLAS_GRID * T;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  TILE_NAMES.forEach((name, i) => {
    const ox = (i % ATLAS_GRID) * T;
    const oy = Math.floor(i / ATLAS_GRID) * T;
    const p = painter(ctx, ox, oy, mulberry32(1000 + i * 7919));
    p.fill([0, 0, 0, 255]);
    (PAINTERS[name] ?? PAINTERS.stone)(p);
    p.commit();
  });
  return canvas;
}

// Small icon canvas for HUD slots.
export function tileIcon(atlasCanvas, tile, size = 32) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlasCanvas, (tile % ATLAS_GRID) * T, Math.floor(tile / ATLAS_GRID) * T, T, T, 0, 0, size, size);
  return c.toDataURL();
}
