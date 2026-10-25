// Swarm drone behaviour and hub chains. Pure logic; rendering lives in client/.
import { B } from './blocks.js';

export const LINK_RANGE = 24;
export const FETCH_RANGE = 12;
export const DRONE_SPEED = 7;
export const MINE_TIME = 1.2;
export const HARVEST_RADIUS = 8;
export const MAX_DRONES = 12;
export const MINEABLE = new Set([B.CRYSTAL]);

export function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Each hub links to the nearest OLDER hub within LINK_RANGE; the oldest hub in a cluster is the root.
export function computeHubLinks(hubs) {
  const list = [...hubs.values()].sort((a, b) => a.order - b.order);
  const links = new Map();
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    let best = null;
    let bestD = Infinity;
    for (let j = 0; j < i; j++) {
      const d = dist3(h, list[j]);
      if (d <= LINK_RANGE && d < bestD) {
        bestD = d;
        best = list[j].key;
      }
    }
    links.set(h.key, best);
  }
  return links;
}

// Number of hubs in the longest parent chain.
export function longestChain(links) {
  let best = 0;
  for (const k of links.keys()) {
    let n = 0;
    let cur = k;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      n++;
      cur = links.get(cur);
    }
    best = Math.max(best, n);
  }
  return best;
}

export function addToStorage(storage, id, count) {
  storage[id] = (storage[id] || 0) + count;
}

export function storageTotal(storage) {
  let n = 0;
  for (const k in storage) n += storage[k];
  return n;
}

// Move up to `batch` items of one kind from every child hub to its parent.
export function transferStep(hubs, links, batch = 8) {
  const transfers = [];
  for (const [k, parentKey] of links) {
    if (!parentKey) continue;
    const from = hubs.get(k);
    const to = hubs.get(parentKey);
    if (!from || !to) continue;
    for (const id in from.storage) {
      const have = from.storage[id];
      if (have <= 0) continue;
      const n = Math.min(batch, have);
      from.storage[id] = have - n;
      if (from.storage[id] === 0) delete from.storage[id];
      addToStorage(to.storage, Number(id), n);
      transfers.push({ from: k, to: parentKey, id: Number(id), count: n });
      break;
    }
  }
  return transfers;
}

export function formationTarget(index, count, t, player) {
  const n = Math.max(1, count);
  const a = (index / n) * Math.PI * 2 + t * 0.6;
  const r = 1.6 + 0.25 * Math.sin(t * 1.3 + index);
  return { x: player.x + Math.cos(a) * r, y: player.y + 2.1 + 0.3 * Math.sin(t * 2 + index * 1.7), z: player.z + Math.sin(a) * r };
}

export function createDrone(id, x, y, z) {
  return { id, x, y, z, mode: 'follow', hub: null, task: null, carry: null, searchT: 0 };
}

function moveToward(d, target, dt, speed = DRONE_SPEED) {
  const dx = target.x - d.x;
  const dy = target.y - d.y;
  const dz = target.z - d.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const step = speed * dt;
  if (len <= step || len < 1e-6) {
    d.x = target.x;
    d.y = target.y;
    d.z = target.z;
    return 0;
  }
  d.x += (dx / len) * step;
  d.y += (dy / len) * step;
  d.z += (dz / len) * step;
  return len - step;
}

/*
 * env = {
 *   t, player: {x,y,z}, index, count,
 *   drops: Map<id, {id,x,y,z,item,count,claimedBy}>,
 *   hubs: Map<key, hub>,
 *   findOre(hub, drone) -> {x,y,z} | null,
 *   getBlock(x,y,z) -> id,
 *   mineBlock(x,y,z) -> id (0 if nothing),
 *   pickupDrop(dropId) -> {item,count} | null,
 *   deliverToPlayer({item,count}),
 *   depositToHub(key, {item,count}),
 *   releaseOre(x,y,z),
 * }
 */
export function updateDrone(d, dt, env) {
  if (d.mode === 'work') {
    const hub = env.hubs.get(d.hub);
    if (!hub) {
      d.mode = 'follow';
      d.hub = null;
      if (d.task?.kind === 'mine') env.releaseOre?.(d.task.x, d.task.y, d.task.z);
      d.task = null;
    } else {
      updateWorker(d, dt, env, hub);
      return;
    }
  }
  updateFollower(d, dt, env);
}

function updateFollower(d, dt, env) {
  const p = env.player;
  if (d.carry) {
    const rem = moveToward(d, { x: p.x, y: p.y + 1.2, z: p.z }, dt, DRONE_SPEED * 1.3);
    if (rem < 1.2) {
      env.deliverToPlayer(d.carry);
      d.carry = null;
    }
    return;
  }
  if (d.task?.kind === 'fetch') {
    const drop = env.drops.get(d.task.dropId);
    if (!drop || (drop.claimedBy && drop.claimedBy !== d.id)) {
      d.task = null;
    } else {
      const rem = moveToward(d, { x: drop.x, y: drop.y + 0.3, z: drop.z }, dt, DRONE_SPEED * 1.3);
      if (rem < 0.6) {
        d.carry = env.pickupDrop(drop.id);
        d.task = null;
      }
      return;
    }
  }
  let best = null;
  let bestD = FETCH_RANGE;
  for (const drop of env.drops.values()) {
    if (drop.claimedBy) continue;
    const dd = dist3(drop, p);
    if (dd < bestD) {
      bestD = dd;
      best = drop;
    }
  }
  if (best) {
    best.claimedBy = d.id;
    d.task = { kind: 'fetch', dropId: best.id };
    return;
  }
  moveToward(d, formationTarget(env.index, env.count, env.t, p), dt);
}

function updateWorker(d, dt, env, hub) {
  const home = { x: hub.x + 0.5, y: hub.y + 2, z: hub.z + 0.5 };
  if (d.carry) {
    const rem = moveToward(d, home, dt);
    if (rem < 0.8) {
      env.depositToHub(hub.key, d.carry);
      d.carry = null;
    }
    return;
  }
  if (d.task?.kind === 'mine') {
    const t = d.task;
    const id = env.getBlock(t.x, t.y, t.z);
    if (!MINEABLE.has(id)) {
      env.releaseOre?.(t.x, t.y, t.z);
      d.task = null;
      return;
    }
    const rem = moveToward(d, { x: t.x + 0.5, y: t.y + 1.3, z: t.z + 0.5 }, dt);
    if (rem < 0.9) {
      t.time += dt;
      if (t.time >= MINE_TIME) {
        const got = env.mineBlock(t.x, t.y, t.z);
        env.releaseOre?.(t.x, t.y, t.z);
        d.task = null;
        if (got) d.carry = { item: got, count: 1 };
      }
    }
    return;
  }
  d.searchT -= dt;
  if (d.searchT <= 0) {
    const ore = env.findOre(hub, d);
    if (ore) {
      d.task = { kind: 'mine', x: ore.x, y: ore.y, z: ore.z, time: 0 };
      return;
    }
    d.searchT = 2;
  }
  const a = env.t * 0.8 + d.id;
  moveToward(d, { x: home.x + Math.cos(a) * 1.5, y: home.y + 0.5, z: home.z + Math.sin(a) * 1.5 }, dt);
}
