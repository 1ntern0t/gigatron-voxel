// WARDEN [BOT] rules: one test per rule, plus the escalation ladder (warn -> rollback/throttle/mute ->
// kick -> session ban) and incident logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLobby } from './lobby-harness.mjs';
import { B } from '../src/core/blocks.js';
import { RULES_TEXT } from '../src/core/bots/warden.js';

// Fill a column field of breakable blocks (pre-existing world, no owner) around a site.
function field(h, s, count) {
  const cells = [];
  for (let i = 0; cells.length < count; i++) {
    const x = s.x - 3 + (i % 7), z = s.z - 3 + (Math.floor(i / 7) % 7), y = s.y + 1 + Math.floor(i / 49);
    if (Math.abs(x - s.x) < 1 && Math.abs(z - s.z) < 1) continue;
    h.L.world.setBlock(x, y, z, B.STONE);
    cells.push({ x, y, z });
  }
  return cells;
}
const actions = (h, rule) => h.incidents.filter((e) => e.rule === rule).map((e) => e.action);

test('mass-break: warn at 40, rollback + throttle at 60, kick on repeat, ban on the next kick', () => {
  const h = makeLobby();
  const s = h.site();
  const cells = field(h, s, 70);
  const g = h.join('Griefer', { key: 'ip-1' });
  g.teleport(s);
  for (let i = 0; i < 60; i++) {
    g.edit(cells[i].x, cells[i].y, cells[i].z, B.AIR);
    h.advance(120);
  }
  assert.deepEqual(actions(h, 'mass-break').slice(0, 3), ['warn', 'rollback', 'throttle']);
  const restored = cells.slice(0, 60).filter((c) => h.L.world.getBlock(c.x, c.y, c.z) === B.STONE).length;
  assert.ok(restored >= 55, 'grief rolled back (' + restored + '/60 restored)');
  assert.ok(g.peer.throttleUntil > h.now);
  assert.ok(g.chats().some((c) => c.startsWith('WARDEN: Rolled back')));

  // Second offense within memory: kick.
  h.advance(61000);
  for (let i = 0; i < 60; i++) {
    g.edit(cells[i].x, cells[i].y, cells[i].z, B.AIR);
    h.advance(120);
  }
  assert.equal(g.kicked(), true);
  assert.ok(actions(h, 'mass-break').includes('kick'));

  // Same key comes back and does it again: session ban; reconnect refused.
  const g2 = h.join('Griefer', { key: 'ip-1' });
  g2.teleport(s);
  for (let k = 0; k < 2 && !g2.kicked(); k++) {
    h.advance(61000);
    for (let i = 0; i < 60 && !g2.kicked(); i++) {
      g2.edit(cells[i].x, cells[i].y, cells[i].z, B.AIR);
      h.advance(120);
    }
  }
  assert.equal(g2.kicked(), true);
  assert.ok(actions(h, 'mass-break').includes('ban'));
  const g3 = h.join('Again', { key: 'ip-1' });
  assert.equal(g3.refused, true, 'banned key cannot reconnect this session');
});

test("grief-others: breaking another player's fresh build is rolled back", () => {
  const h = makeLobby();
  const s = h.site();
  const alice = h.join('Alice');
  const mal = h.join('Mal');
  alice.teleport(s);
  mal.teleport(s);
  const built = [];
  for (let i = 0; i < 6; i++) {
    const c = { x: s.x + 2, y: s.y + i, z: s.z + 1 };
    alice.edit(c.x, c.y, c.z, B.ALLOY);
    built.push(c);
    h.advance(400);
  }
  assert.ok(built.every((c) => h.L.world.getBlock(c.x, c.y, c.z) === B.ALLOY));
  for (const c of [...built].reverse()) {
    mal.edit(c.x, c.y, c.z, B.AIR);
    h.advance(300);
  }
  assert.ok(actions(h, 'grief-others').includes('warn'));
  assert.ok(actions(h, 'grief-others').includes('rollback'));
  assert.ok(built.every((c) => h.L.world.getBlock(c.x, c.y, c.z) === B.ALLOY), "Alice's build restored");
});

test('protected-area: edits refused, warn after 6 attempts, kick after 30', () => {
  const h = makeLobby();
  const p = h.join('Poker');
  const sp = h.L.spawn;
  const x = Math.floor(sp.x) + 1, z = Math.floor(sp.z) + 1, y = h.L.world.surface(x, z) + 1;
  const before = h.L.world.getBlock(x, y, z);
  for (let i = 0; i < 30 && !p.kicked(); i++) {
    p.edit(x, y, z, B.ALLOY);
    h.advance(200);
  }
  assert.equal(h.L.world.getBlock(x, y, z), before);
  assert.ok(p.of('deny').length >= 1);
  assert.deepEqual(actions(h, 'protected-area'), ['warn', 'kick']);
  assert.equal(p.kicked(), true);
});

test('place-spam: 25 placements in 5 s throttles the player', () => {
  const h = makeLobby();
  const s = h.site();
  const sp = h.join('Spammer');
  sp.teleport(s);
  for (let i = 0; i < 25; i++) {
    sp.edit(s.x - 3 + (i % 7), s.y + Math.floor(i / 7), s.z + 3, B.ALLOY);
    h.advance(100);
  }
  assert.ok(actions(h, 'place-spam').includes('throttle'));
  assert.ok(sp.peer.throttleUntil > h.now);
  const before = h.a.counters.edits;
  for (let i = 0; i < 10; i++) {
    sp.edit(s.x - 3 + i, s.y + 5, s.z - 3, B.ALLOY);
    h.advance(50);
  }
  assert.ok(h.a.counters.edits - before <= 2, 'throttled to about 1 edit/s');
});

test('rate-limit hammering: 20 rate denials in 10 s counts as spam', () => {
  const h = makeLobby();
  const s = h.site();
  const sp = h.join('Hammer');
  sp.teleport(s);
  for (let i = 0; i < 60; i++) sp.edit(s.x + 2, s.y + (i % 2), s.z, i % 2 ? B.ALLOY : B.AIR); // no time passes: burst exhausted
  assert.ok(h.a.counters.denied >= 20);
  assert.ok(actions(h, 'place-spam').includes('throttle'));
});

test('cage-tower: building over another player is rolled back', () => {
  const h = makeLobby();
  const s = h.site();
  const victim = h.join('Victim');
  const caged = h.join('Caged');
  victim.teleport(s);
  caged.teleport(s);
  const cells = [];
  for (let i = 0; i < 6; i++) {
    const c = { x: s.x + (i % 2), y: s.y + 2 + Math.floor(i / 2), z: s.z + 1 };
    caged.edit(c.x, c.y, c.z, B.GLASS);
    cells.push(c);
    h.advance(500);
  }
  assert.ok(actions(h, 'cage-tower').includes('rollback'));
  assert.ok(cells.every((c) => h.L.world.getBlock(c.x, c.y, c.z) === B.AIR));
});

test('chat-spam: the same message 3 times mutes; muted players cannot chat', () => {
  const h = makeLobby();
  const sp = h.join('Repeater');
  const other = h.join('Reader');
  for (let i = 0; i < 3; i++) {
    sp.chat('BUY GOLD at example');
    h.advance(3000);
  }
  assert.ok(actions(h, 'chat-spam').includes('mute'));
  assert.ok(sp.peer.mutedUntil > h.now);
  const seen = other.chats().filter((c) => c.includes('BUY GOLD')).length;
  assert.equal(seen, 2, 'the third copy is not broadcast');
  sp.chat('something else');
  assert.ok(!other.chats().some((c) => c.includes('something else')));
});

test('chat-flood: hammering past the chat rate limit mutes', () => {
  const h = makeLobby();
  const sp = h.join('Flooder');
  for (let i = 0; i < 12; i++) sp.chat('msg ' + i);
  assert.ok(actions(h, 'chat-flood').includes('mute'));
});

test('speed hack: impossible moves are reset, warned at 3, kicked at 10', () => {
  const h = makeLobby();
  const s = h.site();
  const sp = h.join('Zoomer');
  sp.teleport(s);
  h.advance(200);
  for (let i = 0; i < 10 && !sp.kicked(); i++) {
    sp.state(s.x + 50 + i, s.y, s.z); // 50 blocks in 0.2 s
    h.advance(200);
  }
  assert.ok(sp.of('pos').length >= 3, 'client rubber-banded');
  assert.ok(actions(h, 'speed').includes('warn'));
  assert.equal(sp.kicked(), true);
  assert.ok(actions(h, 'speed').includes('kick'));
});

test('flight: hovering in survival for > 2 s resets the player to the ground', () => {
  const h = makeLobby();
  const s = h.site();
  const f = h.join('Flyer');
  f.teleport({ ...s, y: s.y });
  h.advance(100);
  f.state(s.x + 0.5, s.y + 3, s.z + 0.5); // jump up 3
  for (let i = 0; i < 25; i++) {
    h.advance(100);
    f.state(s.x + 0.5, s.y + 6, s.z + 0.5, true);
  }
  assert.ok(h.incidents.some((e) => e.rule === 'flight'));
  const pos = f.of('pos').at(-1);
  assert.ok(pos && pos.y <= s.y + 0.01, 'snapped to the ground');
});

test('/rules and reserved names', () => {
  const h = makeLobby();
  const p = h.join('WARDEN [BOT]');
  assert.ok(!/WARDEN|BOT/i.test(p.peer.name));
  assert.equal(p.peer.bot, false);
  p.chat('/rules');
  assert.ok(p.chats().includes('WARDEN: ' + RULES_TEXT));
  assert.ok(h.a.roster().players.filter((x) => x.bot).map((x) => x.name).sort().join() === 'HIVE,SPARK,WARDEN');
});

test('rollback restores only cells that still hold the offender\'s block', () => {
  const h = makeLobby();
  const s = h.site();
  const a = h.join('A');
  const b = h.join('B');
  a.teleport(s);
  b.teleport(s);
  a.edit(s.x + 2, s.y, s.z, B.ALLOY);
  h.advance(200);
  a.edit(s.x + 3, s.y, s.z, B.ALLOY);
  h.advance(200);
  b.edit(s.x + 3, s.y, s.z, B.AIR); // B removed one of A's blocks
  h.advance(200);
  b.edit(s.x + 3, s.y, s.z, B.GLASS); // and built on the spot
  const n = h.a.rollback(a.id, h.now - 10000);
  assert.equal(n, 1);
  assert.equal(h.L.world.getBlock(s.x + 2, s.y, s.z), B.AIR);
  assert.equal(h.L.world.getBlock(s.x + 3, s.y, s.z), B.GLASS, "B's later block is untouched");
});

test('incidents carry time, rule, action and an anonymous key (no IPs)', () => {
  const h = makeLobby();
  const p = h.join('X', { key: 'abc123' });
  for (let i = 0; i < 3; i++) { p.chat('same same'); h.advance(1000); }
  const e = h.incidents.find((i) => i.rule === 'chat-spam' && i.action === 'mute');
  assert.ok(e && e.t && e.key === 'abc123' && e.name === 'X');
});
