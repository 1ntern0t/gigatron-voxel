// Browser storage adapters for SaveStore: IndexedDB first, localStorage fallback.
import { SaveStore, memoryAdapter } from '../core/save.js';

function idbAdapter() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open('gigatron-voxel', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('worlds');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const run = (mode, fn) => new Promise((res, rej) => {
        const tx = db.transaction('worlds', mode);
        const r = fn(tx.objectStore('worlds'));
        tx.oncomplete = () => res(r.result);
        tx.onerror = () => rej(tx.error);
      });
      resolve({
        async get(k) { const v = await run('readonly', (s) => s.get(k)); return v === undefined ? null : v; },
        async set(k, v) { await run('readwrite', (s) => s.put(v, k)); },
        async del(k) { await run('readwrite', (s) => s.delete(k)); },
        async keys() { return (await run('readonly', (s) => s.getAllKeys())).map(String); },
      });
    };
  });
}

function localStorageAdapter() {
  const P = 'gigatron-voxel:';
  localStorage.setItem(P + 'probe', '1');
  localStorage.removeItem(P + 'probe');
  return {
    async get(k) { return localStorage.getItem(P + k); },
    async set(k, v) { localStorage.setItem(P + k, v); },
    async del(k) { localStorage.removeItem(P + k); },
    async keys() { return Object.keys(localStorage).filter((k) => k.startsWith(P)).map((k) => k.slice(P.length)); },
  };
}

export async function openSaveStore() {
  try {
    return { store: new SaveStore(await idbAdapter()), kind: 'IndexedDB' };
  } catch {
    try {
      return { store: new SaveStore(localStorageAdapter()), kind: 'localStorage' };
    } catch {
      return { store: new SaveStore(memoryAdapter()), kind: 'memory (not persistent)' };
    }
  }
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('gigatron-voxel:settings') || '{}');
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem('gigatron-voxel:settings', JSON.stringify(s));
  } catch {
    // ignore
  }
}
