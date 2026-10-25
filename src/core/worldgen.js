// Deterministic procedural world generation. Same seed + chunk coords => identical bytes.
import { CHUNK, HEIGHT, SEA, CHUNK_VOLUME, localIndex } from './constants.js';
import { B } from './blocks.js';
import { createNoise2D, fbm2, smoothstep, lerp } from './noise.js';
import { mulberry32, hash2, hash3 } from './rng.js';

export const BIOMES = Object.freeze({
  PLAINS: 'Neon Crystal Plains',
  RIVER: 'Data-Stream River',
  CANYON: 'Circuit Canyons',
  SKY: 'Floating Sky Islands',
});

const BEACON_RADIUS = 9;
const TREE_MARGIN = 3;

export function createWorldGen(seed) {
  const s = seed >>> 0;
  const nHeight = createNoise2D(s + 1);
  const nDetail = createNoise2D(s + 2);
  const nTemp = createNoise2D(s + 3);
  const nMoist = createNoise2D(s + 4);
  const nRiver = createNoise2D(s + 5);
  const nCanyon = createNoise2D(s + 6);
  const nIsle = createNoise2D(s + 7);
  const nIsle2 = createNoise2D(s + 8);

  function climate(x, z) {
    const t = fbm2(nTemp, x / 700, z / 700, 3);
    const m = fbm2(nMoist, x / 650, z / 650, 3);
    return [smoothstep(0.12, 0.32, t), smoothstep(0.15, 0.35, m)];
  }

  // Raw terrain column (ignores the beacon platform).
  function rawColumn(x, z) {
    const [canyonF, skyF] = climate(x, z);
    const plainsH = SEA + 4 + 5 * fbm2(nHeight, x / 140, z / 140, 4) + 1.5 * nDetail(x / 40, z / 40);
    let canyonH = SEA + 20 + 10 * fbm2(nHeight, x / 200, z / 200, 3);
    canyonH = Math.floor(canyonH / 4) * 4 + (canyonH % 4) * 0.25;
    const ridge = 1 - Math.abs(fbm2(nCanyon, x / 110, z / 110, 2));
    canyonH = lerp(canyonH, SEA - 3, smoothstep(0.86, 0.95, ridge));
    let h = lerp(plainsH, canyonH, canyonF);
    const rv = Math.abs(fbm2(nRiver, x / 260, z / 260, 2));
    const riverF = 1 - smoothstep(0.025, 0.06, rv);
    h = lerp(h, SEA - 3, riverF);
    h = Math.max(3, Math.min(HEIGHT - 24, Math.round(h)));
    let biome = BIOMES.PLAINS;
    if (h < SEA && (riverF > 0.4 || canyonF < 0.5)) biome = BIOMES.RIVER;
    else if (canyonF > 0.5) biome = BIOMES.CANYON;
    else if (skyF > 0.5) biome = BIOMES.SKY;
    return { h, biome, canyonF, skyF };
  }

  // Beacon placement: deterministic ring around spawn.
  const br = mulberry32(s ^ 0xbeac0);
  const angle = br() * Math.PI * 2;
  const dist = 36 + br() * 28;
  const bx = Math.round(Math.cos(angle) * dist);
  const bz = Math.round(Math.sin(angle) * dist);
  const by = Math.max(SEA + 2, Math.min(HEIGHT - 50, rawColumn(bx, bz).h));
  const beacon = { x: bx, y: by, z: bz, radius: BEACON_RADIUS };

  function beaconDist2(x, z) {
    const dx = x - bx;
    const dz = z - bz;
    return dx * dx + dz * dz;
  }

  // Structure override inside the beacon radius. Returns block id or -1 for "terrain".
  function beaconBlock(x, y, z, terrainH) {
    const dx = x - bx;
    const dz = z - bz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (y < by - 6) return -1;
    if (y < by) return y > terrainH ? B.ALLOY : -1;
    if (y === by) {
      if (d > 7.5) return B.ALLOY;
      if (Math.abs(d - 5) < 0.5) return B.CORE;
      return B.CHROME;
    }
    const ry = y - by;
    // Central spire.
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
      const corner = Math.abs(dx) === 1 && Math.abs(dz) === 1;
      if (ry <= 18) {
        if (corner) return B.CHROME;
        if (dx === 0 && dz === 0) return B.ALLOY;
        return ry % 4 === 2 ? B.GLASS : B.ALLOY;
      }
      if (ry <= 21) return dx === 0 && dz === 0 ? B.CORE : B.GLASS;
      if (ry === 22 && dx === 0 && dz === 0) return B.BEACON;
      return B.AIR;
    }
    // Gigatron statue, facing +z, centred at (bx, bz + 5).
    const sx = dx;
    const sz = dz - 5;
    if (Math.abs(sx) <= 3 && sz >= -1 && sz <= 1) {
      const g = gigatronVoxel(sx, ry, sz);
      if (g !== B.AIR) return g;
    }
    if (ry <= 40) return B.AIR;
    return -1;
  }

  function gigatronVoxel(sx, ry, sz) {
    const ax = Math.abs(sx);
    // Legs.
    if (ry >= 1 && ry <= 4) return ax === 1 && sz === 0 ? (ry === 1 ? B.CHROME : B.ALLOY) : B.AIR;
    // Hips.
    if (ry === 5) return ax <= 1 && sz === 0 ? B.CHROME : (ax === 3 && sz === 0 ? B.ALLOY : B.AIR);
    // Torso with glowing chest core.
    if (ry >= 6 && ry <= 9) {
      if (ax <= 2) {
        if (sx === 0 && sz === 1 && (ry === 7 || ry === 8)) return B.CORE;
        if (ax === 2 && sz !== 0) return ry === 9 ? B.CHROME : B.AIR;
        return ax === 2 ? B.ALLOY : B.CHROME;
      }
      if (ax === 3 && sz === 0) return ry === 9 ? B.CHROME : B.ALLOY;
      return B.AIR;
    }
    // Neck and head.
    if (ry === 10) return sx === 0 && sz === 0 ? B.ALLOY : B.AIR;
    if (ry >= 11 && ry <= 13) {
      if (ax <= 1) {
        if (ry === 12 && ax === 1 && sz === 1) return B.CORE;
        return sz === 1 && ry !== 12 ? B.CHROME : B.ALLOY;
      }
      return B.AIR;
    }
    if (ry === 14) return sx === 0 && sz === 0 ? B.CHROME : B.AIR;
    if (ry === 15) return sx === 0 && sz === 0 ? B.CORE : B.AIR;
    return B.AIR;
  }

  function column(x, z) {
    const c = rawColumn(x, z);
    if (beaconDist2(x, z) <= BEACON_RADIUS * BEACON_RADIUS) {
      c.h = by;
      c.beacon = true;
    }
    return c;
  }

  function topBlockFor(c) {
    if (c.h <= SEA + 1) return B.SAND;
    if (c.biome === BIOMES.CANYON) return B.CIRCUIT;
    return B.TURF;
  }

  function generateChunk(cx, cz) {
    const data = new Uint8Array(CHUNK_VOLUME);
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;
    const heights = new Int16Array(CHUNK * CHUNK);
    const biomes = new Array(CHUNK * CHUNK);
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = ox + lx;
        const z = oz + lz;
        const raw = rawColumn(x, z);
        const h = raw.h;
        heights[lx + lz * CHUNK] = h;
        biomes[lx + lz * CHUNK] = raw.biome;
        const base = localIndex(lx, 0, lz);
        const top = topBlockFor(raw);
        const canyon = raw.biome === BIOMES.CANYON;
        const band = Math.floor(nDetail(x / 30, z / 30) * 3);
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = B.BEDROCK;
          else if (y === h) id = top;
          else if (y >= h - 3) id = canyon ? B.CIRCUIT : (top === B.SAND ? B.SAND : B.SOIL);
          else if (hash3(s + 11, x, y, z) < 0.012 && y < h - 5) id = B.CRYSTAL;
          else if (canyon) id = ((y + band) >> 2) & 1 ? B.CIRCUIT : B.STONE;
          else id = B.STONE;
          data[base + y] = id;
        }
        for (let y = h + 1; y <= SEA; y++) data[base + y] = B.FLUID;

        // Floating sky islands.
        if (raw.skyF > 0.1) {
          const mask = nIsle(x / 48, z / 48) * 0.7 + nIsle2(x / 17, z / 17) * 0.3 - 0.25;
          if (mask > 0) {
            const topY = 62 + Math.round(nIsle2(x / 70, z / 70) * 5) + Math.round(mask * 8 * raw.skyF);
            const botY = topY - Math.round(3 + mask * raw.skyF * 28);
            for (let y = Math.max(botY, h + 4); y <= topY; y++) data[base + y] = y === topY ? B.MOSS : B.AETHER;
            if (botY > h + 5 && hash2(s + 12, x, z) < 0.06) data[base + botY - 1] = B.CRYSTAL;
          }
        }

        // Crystal spires on open ground.
        if (h > SEA + 1 && h < HEIGHT - 8) {
          const r = hash2(s + 9, x, z);
          const limit = raw.biome === BIOMES.CANYON ? 0.002 : 0.0035;
          if (r < limit) {
            const tall = 2 + Math.floor(hash2(s + 10, x, z) * 4);
            for (let y = h + 1; y <= h + tall; y++) data[base + y] = B.CRYSTAL;
          }
        }

        // Beacon overrides.
        if (beaconDist2(x, z) <= BEACON_RADIUS * BEACON_RADIUS) {
          for (let y = Math.max(1, by - 6); y < HEIGHT; y++) {
            const id = beaconBlock(x, y, z, h);
            if (id >= 0) data[base + y] = id;
          }
          heights[lx + lz * CHUNK] = by;
        }
      }
    }

    // Data trees: scan a margin so trees spanning chunk borders are consistent.
    for (let tz = oz - TREE_MARGIN; tz < oz + CHUNK + TREE_MARGIN; tz++) {
      for (let tx = ox - TREE_MARGIN; tx < ox + CHUNK + TREE_MARGIN; tx++) {
        const r = hash2(s + 9, tx, tz);
        if (r < 0.0035 || r >= 0.0095) continue;
        if (beaconDist2(tx, tz) <= (BEACON_RADIUS + 4) ** 2) continue;
        const c = rawColumn(tx, tz);
        if (c.biome !== BIOMES.PLAINS && c.biome !== BIOMES.SKY) continue;
        if (c.h <= SEA + 1 || c.h > HEIGHT - 16) continue;
        const trunk = 4 + Math.floor(hash2(s + 14, tx, tz) * 3);
        const topY = c.h + trunk;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x = tx + dx;
            const z = tz + dz;
            if (x < ox || x >= ox + CHUNK || z < oz || z >= oz + CHUNK) continue;
            const base = localIndex(x - ox, 0, z - oz);
            for (let dy = -2; dy <= 1; dy++) {
              const man = Math.abs(dx) + Math.abs(dz) + Math.abs(dy + 0.5);
              if (man > 3.5) continue;
              const y = topY + dy;
              if (data[base + y] === B.AIR) data[base + y] = B.LEAF;
            }
            if (dx === 0 && dz === 0) {
              for (let y = c.h + 1; y <= topY; y++) data[base + y] = B.FIBER;
            }
          }
        }
      }
    }

    return { data, heights, biomes };
  }

  function heightAt(x, z) {
    return column(Math.floor(x), Math.floor(z)).h;
  }

  function biomeAt(x, z) {
    const c = column(Math.floor(x), Math.floor(z));
    if (c.beacon) return 'Gigatron Beacon';
    return c.biome;
  }

  function findSpawn() {
    for (let r = 0; r < 200; r += 2) {
      const steps = Math.max(1, r * 4);
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r);
        const z = Math.round(Math.sin(a) * r);
        const c = column(x, z);
        if (c.h > SEA + 1 && !c.beacon) return { x: x + 0.5, y: c.h + 1, z: z + 0.5 };
      }
    }
    return { x: 0.5, y: HEIGHT - 10, z: 0.5 };
  }

  // Wild drone spawn points (deterministic). Each has a stable key for "already tamed" tracking.
  function droneSpawnsForChunk(cx, cz) {
    const out = [];
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;
    if (hash2(s + 13, cx, cz) < 0.1) {
      const x = ox + Math.floor(hash2(s + 15, cx, cz) * CHUNK);
      const z = oz + Math.floor(hash2(s + 16, cx, cz) * CHUNK);
      const c = column(x, z);
      if (c.h > SEA) out.push({ key: 'w' + cx + ',' + cz, x: x + 0.5, y: c.h + 2.5, z: z + 0.5 });
    }
    const bcx = Math.floor(bx / CHUNK);
    const bcz = Math.floor(bz / CHUNK);
    if (cx === bcx && cz === bcz) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        out.push({ key: 'beacon' + i, x: bx + Math.cos(a) * 6 + 0.5, y: by + 3.5, z: bz + Math.sin(a) * 6 + 0.5 });
      }
    }
    return out;
  }

  return { seed: s, generateChunk, heightAt, biomeAt, findSpawn, beacon, droneSpawnsForChunk };
}
