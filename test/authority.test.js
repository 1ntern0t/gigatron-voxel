// The authoritative host (core/authority.js) used by both the browser P2P host and the public lobby:
// validation, movement checks, protected regions, caps, malformed traffic, probes and roster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLobby } from './lobby-harness.mjs';
import { B } from '../src/core/blocks.js';
import { validateClientMessage, validateHostMessage, parseWire, sanitizeName, isReservedName, MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION } from '../src/core/protocol.js';

test('protocol v2: client messages are strictly shaped, oversize input is dropped before parsing', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(parseWire('x'.repeat(MAX_CLIENT_MESSAGE_BYTES + 1), MAX_CLIENT_MESSAGE_BYTES), null);
  assert.equal(parseWire('{bad json', 100), null);
  assert.equal(parseWire({ t: 'chat', text: 'x'.repeat(200) }, 100), null, 'objects are size-checked too');
  assert.equal(parseWire(new Uint8Array(10), 100), null, 'binary frames are rejected');
  assert.deepEqual(validateClientMessage({ t: 'edit', x: 1, y: 2, z: 3, id: B.ALLOY, junk: 1 }), { t: 'edit', x: 1, y: 2, z: 3, id: B.ALLOY });
  assert.equal(validateClientMessage({ t: 'edit', x: 1.5, y: 2, z: 3, id: 1 }), null);
  assert.equal(validateClientMessage({ t: 'state', x: 0, y: 1e9, z: 0, yaw: 0, pitch: 0 }), null);
  assert.equal(validateClientMessage({ t: 'snap', s: [] }), null, 'clients cannot send host messages');
  assert.equal(validateClientMessage({ t: 'quest', index: 99 }), null);
  assert.ok(validateClientMessage({ t: 'probe' }));
  assert.equal(validateHostMessage({ t: 'roster', cap: 24, players: [{ p: 'p1', name: 'A', bot: false, color: 1, title: '', score: 1, placed: 1, crystals: 0, quests: 0 }] }).players.length, 1);
  assert.equal(sanitizeName('[BOT] Eve'), 'BOT Eve');
  assert.ok(isReservedName('warden') && isReservedName('Admin') && !isReservedName('Wardrobe'));
});

test('welcome describes the lobby: survival, cap, protected regions, spawn', () => {
  const h = makeLobby();
  const p = h.join('Ann');
  const w = p.of('welcome')[0];
  assert.equal(w.mode, 'survival');
  assert.equal(w.cap, h.a.o.cap);
  assert.equal(w.lobby, true);
  assert.deepEqual(w.protect.map((r) => r.label), ['spawn plaza', 'Gigatron Beacon']);
  assert.deepEqual(w.spawn, h.L.spawn);
});

test('edits: reach, unbreakable, occupied, forbidden, protected and switch toggles', () => {
  const h = makeLobby();
  const s = h.site();
  const p = h.join('Ann');
  p.teleport(s);
  p.edit(s.x + 2, s.y, s.z, B.ALLOY);
  assert.equal(h.L.world.getBlock(s.x + 2, s.y, s.z), B.ALLOY, 'valid placement');
  h.advance(100);
  p.edit(s.x + 2, s.y, s.z, B.GLASS);
  assert.equal(h.L.world.getBlock(s.x + 2, s.y, s.z), B.ALLOY, 'occupied cell refused');
  p.edit(s.x + 20, s.y, s.z, B.ALLOY);
  assert.equal(h.L.world.getBlock(s.x + 20, s.y, s.z), B.AIR, 'out of reach refused');
  for (const id of [B.BEDROCK, B.CORE, B.BEACON, B.FLUID, B.WIRE_ON, B.LAMP_ON, B.SWITCH_ON]) {
    p.edit(s.x + 1, s.y + 2, s.z, id);
    assert.equal(h.L.world.getBlock(s.x + 1, s.y + 2, s.z), B.AIR, 'forbidden ' + id);
    h.advance(100);
  }
  h.L.world.setBlock(s.x + 1, s.y - 1, s.z, B.BEDROCK);
  p.edit(s.x + 1, s.y - 1, s.z, B.AIR);
  assert.equal(h.L.world.getBlock(s.x + 1, s.y - 1, s.z), B.BEDROCK, 'unbreakable');
  p.edit(s.x - 2, s.y, s.z, B.SWITCH_OFF);
  h.advance(100);
  p.edit(s.x - 2, s.y, s.z, B.SWITCH_ON);
  assert.equal(h.L.world.getBlock(s.x - 2, s.y, s.z), B.SWITCH_ON, 'switch toggling allowed');
  const corrections = p.of('edit').filter((m) => m.x === s.x + 20);
  assert.equal(corrections.length, 1, 'denied edits are corrected on the client');
});

test('protected regions block players but not the server bots', () => {
  const h = makeLobby({ spark: true });
  const p = h.join('Ann');
  const sp = h.L.spawn;
  const x = Math.floor(sp.x) + 2, z = Math.floor(sp.z);
  const y = h.L.world.surface(x, z) + 1;
  p.edit(x, y, z, B.ALLOY);
  assert.notEqual(h.L.world.getBlock(x, y, z), B.ALLOY);
  assert.match(p.of('deny')[0].reason, /protected/);
  h.run(20000);
  assert.ok(h.L.spark.placed > 5, 'SPARK builds inside the plaza');
});

test('movement: walking is accepted, teleports are rubber-banded', () => {
  const h = makeLobby();
  const s = h.site();
  const p = h.join('Ann');
  p.teleport(s);
  for (let i = 1; i <= 10; i++) {
    h.advance(100);
    p.state(s.x + 0.5 + i * 0.6, s.y, s.z + 0.5);
  }
  assert.equal(p.of('pos').length, 0);
  assert.ok(Math.abs(p.peer.pos.x - (s.x + 6.5)) < 0.01);
  h.advance(100);
  p.state(s.x + 40, s.y, s.z);
  assert.equal(p.of('pos').length, 1);
  assert.ok(Math.abs(p.peer.pos.x - (s.x + 6.5)) < 0.01, 'server keeps the last valid position');
});

test('cap: humans beyond the cap are refused with a clear message; bots do not count', () => {
  const h = makeLobby({ cap: 2 });
  h.join('A');
  h.join('B');
  const c = h.join('C');
  assert.match(c.of('kick')[0].reason, /full \(2\/2 players\)/);
  assert.equal(c.kicked(), true);
  assert.equal(h.a.status().players, 2);
  assert.equal(h.a.status().bots, 3);
});

test('probe answers with the live count without joining', () => {
  const h = makeLobby();
  h.join('A');
  h.a.connect('probe1');
  h.a.receive('probe1', JSON.stringify({ t: 'probe' }));
  const st = h.out.get('probe1')[0];
  assert.deepEqual({ t: st.t, players: st.players, bots: st.bots, open: st.open }, { t: 'status', players: 1, bots: 3, open: true });
  assert.ok(h.closed.includes('probe1'));
});

test('malformed and oversize traffic is counted and the sender kicked after 25', () => {
  const h = makeLobby();
  const p = h.join('Junk');
  for (let i = 0; i < 26; i++) p.raw(i % 2 ? '{"t":"edit","x":"a"}' : 'x'.repeat(4000));
  assert.ok(h.a.counters.oversize >= 13);
  assert.equal(p.kicked(), true);
});

test('message flood: excessive messages are dropped, then the sender is kicked', () => {
  const h = makeLobby();
  const p = h.join('Flood');
  for (let i = 0; i < 700; i++) p.send({ t: 'state', x: 0.5, y: 31, z: -1.5, yaw: 0, pitch: 0 });
  assert.ok(h.a.counters.rateLimited > 0);
  assert.equal(p.kicked(), true);
});

test('roster: real counts, bot labels, scores, titles and colors; quests capped', () => {
  const h = makeLobby();
  const s = h.site();
  const a = h.join('Ann');
  a.teleport(s);
  a.edit(s.x + 2, s.y, s.z, B.ALLOY);
  a.send({ t: 'quest', index: 0 });
  a.send({ t: 'quest', index: 0 });
  h.run(1200);
  const r = a.of('roster').at(-1);
  const me = r.players.find((p) => p.p === a.id);
  assert.equal(me.score, 1 + 5);
  assert.equal(me.quests, 1, 'duplicate quest reports ignored');
  assert.equal(r.players.filter((p) => p.bot).length, 3);
  assert.ok(r.players.every((p) => Number.isInteger(p.color)));
});

test('snapshots: batched, exclude the receiver, include the bots', () => {
  const h = makeLobby();
  const a = h.join('Ann');
  h.join('Bob');
  h.run(300);
  const snap = a.of('snap').at(-1);
  const ids = snap.s.map((e) => e[0]);
  assert.ok(!ids.includes(a.id));
  assert.ok(ids.includes('bot-warden') && ids.includes('bot-spark') && ids.includes('bot-hive'));
});
