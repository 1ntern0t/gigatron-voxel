// Headless voxel store for the authoritative host (Node lobby host and tests).
// Terrain is regenerated from the seed on demand; only edits are kept and persisted.
import { CHUNK, HEIGHT, chunkKey, localIndex, fromLocalIndex, parseChunkKey } from './constants.js';
import { createWorldGen } from './worldgen.js';
import { B, SOLID, isValidBlockId } from './blocks.js';

export class VoxelStore {
  constructor(seed, { maxCachedChunks = 512 } = {}) {
    this.seed = seed >>> 0;
    this.gen = createWorldGen(this.seed);
    this.edits = new Map(); // chunkKey -> Map<localIndex, id>
    this.cache = new Map(); // chunkKey -> Uint8Array (generated terrain + edits), LRU by insertion order
    this.maxCachedChunks = maxCachedChunks;
    this.editCount = 0;
  }

  chunk(cx, cz) {
    const k = chunkKey(cx, cz);
    let data = this.cache.get(k);
    if (data) {
      this.cache.delete(k);
      this.cache.set(k, data);
      return data;
    }
    data = this.gen.generateChunk(cx, cz).data;
    const m = this.edits.get(k);
    if (m) for (const [idx, id] of m) data[idx] = id;
    this.cache.set(k, data);
    if (this.cache.size > this.maxCachedChunks) this.cache.delete(this.cache.keys().next().value);
    return data;
  }

  getBlock(x, y, z) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null;
    if (y < 0 || y >= HEIGHT) return 0;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    return this.chunk(cx, cz)[localIndex(x - cx * CHUNK, y, z - cz * CHUNK)];
  }

  setBlock(x, y, z, id) {
    if (y < 0 || y >= HEIGHT || !isValidBlockId(id)) return false;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const data = this.chunk(cx, cz);
    const idx = localIndex(x - cx * CHUNK, y, z - cz * CHUNK);
    if (data[idx] === id) return false;
    data[idx] = id;
    const k = chunkKey(cx, cz);
    if (!this.edits.has(k)) this.edits.set(k, new Map());
    const m = this.edits.get(k);
    if (!m.has(idx)) this.editCount++;
    m.set(idx, id);
    return true;
  }

  // Highest solid (or fluid) block at or below y under a player's footprint (-1 when none).
  groundBelow(x, y, z, half = 0.3) {
    let best = -1;
    const top = Math.min(HEIGHT - 1, Math.floor(y));
    for (const [ox, oz] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
      const xi = Math.floor(x + ox);
      const zi = Math.floor(z + oz);
      for (let yy = top; yy > best; yy--) {
        const id = this.getBlock(xi, yy, zi);
        if (SOLID[id] || id === B.FLUID) {
          best = yy;
          break;
        }
      }
    }
    return best;
  }

  // Top solid block of the generated terrain, ignoring player/bot edits.
  naturalSurface(x, z) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const data = this.gen.generateChunk(cx, cz).data;
    for (let y = HEIGHT - 1; y >= 0; y--) {
      const id = data[localIndex(x - cx * CHUNK, y, z - cz * CHUNK)];
      if (SOLID[id] || id === B.FLUID) return y;
    }
    return -1;
  }

  surface(x, z) {
    return this.groundBelow(x + 0.5, HEIGHT - 1, z + 0.5, 0);
  }

  flatEdits() {
    const out = [];
    for (const [ck, m] of this.edits) {
      const [cx, cz] = parseChunkKey(ck);
      for (const [idx, id] of m) {
        const [lx, y, lz] = fromLocalIndex(idx);
        out.push(cx * CHUNK + lx, y, cz * CHUNK + lz, id);
      }
    }
    return out;
  }

  loadFlatEdits(flat) {
    for (let i = 0; i + 3 < flat.length; i += 4) this.setBlock(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
  }
}
