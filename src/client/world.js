// Chunk store, worker pool and mesh management.
import * as THREE from '../../vendor/three/three.module.js';
import { CHUNK, HEIGHT, chunkKey, localIndex } from '../core/constants.js';
import { B, SOLID } from '../core/blocks.js';
import { createWorldGen } from '../core/worldgen.js';
import { buildPaddedVolume, meshVolume, PAD } from '../core/mesher.js';
import { raycastVoxels } from '../core/raycast.js';

class WorkerPool {
  constructor(count, onMessage) {
    this.workers = [];
    this.busy = [];
    this.onMessage = onMessage;
    try {
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => {
          this.busy[i]--;
          onMessage(e.data);
        };
        w.onerror = (e) => console.warn('chunk worker error', e.message);
        this.workers.push(w);
        this.busy.push(0);
      }
    } catch (err) {
      console.warn('Workers unavailable, falling back to main thread', err);
      this.workers = [];
    }
  }

  get available() {
    return this.workers.length > 0;
  }

  get capacity() {
    let free = 0;
    for (const b of this.busy) free += Math.max(0, 2 - b);
    return free;
  }

  post(msg, transfer) {
    let best = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.busy[i] < this.busy[best]) best = i;
    this.busy[best]++;
    this.workers[best].postMessage(msg, transfer);
  }

  terminate() {
    for (const w of this.workers) w.terminate();
  }
}

export class ChunkWorld {
  constructor({ scene, materials, seed, edits = new Map(), renderDistance = 8, onChunkData }) {
    this.scene = scene;
    this.materials = materials;
    this.seed = seed;
    this.gen = createWorldGen(seed);
    this.edits = edits;
    this.renderDistance = renderDistance;
    this.onChunkData = onChunkData;
    this.chunks = new Map();
    this.group = new THREE.Group();
    scene.add(this.group);
    this.jobId = 0;
    this.volPool = [];
    this.stats = { generated: 0, meshed: 0 };
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    this.pool = new WorkerPool(Math.max(1, Math.min(4, cores - 1)), (m) => this.onWorker(m));
    this.center = [0, 0];
  }

  dispose() {
    this.pool.terminate();
    for (const c of this.chunks.values()) this.disposeMeshes(c);
    this.scene.remove(this.group);
  }

  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz));
  }

  getChunkData(cx, cz) {
    const c = this.chunks.get(chunkKey(cx, cz));
    return c && c.data ? c.data : null;
  }

  // Returns block id, or null when the chunk isn't loaded.
  getBlockOrNull(x, y, z) {
    if (y < 0 || y >= HEIGHT) return y < 0 ? B.BEDROCK : B.AIR;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c || !c.data) return null;
    return c.data[localIndex(x - cx * CHUNK, y, z - cz * CHUNK)];
  }

  getBlock(x, y, z) {
    const id = this.getBlockOrNull(x, y, z);
    return id === null ? B.AIR : id;
  }

  isSolid(x, y, z) {
    const id = this.getBlockOrNull(x, y, z);
    if (id === null) return y < HEIGHT && y >= 0; // unloaded chunks block movement
    return SOLID[id] === 1;
  }

  isLoaded(x, z) {
    return !!this.getChunkData(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
  }

  setBlock(x, y, z, id, record = true) {
    if (y < 0 || y >= HEIGHT) return false;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const ck = chunkKey(cx, cz);
    const c = this.chunks.get(ck);
    if (!c || !c.data) return false;
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    const idx = localIndex(lx, y, lz);
    if (c.data[idx] === id) return false;
    c.data[idx] = id;
    if (record) {
      let m = this.edits.get(ck);
      if (!m) this.edits.set(ck, (m = new Map()));
      m.set(idx, id);
    }
    // Light can travel PAD blocks, so dirty every neighbour whose padded volume covers this cell.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === -1 && lx >= PAD) continue;
        if (dx === 1 && lx < CHUNK - PAD) continue;
        if (dz === -1 && lz >= PAD) continue;
        if (dz === 1 && lz < CHUNK - PAD) continue;
        const n = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (n) this.markDirty(n, dx === 0 && dz === 0);
      }
    }
    return true;
  }

  markDirty(c, urgent) {
    c.version++;
    c.dirty = true;
    if (urgent) c.urgent = true;
  }

  applyEdits(c) {
    const m = this.edits.get(chunkKey(c.cx, c.cz));
    if (!m) return;
    for (const [idx, id] of m) c.data[idx] = id;
  }

  update(px, pz) {
    const pcx = Math.floor(px / CHUNK);
    const pcz = Math.floor(pz / CHUNK);
    this.center = [pcx, pcz];
    const R = this.renderDistance;
    const genR = R + 1;

    // Request generation, nearest first.
    const wanted = [];
    for (let dz = -genR; dz <= genR; dz++) {
      for (let dx = -genR; dx <= genR; dx++) {
        if (dx * dx + dz * dz > genR * genR + 1) continue;
        const ck = chunkKey(pcx + dx, pcz + dz);
        if (!this.chunks.has(ck)) wanted.push([dx * dx + dz * dz, pcx + dx, pcz + dz]);
      }
    }
    wanted.sort((a, b) => a[0] - b[0]);
    let budget = this.pool.available ? this.pool.capacity : 2;
    for (const [, cx, cz] of wanted) {
      if (budget-- <= 0) break;
      this.requestGen(cx, cz);
    }

    // Mesh ready chunks inside render distance whose neighbours exist.
    const meshCandidates = [];
    for (const c of this.chunks.values()) {
      if (!c.data) continue;
      const dx = c.cx - pcx;
      const dz = c.cz - pcz;
      const d2 = dx * dx + dz * dz;
      if (d2 > (R + 3) * (R + 3)) {
        this.unload(c);
        continue;
      }
      if (d2 > R * R + 1) {
        if (c.meshes) this.disposeMeshes(c);
        continue;
      }
      if (c.meshing || (!c.dirty && c.meshes)) continue;
      if (!this.neighboursReady(c)) continue;
      meshCandidates.push([c.urgent ? -1 : d2, c]);
    }
    meshCandidates.sort((a, b) => a[0] - b[0]);
    let meshBudget = this.pool.available ? Math.max(1, this.pool.capacity) : 1;
    for (const [, c] of meshCandidates) {
      if (meshBudget-- <= 0) break;
      this.requestMesh(c);
    }
  }

  neighboursReady(c) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.getChunkData(c.cx + dx, c.cz + dz)) return false;
    return true;
  }

  requestGen(cx, cz) {
    const c = { cx, cz, data: null, meshes: null, dirty: true, urgent: false, version: 1, meshing: false };
    this.chunks.set(chunkKey(cx, cz), c);
    if (this.pool.available) {
      this.pool.post({ type: 'gen', job: ++this.jobId, seed: this.seed, cx, cz });
    } else {
      this.onGenerated(cx, cz, this.gen.generateChunk(cx, cz).data);
    }
  }

  onGenerated(cx, cz, data) {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return;
    c.data = data;
    this.applyEdits(c);
    this.stats.generated++;
    // New data changes neighbour borders.
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = this.chunks.get(chunkKey(cx + dx, cz + dz));
      if (n && n !== c && n.meshes) this.markDirty(n, false);
    }
    this.onChunkData?.(c);
  }

  requestMesh(c) {
    c.dirty = false;
    const urgent = c.urgent;
    c.urgent = false;
    const vol = buildPaddedVolume(c.cx, c.cz, (x, z) => this.getChunkData(x, z), this.volPool.pop());
    if (this.pool.available && !urgent) {
      c.meshing = true;
      this.pool.post({ type: 'mesh', job: ++this.jobId, cx: c.cx, cz: c.cz, version: c.version, vol }, [vol.buffer]);
    } else {
      // Player edits mesh synchronously for instant feedback.
      this.onMeshed(c, c.version, meshVolume(vol));
      this.volPool.push(vol);
    }
  }

  onWorker(m) {
    if (m.type === 'gen') this.onGenerated(m.cx, m.cz, m.data);
    else if (m.type === 'mesh') {
      if (m.vol && this.volPool.length < 8) this.volPool.push(m.vol);
      const c = this.chunks.get(chunkKey(m.cx, m.cz));
      if (!c) return;
      c.meshing = false;
      if (m.version !== c.version) {
        c.dirty = true;
        return;
      }
      this.onMeshed(c, m.version, m.mesh);
    } else if (m.type === 'error') {
      console.error('worker job failed', m.kind, m.cx, m.cz, m.message);
      const c = this.chunks.get(chunkKey(m.cx, m.cz));
      if (!c) return;
      if (m.kind === 'gen' && !c.data) {
        // Drop the placeholder so update() requests this chunk again instead of waiting forever.
        this.chunks.delete(chunkKey(m.cx, m.cz));
      } else if (m.kind === 'mesh') {
        c.meshing = false;
        c.meshFailures = (c.meshFailures || 0) + 1;
        // Retry a couple of times, then leave the chunk alone rather than loop on a bad volume.
        if (c.meshFailures < 3) c.dirty = true;
      }
    }
  }

  onMeshed(c, version, mesh) {
    this.disposeMeshes(c);
    const meshes = [];
    for (const [part, mat] of [[mesh.opaque, this.materials.opaque], [mesh.translucent, this.materials.translucent]]) {
      if (!part.quads) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
      g.setAttribute('aLight', new THREE.BufferAttribute(part.lights, 4));
      g.setIndex(new THREE.BufferAttribute(part.indices, 1));
      g.computeBoundingSphere();
      const obj = new THREE.Mesh(g, mat);
      obj.position.set(c.cx * CHUNK, 0, c.cz * CHUNK);
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      if (mat === this.materials.translucent) obj.renderOrder = 1;
      this.group.add(obj);
      meshes.push(obj);
    }
    c.meshes = meshes;
    c.meshVersion = version;
    this.stats.meshed++;
  }

  disposeMeshes(c) {
    if (!c.meshes) return;
    for (const m of c.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    c.meshes = null;
  }

  unload(c) {
    this.disposeMeshes(c);
    this.chunks.delete(chunkKey(c.cx, c.cz));
  }

  // Voxel DDA raycast. Returns {x,y,z, nx,ny,nz, id} or null.
  raycast(origin, dir, maxDist = 8, pick = (id) => id !== B.AIR && id !== B.FLUID) {
    return raycastVoxels((x, y, z) => this.getBlock(x, y, z), origin, dir, maxDist, pick);
  }

  // Count of chunks with meshes, for HUD/debug.
  get meshedCount() {
    let n = 0;
    for (const c of this.chunks.values()) if (c.meshes) n++;
    return n;
  }
}
