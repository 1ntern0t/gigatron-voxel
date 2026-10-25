// World save format (JSON) + storage-agnostic save store. Only player edits are stored;
// terrain is regenerated from the seed, so saves stay small.
import { CHUNK_VOLUME } from './constants.js';
import { isValidBlockId, isValidItemId } from './blocks.js';
import { validateQuestState, createQuestState } from './quests.js';

export const SAVE_VERSION = 1;
export const INVENTORY_SIZE = 36;
const CHUNK_KEY_RE = /^-?\d{1,7},-?\d{1,7}$/;
const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// edits: Map<chunkKey, Map<localIndex, blockId>>  ->  { chunkKey: [idx, id, idx, id, ...] }
export function encodeEdits(edits) {
  const out = {};
  for (const [ck, m] of edits) {
    if (!m.size) continue;
    const arr = [];
    for (const [idx, id] of [...m].sort((a, b) => a[0] - b[0])) arr.push(idx, id);
    out[ck] = arr;
  }
  return out;
}

export function decodeEdits(obj) {
  const edits = new Map();
  if (!obj || typeof obj !== 'object') return edits;
  for (const ck of Object.keys(obj)) {
    if (!CHUNK_KEY_RE.test(ck)) throw new Error('Bad chunk key in save: ' + ck);
    const arr = obj[ck];
    if (!Array.isArray(arr) || arr.length % 2 !== 0) throw new Error('Bad edit list for chunk ' + ck);
    const m = new Map();
    for (let i = 0; i < arr.length; i += 2) {
      const idx = arr[i];
      const id = arr[i + 1];
      if (!Number.isInteger(idx) || idx < 0 || idx >= CHUNK_VOLUME) throw new Error('Bad edit index');
      if (!isValidBlockId(id)) throw new Error('Bad block id ' + id);
      m.set(idx, id);
    }
    edits.set(ck, m);
  }
  return edits;
}

function cleanInventory(inv) {
  const out = new Array(INVENTORY_SIZE).fill(null);
  if (!Array.isArray(inv)) return out;
  for (let i = 0; i < Math.min(INVENTORY_SIZE, inv.length); i++) {
    const s = inv[i];
    if (s && isValidItemId(s.id) && Number.isInteger(s.count) && s.count > 0) out[i] = { id: s.id, count: Math.min(9999, s.count) };
  }
  return out;
}

function cleanStorage(st) {
  const out = {};
  if (!st || typeof st !== 'object') return out;
  for (const k of Object.keys(st)) {
    const id = Number(k);
    const n = st[k];
    if (isValidItemId(id) && Number.isInteger(n) && n > 0) out[id] = Math.min(1e6, n);
  }
  return out;
}

export function serializeWorld(state) {
  const doc = {
    format: 'gigatron-voxel-save',
    v: SAVE_VERSION,
    name: String(state.name ?? 'World').slice(0, 40),
    seed: state.seed >>> 0,
    seedText: String(state.seedText ?? state.seed).slice(0, 64),
    createdAt: finite(state.createdAt, Date.now()),
    savedAt: finite(state.savedAt, Date.now()),
    time: finite(state.time),
    creative: !!state.creative,
    player: {
      x: finite(state.player?.x), y: finite(state.player?.y), z: finite(state.player?.z),
      yaw: finite(state.player?.yaw), pitch: finite(state.player?.pitch),
    },
    selected: Number.isInteger(state.selected) ? state.selected : 0,
    inventory: cleanInventory(state.inventory),
    quests: validateQuestState(state.quests),
    drones: (state.drones ?? []).map((d) => ({
      x: finite(d.x), y: finite(d.y), z: finite(d.z), mode: d.mode === 'work' ? 'work' : 'follow', hub: typeof d.hub === 'string' ? d.hub : null,
    })),
    hubs: (state.hubs ?? []).map((h) => ({ key: h.key, x: h.x | 0, y: h.y | 0, z: h.z | 0, order: h.order | 0, storage: cleanStorage(h.storage) })),
    tamed: [...(state.tamed ?? [])].map(String),
    edits: encodeEdits(state.edits ?? new Map()),
  };
  return JSON.stringify(doc);
}

export function deserializeWorld(json) {
  let doc;
  try {
    doc = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error('Save file is not valid JSON');
  }
  if (!doc || doc.format !== 'gigatron-voxel-save') throw new Error('Not a Gigatron Voxel save');
  if (doc.v !== SAVE_VERSION) throw new Error('Unsupported save version ' + doc.v);
  if (!Number.isInteger(doc.seed) || doc.seed < 0 || doc.seed > 0xffffffff) throw new Error('Bad seed');
  const hubKeyRe = /^-?\d+,-?\d+,-?\d+$/;
  return {
    name: String(doc.name ?? 'World').slice(0, 40),
    seed: doc.seed >>> 0,
    seedText: String(doc.seedText ?? doc.seed).slice(0, 64),
    createdAt: finite(doc.createdAt),
    savedAt: finite(doc.savedAt),
    time: finite(doc.time),
    creative: !!doc.creative,
    player: {
      x: finite(doc.player?.x), y: finite(doc.player?.y, 60), z: finite(doc.player?.z),
      yaw: finite(doc.player?.yaw), pitch: finite(doc.player?.pitch),
    },
    selected: Number.isInteger(doc.selected) ? Math.max(0, Math.min(8, doc.selected)) : 0,
    inventory: cleanInventory(doc.inventory),
    quests: doc.quests ? validateQuestState(doc.quests) : createQuestState(),
    drones: Array.isArray(doc.drones) ? doc.drones.slice(0, 64).map((d) => ({
      x: finite(d.x), y: finite(d.y), z: finite(d.z), mode: d.mode === 'work' ? 'work' : 'follow', hub: typeof d.hub === 'string' && hubKeyRe.test(d.hub) ? d.hub : null,
    })) : [],
    hubs: Array.isArray(doc.hubs) ? doc.hubs.filter((h) => h && hubKeyRe.test(h.key)).slice(0, 256).map((h) => ({
      key: h.key, x: h.x | 0, y: h.y | 0, z: h.z | 0, order: h.order | 0, storage: cleanStorage(h.storage),
    })) : [],
    tamed: Array.isArray(doc.tamed) ? doc.tamed.slice(0, 10000).map(String) : [],
    edits: decodeEdits(doc.edits),
  };
}

// Storage adapter: { get(key), set(key, value), del(key), keys() } all async.
export function memoryAdapter() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
    async keys() { return [...m.keys()]; },
  };
}

const PREFIX = 'world:';

export class SaveStore {
  constructor(adapter) {
    this.adapter = adapter;
  }

  static slotFor(name) {
    return PREFIX + String(name).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40);
  }

  async save(state) {
    const json = serializeWorld({ ...state, savedAt: Date.now() });
    await this.adapter.set(SaveStore.slotFor(state.name), json);
    return json.length;
  }

  async load(name) {
    const json = await this.adapter.get(SaveStore.slotFor(name));
    if (json === null) return null;
    return deserializeWorld(json);
  }

  async list() {
    const out = [];
    for (const k of await this.adapter.keys()) {
      if (!k.startsWith(PREFIX)) continue;
      try {
        const doc = JSON.parse(await this.adapter.get(k));
        out.push({ name: doc.name, seed: doc.seed, seedText: doc.seedText, savedAt: doc.savedAt });
      } catch {
        // Skip corrupt entries.
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async remove(name) {
    await this.adapter.del(SaveStore.slotFor(name));
  }
}
