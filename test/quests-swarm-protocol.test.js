import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTS, createQuestState, applyQuestEvent, currentQuest, isQuestLineComplete } from '../src/core/quests.js';
import { computeHubLinks, longestChain, transferStep, createDrone, updateDrone, LINK_RANGE } from '../src/core/swarm.js';
import { validateMessage, normalizeRoomCode, makeRoomCode, sanitizeText, createRateLimiter, PROTOCOL_VERSION } from '../src/core/protocol.js';
import { B } from '../src/core/blocks.js';

test('quest line has 5 quests and advances in order', () => {
  assert.equal(QUESTS.length, 5);
  let s = createQuestState();
  const events = [
    { type: 'reach_beacon' },
    { type: 'drones', count: 2 },
    { type: 'lamp' },
    { type: 'collect', item: B.CRYSTAL, count: 16 },
    { type: 'chain', length: 2 },
  ];
  for (let i = 0; i < events.length; i++) {
    assert.equal(currentQuest(s).id, QUESTS[i].id);
    const r = applyQuestEvent(s, events[i]);
    assert.equal(r.completed.id, QUESTS[i].id);
    s = r.state;
  }
  assert.ok(isQuestLineComplete(s));
  assert.equal(s.done.length, 5);
});

test('quests ignore unrelated events and accumulate collection progress', () => {
  let s = { index: 3, progress: 0, done: [] };
  assert.equal(applyQuestEvent(s, { type: 'lamp' }).completed, null);
  assert.equal(applyQuestEvent(s, { type: 'collect', item: B.STONE, count: 50 }).state.progress, 0);
  s = applyQuestEvent(s, { type: 'collect', item: B.CRYSTAL, count: 10 }).state;
  assert.equal(s.progress, 10);
  const r = applyQuestEvent(s, { type: 'collect', item: B.CRYSTAL, count: 6 });
  assert.equal(r.completed.id, 'harvest');
});

test('hubs link to the nearest older hub in range and form chains', () => {
  const hubs = new Map([
    ['a', { key: 'a', x: 0, y: 0, z: 0, order: 1, storage: {} }],
    ['b', { key: 'b', x: 10, y: 0, z: 0, order: 2, storage: { [B.CRYSTAL]: 20 } }],
    ['c', { key: 'c', x: 20, y: 0, z: 0, order: 3, storage: {} }],
    ['far', { key: 'far', x: 500, y: 0, z: 0, order: 4, storage: {} }],
  ]);
  const links = computeHubLinks(hubs);
  assert.equal(links.get('a'), null);
  assert.equal(links.get('b'), 'a');
  assert.equal(links.get('c'), 'b');
  assert.equal(links.get('far'), null);
  assert.equal(longestChain(links), 3);
  const t = transferStep(hubs, links, 8);
  assert.deepEqual(t, [{ from: 'b', to: 'a', id: B.CRYSTAL, count: 8 }]);
  assert.equal(hubs.get('a').storage[B.CRYSTAL], 8);
  assert.equal(hubs.get('b').storage[B.CRYSTAL], 12);
  assert.ok(LINK_RANGE >= 16);
});

function baseEnv(overrides = {}) {
  const delivered = [];
  const env = {
    t: 0, index: 0, count: 1, player: { x: 0, y: 30, z: 0 }, drops: new Map(), hubs: new Map(),
    findOre: () => null, getBlock: () => B.AIR, mineBlock: () => 0,
    pickupDrop(id) { const d = env.drops.get(id); env.drops.delete(id); return { item: d.item, count: d.count }; },
    deliverToPlayer(item) { delivered.push(item); },
    depositToHub() {},
    ...overrides,
  };
  return { env, delivered };
}

test('a following drone fetches a nearby drop and delivers it to the player', () => {
  const { env, delivered } = baseEnv();
  env.drops.set(1, { id: 1, x: 6, y: 30, z: 0, item: B.CHROME, count: 1, claimedBy: null });
  const d = createDrone(1, 0, 32, 0);
  for (let i = 0; i < 200 && delivered.length === 0; i++) {
    env.t += 0.05;
    updateDrone(d, 0.05, env);
  }
  assert.deepEqual(delivered, [{ item: B.CHROME, count: 1 }]);
  assert.equal(env.drops.size, 0);
});

test('a working drone mines crystal near its hub and deposits it', () => {
  const world = new Map([['3,30,0', B.CRYSTAL]]);
  const deposits = [];
  const { env } = baseEnv({
    getBlock: (x, y, z) => world.get(x + ',' + y + ',' + z) ?? B.AIR,
    findOre: () => (world.size ? { x: 3, y: 30, z: 0 } : null),
    mineBlock: (x, y, z) => { const k = x + ',' + y + ',' + z; const id = world.get(k) ?? 0; world.delete(k); return id; },
    depositToHub: (k, item) => deposits.push([k, item]),
  });
  env.hubs.set('0,30,0', { key: '0,30,0', x: 0, y: 30, z: 0, order: 1, storage: {} });
  const d = createDrone(1, 0, 32, 0);
  d.mode = 'work';
  d.hub = '0,30,0';
  for (let i = 0; i < 400 && deposits.length === 0; i++) {
    env.t += 0.05;
    updateDrone(d, 0.05, env);
  }
  assert.deepEqual(deposits, [['0,30,0', { item: B.CRYSTAL, count: 1 }]]);
  assert.equal(world.size, 0);
});

test('a working drone whose hub disappears returns to follow mode', () => {
  const { env } = baseEnv();
  const d = createDrone(1, 0, 32, 0);
  d.mode = 'work';
  d.hub = 'gone';
  updateDrone(d, 0.05, env);
  assert.equal(d.mode, 'follow');
});

test('protocol validates and sanitises messages from untrusted peers', () => {
  assert.equal(validateMessage(null), null);
  assert.equal(validateMessage({ t: 'nope' }), null);
  assert.equal(validateMessage({ t: 'edit', x: 1, y: 500, z: 1, id: 2 }), null);
  assert.equal(validateMessage({ t: 'edit', x: 1, y: 5, z: 1, id: 255 }), null);
  assert.deepEqual(validateMessage({ t: 'edit', x: 1, y: 5, z: -1, id: 2, extra: 'x' }), { t: 'edit', x: 1, y: 5, z: -1, id: 2 });
  assert.equal(validateMessage({ t: 'state', x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 }), null);
  const chat = validateMessage({ t: 'chat', name: '<img src=x>', text: 'hi\u0000there' + 'x'.repeat(500) });
  assert.equal(chat.name, 'img srcx');
  assert.ok(!chat.text.includes('\u0000') && chat.text.length === 140);
  assert.equal(validateMessage({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'a' }), null);
  assert.equal(validateMessage({ t: 'welcome', v: PROTOCOL_VERSION, seed: 5, edits: [1, 2, 3] }), null);
  assert.ok(validateMessage({ t: 'welcome', v: PROTOCOL_VERSION, seed: 5, edits: [1, 2, 3, 4] }));
  assert.equal(sanitizeText('a\nb'), 'ab');
});

test('room codes are normalised and validated', () => {
  const code = makeRoomCode();
  assert.equal(code.length, 6);
  assert.equal(normalizeRoomCode(code.toLowerCase()), code);
  assert.equal(normalizeRoomCode('ab-cd-ef'), 'ABCDEF');
  assert.equal(normalizeRoomCode('O0O0O0'), null);
  assert.equal(normalizeRoomCode('ABC'), null);
});

test('rate limiter allows a burst then throttles', () => {
  const allow = createRateLimiter(10, 3);
  const now = 1000;
  assert.ok(allow(now) && allow(now) && allow(now));
  assert.equal(allow(now), false);
  assert.ok(allow(now + 200));
});
