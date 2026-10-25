import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeWorld, deserializeWorld, encodeEdits, decodeEdits, SaveStore, memoryAdapter } from '../src/core/save.js';
import { createQuestState, applyQuestEvent } from '../src/core/quests.js';
import { B, ITEM_DRONE_POD } from '../src/core/blocks.js';
import { CHUNK_VOLUME } from '../src/core/constants.js';

function sampleState() {
  const edits = new Map([
    ['0,0', new Map([[10, B.CHROME], [5, B.AIR]])],
    ['-3,7', new Map([[CHUNK_VOLUME - 1, B.LAMP_ON]])],
  ]);
  const inventory = new Array(36).fill(null);
  inventory[0] = { id: B.CHROME, count: 64 };
  inventory[4] = { id: ITEM_DRONE_POD, count: 2 };
  let quests = createQuestState();
  quests = applyQuestEvent(quests, { type: 'reach_beacon' }).state;
  return {
    name: 'Test World', seed: 123456, seedText: 'neon', time: 321.5, creative: true,
    player: { x: 1.5, y: 40, z: -2.25, yaw: 1, pitch: -0.2 }, selected: 4, inventory, quests,
    drones: [{ x: 1, y: 2, z: 3, mode: 'work', hub: '4,30,4' }],
    hubs: [{ key: '4,30,4', x: 4, y: 30, z: 4, order: 1, storage: { [B.CRYSTAL]: 7 } }],
    tamed: ['w1,2', 'beacon0'], edits,
  };
}

test('serialize -> deserialize round-trips all world state', () => {
  const s = sampleState();
  const back = deserializeWorld(serializeWorld(s));
  assert.equal(back.name, s.name);
  assert.equal(back.seed, s.seed);
  assert.equal(back.seedText, 'neon');
  assert.equal(back.time, 321.5);
  assert.equal(back.creative, true);
  assert.deepEqual(back.player, s.player);
  assert.equal(back.selected, 4);
  assert.deepEqual(back.inventory, s.inventory);
  assert.deepEqual(back.quests, s.quests);
  assert.deepEqual(back.drones, s.drones);
  assert.deepEqual(back.hubs, s.hubs);
  assert.deepEqual(back.tamed, s.tamed);
  assert.deepEqual([...back.edits.keys()].sort(), [...s.edits.keys()].sort());
  assert.equal(back.edits.get('0,0').get(10), B.CHROME);
  assert.equal(back.edits.get('0,0').get(5), B.AIR);
  assert.equal(back.edits.get('-3,7').get(CHUNK_VOLUME - 1), B.LAMP_ON);
});

test('edit encoding is compact, sorted and skips empty chunks', () => {
  const enc = encodeEdits(new Map([['1,1', new Map([[9, 2], [3, 4]])], ['2,2', new Map()]]));
  assert.deepEqual(enc, { '1,1': [3, 4, 9, 2] });
  assert.deepEqual([...decodeEdits(enc).get('1,1')], [[3, 4], [9, 2]]);
});

test('corrupt or hostile saves are rejected', () => {
  assert.throws(() => deserializeWorld('{not json'), /JSON/);
  assert.throws(() => deserializeWorld('{"format":"other"}'), /Not a Gigatron/);
  const good = JSON.parse(serializeWorld(sampleState()));
  assert.throws(() => deserializeWorld({ ...good, v: 99 }), /version/);
  assert.throws(() => deserializeWorld({ ...good, edits: { '0,0': [0, 250] } }), /block id/);
  assert.throws(() => deserializeWorld({ ...good, edits: { '0,0': [CHUNK_VOLUME, 1] } }), /index/);
  assert.throws(() => deserializeWorld({ ...good, edits: { '__proto__x': [0, 1] } }), /chunk key/);
});

test('invalid inventory entries are dropped rather than trusted', () => {
  const good = JSON.parse(serializeWorld(sampleState()));
  good.inventory[1] = { id: 999, count: 5 };
  good.inventory[2] = { id: B.STONE, count: -3 };
  const back = deserializeWorld(good);
  assert.equal(back.inventory[1], null);
  assert.equal(back.inventory[2], null);
  assert.equal(back.inventory.length, 36);
});

test('SaveStore saves, lists, loads and removes worlds', async () => {
  const store = new SaveStore(memoryAdapter());
  const s = sampleState();
  const bytes = await store.save(s);
  assert.ok(bytes > 100 && bytes < 5000);
  await store.save({ ...s, name: 'Second' });
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.ok(list.some((w) => w.name === 'Test World'));
  const loaded = await store.load('Test World');
  assert.equal(loaded.seed, s.seed);
  await store.remove('Test World');
  assert.equal(await store.load('Test World'), null);
  assert.equal((await store.list()).length, 1);
});
