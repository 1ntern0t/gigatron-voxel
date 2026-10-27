// SPARK [BOT] builds a lit plaza with working circuits inside its own plot; HIVE [BOT] greets players,
// runs Crystal Rush, awards the "Crystal Champ" title and posts the scoreboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLobby } from './lobby-harness.mjs';
import { B } from '../src/core/blocks.js';

test('SPARK builds the plaza only inside its plot, and its lamps light up', () => {
  const h = makeLobby({ spark: true });
  h.run(6 * 60000, 100);
  const sp = h.L.spark;
  assert.equal(sp.complete, true, 'plaza finished');
  const lamps = sp.final.filter((c) => c.id === B.LAMP_OFF || c.id === B.LAMP_ON);
  assert.ok(lamps.length >= 8);
  const lit = lamps.filter((c) => h.L.world.getBlock(c.x, c.y, c.z) === B.LAMP_ON).length;
  assert.equal(lit, lamps.length, 'every lamp is lit by the circuit');
  const plaza = h.L.protect[0];
  const sparkEdits = h.a.editLog.filter((e) => e.by === 'bot-spark');
  assert.ok(sparkEdits.length > 100);
  assert.ok(sparkEdits.every((e) => Math.hypot(e.x + 0.5 - plaza.x, e.z + 0.5 - plaza.z) <= plaza.r), 'all SPARK edits inside its plot');
});

test('SPARK repairs its plaza after damage', () => {
  const h = makeLobby({ spark: true });
  h.run(6 * 60000, 100);
  const lamp = h.L.spark.final.find((c) => c.id === B.LAMP_OFF || c.id === B.LAMP_ON);
  h.L.world.setBlock(lamp.x, lamp.y, lamp.z, B.AIR);
  h.run(30000, 100);
  assert.notEqual(h.L.world.getBlock(lamp.x, lamp.y, lamp.z), B.AIR);
});

test('HIVE greets new players publicly and sends a private quest hint', () => {
  const h = makeLobby({ hive: true });
  const a = h.join('Ann');
  const b = h.join('Bob');
  h.run(2000);
  assert.ok(a.chats().some((c) => c.startsWith('HIVE: Welcome, Ann!')));
  assert.ok(b.chats().some((c) => c.startsWith('HIVE: Welcome, Ann!')), 'greeting is public');
  assert.ok(a.chats().some((c) => c.startsWith('HIVE: Quest hint:')));
  assert.ok(!b.chats().some((c) => c.includes('Quest hint') && c.includes('Ann')), 'hint is private');
  a.chat('/help');
  assert.ok(a.chats().some((c) => c.startsWith('HIVE: ') && c.includes('Left-click')));
});

test('HIVE Crystal Rush: crystals spawn, mining scores, the winner gets "Crystal Champ", scoreboard posted', () => {
  const h = makeLobby({ hive: true, hiveOptions: { firstEventMs: 5000, rushMs: 60000, eventEveryMs: 600000 } });
  const a = h.join('Ann');
  const b = h.join('Bob');
  h.run(6000);
  const rush = h.L.hive.rush;
  assert.ok(rush && rush.crystals.size >= 6, 'rush started with crystals');
  assert.ok(a.of('event').some((e) => e.kind === 'rush-start'));
  const cells = [...rush.crystals.values()];
  for (const [i, c] of cells.slice(0, 3).entries()) {
    a.teleport({ x: c.x - 2, y: c.y, z: c.z });
    a.edit(c.x, c.y, c.z, B.AIR);
    h.advance(300 + i);
  }
  b.teleport({ x: cells[3].x - 2, y: cells[3].y, z: cells[3].z });
  b.edit(cells[3].x, cells[3].y, cells[3].z, B.AIR);
  assert.equal(a.peer.stats.crystals, 3);
  h.run(61000, 100);
  assert.equal(h.L.hive.rush, null, 'rush ended');
  assert.equal(a.peer.title, 'Crystal Champ');
  assert.equal(b.peer.title, '');
  assert.ok(cells.slice(4).every((c) => h.L.world.getBlock(c.x, c.y, c.z) !== B.CRYSTAL), 'leftover crystals removed');
  assert.ok(b.chats().some((c) => c.startsWith('HIVE: Crystal Rush over! Crystal Champ: Ann')));
  assert.ok(b.chats().some((c) => c.startsWith('HIVE: Scoreboard: 1. Ann')));
  const roster = b.of('roster').at(-1);
  assert.equal(roster.players.find((p) => p.name === 'Ann').title, 'Crystal Champ');
  a.chat('/score');
  assert.ok(a.chats().some((c) => c.startsWith('HIVE: Scoreboard:')));
});

test('HIVE waits for players before starting a rush; next rush ~10 min after the last', () => {
  const h = makeLobby({ hive: true, hiveOptions: { firstEventMs: 1000 } });
  h.run(5000);
  assert.equal(h.L.hive.rush, null, 'no rush with nobody online');
  h.join('Ann');
  h.run(61000);
  assert.ok(h.L.hive.rush);
  h.run(3 * 60000 + 1000, 200);
  assert.equal(h.L.hive.rush, null);
  const next = h.L.hive.nextEventAt - h.now;
  assert.ok(next > 9 * 60000 && next <= 10 * 60000);
});

test('the roster always shows three [BOT]s with their roles', () => {
  const h = makeLobby();
  const bots = h.a.roster().players.filter((p) => p.bot).map((p) => p.name + ':' + p.title).sort();
  assert.deepEqual(bots, ['HIVE:guide', 'SPARK:builder', 'WARDEN:security']);
});

test('SPARK: restarting from the saved world does not rebuild or move the plaza', async () => {
  const { createLobby } = await import('../src/core/lobby.js');
  const h = makeLobby({ spark: true });
  h.run(10 * 60000, 100);
  const cells = (flat) => { const s = new Set(); for (let i = 0; i < flat.length; i += 4) s.add(flat.slice(i, i + 3).join(',')); return s; };
  let edits = h.L.world.flatEdits();
  const first = cells(edits);
  assert.ok(first.size > 100, 'plaza built');
  for (let r = 0; r < 2; r++) {
    let t = 5e6;
    const L = createLobby({ now: () => t, send() {}, close() {}, edits, hiveOptions: { firstEventMs: 1e12 } });
    for (let i = 0; i < 3000; i++) { t += 100; L.authority.tick(t); }
    edits = L.world.flatEdits();
    assert.deepEqual([...cells(edits)].filter((k) => !first.has(k)), [], 'no new cells after restart ' + (r + 1));
  }
});
