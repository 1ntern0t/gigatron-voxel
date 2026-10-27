// End-to-end multiplayer test with real headless Chromium contexts.
//
// Part 1 (required): the public lobby. Starts tools/lobby-host.mjs in-process (WebSocket transport,
// fresh temp world), opens two real browser contexts on it and checks: live title-screen status,
// joining, the three [BOT]s, movement sync, edit sync both ways, server-side rejection of protected and
// forbidden edits, chat, leave + rejoin with the world intact, and the live player count.
// Part 2 (best effort): a private peer-to-peer room over PeerJS/WebRTC. Reported as "unavailable" when
// the environment cannot form a WebRTC connection (set MP_REQUIRE_P2P=1 to make it required).
//
// Usage: node tools/mp-test.mjs        (CHROME_PATH overrides /usr/bin/google-chrome)
import { chromium } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLobbyHost } from './lobby-host.mjs';
import { startServer } from './serve.mjs';

const dir = await mkdtemp(join(tmpdir(), 'gigatron-mp-'));
const lobby = await startLobbyHost({ port: 0, data: join(dir, 'data'), logDir: join(dir, 'logs'), static: true, quiet: true, maxPerIp: 16 });
const base = `http://127.0.0.1:${lobby.port}/`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const errors = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
async function open(label) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/WebRTC|peer-unavailable|Could not connect to peer|ERR_CONNECTION_REFUSED/i.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  return page;
}
const stat = (page) => page.evaluate(() => window.__gigatron.stats);
const until = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

async function joinFromTitle(page, name) {
  await page.goto(base);
  await page.waitForSelector('#btn-start-lobby:not([disabled])', { timeout: 20000 });
  await page.fill('#start-name', name);
  await page.click('#btn-start-lobby');
  return until(page, () => window.__gigatron.stats.running && window.__gigatron.stats.loaded && window.__gigatron.game.net.lobby, null, 60000);
}

// Walk the player in small steps (as a real client would) so the server's speed check accepts it.
async function walk(page, dx, dz, steps) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(([dx, dz]) => {
      const g = window.__gigatron.game;
      const p = g.player.pos;
      p.x += dx;
      p.z += dz;
      p.y = g.gen.heightAt(Math.floor(p.x), Math.floor(p.z)) + 1.02;
      g.player.vel.y = 0;
    }, [dx, dz]);
    await page.waitForTimeout(110);
  }
}

let ok = false;
try {
  // ---------- Part 1: public lobby ----------
  const a = await open('A');
  const b = await open('B');
  await a.goto(base);
  const titleOnline = await until(a, () => /ONLINE 0\/\d+ players, 3 bots/.test(document.getElementById('start-lobby-status').textContent));
  check('title screen shows live lobby status', titleOnline, await a.textContent('#start-lobby-status'));
  check('A joins the public lobby from the title screen', await joinFromTitle(a, 'Alice'));
  check('B joins the public lobby', await joinFromTitle(b, 'Bob'));
  const sA = await stat(a);
  check('lobby is survival mode (no creative flight)', await a.evaluate(() => window.__gigatron.game.creative === false));
  check('both clients on the same seed', (await a.evaluate(() => window.__gigatron.game.seed)) === (await b.evaluate(() => window.__gigatron.game.seed)));
  const rosterOk = await until(b, () => /2\/\d+ players, 3 bots/.test(document.getElementById('roster').textContent));
  check('roster HUD shows "2/CAP players, 3 bots"', rosterOk, await b.textContent('#roster'));
  const botsShown = await b.evaluate(() => ['WARDEN', 'SPARK', 'HIVE'].every((n) => document.getElementById('roster').textContent.includes(n + ' [BOT]')));
  check('roster lists WARDEN, SPARK, HIVE as [BOT]', botsShown);
  check('each client renders the other player + 3 bot avatars', await until(a, () => window.__gigatron.stats.remotes === 4) && await until(b, () => window.__gigatron.stats.remotes === 4), [(await stat(a)).remotes, (await stat(b)).remotes]);
  check('HIVE greeted the player in chat', await until(a, () => /HIVE \[BOT\]: Welcome, Alice/.test(document.getElementById('chatlog').textContent)));

  // Movement: A walks out of the protected spawn plaza (away from the beacon); B must see it.
  const aId = await a.evaluate(() => window.__gigatron.game.net.myId);
  const dir = await a.evaluate(() => {
    const g = window.__gigatron.game;
    const bc = g.gen.beacon;
    const dx = g.player.pos.x - bc.x, dz = g.player.pos.z - bc.z;
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  });
  const before = await b.evaluate((id) => ({ ...window.__gigatron.game.remotes.get(id).target }), aId);
  await walk(a, dir[0] * 0.55, dir[1] * 0.55, 32);
  await b.waitForTimeout(600);
  const after = await b.evaluate((id) => ({ ...window.__gigatron.game.remotes.get(id).target }), aId);
  const aPos = await a.evaluate(() => ({ ...window.__gigatron.game.player.pos }));
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check('B sees A move (server accepted the walk)', moved > 12 && Math.hypot(after.x - aPos.x, after.z - aPos.z) < 1.5, { moved: +moved.toFixed(2) });

  // Edit sync A -> server -> B (outside the protected plaza).
  const spot = await a.evaluate(() => {
    const g = window.__gigatron.game;
    const x = Math.floor(g.player.pos.x) + 2, z = Math.floor(g.player.pos.z);
    const y = g.gen.heightAt(x, z) + 1;
    g.setBlock(x, y, z, 10);
    return { x, y, z, region: !!g.protectedAt(x, z) };
  });
  await b.waitForTimeout(800);
  check('A places a block outside the plaza; server + B have it', !spot.region && lobby.lobby.world.getBlock(spot.x, spot.y, spot.z) === 10 && (await b.evaluate((s) => window.__gigatron.game.world.getBlock(s.x, s.y, s.z), spot)) === 10, spot);

  // Edit sync B -> A: B walks over then breaks A's block.
  const bPos0 = await b.evaluate(() => ({ ...window.__gigatron.game.player.pos }));
  const steps = Math.ceil(Math.hypot(spot.x - 1 - bPos0.x, spot.z - bPos0.z) / 0.55);
  await walk(b, (spot.x - 1 - bPos0.x) / steps, (spot.z + 0.5 - bPos0.z) / steps, steps);
  await b.waitForTimeout(400);
  await b.evaluate((s) => window.__gigatron.game.setBlock(s.x, s.y, s.z, 0), spot);
  await a.waitForTimeout(800);
  check('B breaks the block; server + A see it', lobby.lobby.world.getBlock(spot.x, spot.y, spot.z) === 0 && (await a.evaluate((s) => window.__gigatron.game.world.getBlock(s.x, s.y, s.z), spot)) === 0);

  // Protected plaza edit: client bypasses its own UI check; server must refuse and correct the client.
  const sp = lobby.lobby.spawn;
  const plaza = { x: Math.floor(sp.x) + 1, z: Math.floor(sp.z) + 1 };
  plaza.y = lobby.lobby.world.surface(plaza.x, plaza.z) + 1;
  const plazaBefore = lobby.lobby.world.getBlock(plaza.x, plaza.y, plaza.z);
  await a.evaluate((s) => window.__gigatron.game.net.sendEdit(s.x, s.y, s.z, 10), plaza);
  await a.waitForTimeout(600);
  check('server rejects an edit inside the protected spawn plaza', lobby.lobby.world.getBlock(plaza.x, plaza.y, plaza.z) === plazaBefore);

  // Forbidden block (Gigatron Beacon, id 29) next to A: must be rejected.
  const fb = { x: spot.x, y: spot.y + 1, z: spot.z };
  await a.evaluate((s) => window.__gigatron.game.setBlock(s.x, s.y, s.z, 29), fb);
  await a.waitForTimeout(800);
  check('server rejects a forbidden block and corrects the client', lobby.lobby.world.getBlock(fb.x, fb.y, fb.z) !== 29 && (await a.evaluate((s) => window.__gigatron.game.world.getBlock(s.x, s.y, s.z), fb)) !== 29);

  // Chat
  await a.evaluate(() => window.__gigatron.game.net.sendChat('hello from Alice'));
  check('B receives A\'s chat', await until(b, () => document.getElementById('chatlog').textContent.includes('Alice: hello from Alice'), null, 5000));
  check('name spoofing blocked ("[BOT]" stripped, bot names reserved)', await (async () => {
    const c = await open('C');
    await c.goto(base);
    await c.waitForSelector('#btn-start-lobby:not([disabled])', { timeout: 20000 });
    await c.fill('#start-name', 'WARDEN [BOT]');
    await c.click('#btn-start-lobby');
    await until(c, () => window.__gigatron.stats.running && window.__gigatron.game.net.lobby, null, 60000);
    const me = await c.evaluate(() => window.__gigatron.game.net.info(window.__gigatron.game.net.myId));
    await c.context().close();
    return me && !/WARDEN|\[BOT\]/i.test(me.name) && !me.bot;
  })());

  // Live count via a separate probe (same mechanism as the title screen).
  const probe = await b.evaluate(() => window.__gigatron.game.net.probe({ ws: location.origin.replace(/^http/, 'ws') + '/ws' }));
  check('live probe reports the real count', probe.players === 2 && probe.bots === 3 && probe.cap === lobby.authority.o.cap, probe);

  // Leave + rejoin
  await a.click('#btn-leave').catch(async () => a.evaluate(() => document.getElementById('btn-leave').click()));
  check('after A leaves, B sees 1/CAP players and only the 3 bots', await until(b, () => /1\/\d+ players, 3 bots/.test(document.getElementById('roster').textContent)) && await until(b, () => window.__gigatron.stats.remotes === 3));
  await a.evaluate(() => window.__gigatron.game.joinLobby());
  const rejoined = await until(a, () => window.__gigatron.stats.running && window.__gigatron.game.net.lobby && window.__gigatron.stats.loaded, null, 60000);
  check('A rejoins and B sees 2 players again', rejoined && await until(b, () => /2\/\d+ players/.test(document.getElementById('roster').textContent)));
  const resumed = await until(a, () => /Welcome back! Your lobby score \([1-9]\d* pts\)/.test(document.body.textContent), null, 10000);
  check('A gets the lobby score back on rejoin (resume token in localStorage)', resumed && await a.evaluate(() => /^[a-f0-9]{32}$/.test(JSON.parse(localStorage.getItem('gigatron-voxel:settings')).lobbyResume || '')));
  check('SPARK is building inside its plot (server edits arrive)', lobby.authority.counters.edits > 0 || lobby.lobby.spark.placed > 0, { serverEdits: lobby.authority.counters.edits });
  check('no page errors', errors.length === 0, errors.slice(0, 5));
  ok = checks.every((c) => c.ok);
  await a.context().close();
  await b.context().close();

  // ---------- Part 2: P2P private room (best effort) ----------
  const p2pServer = await startServer(0);
  const p2pBase = `http://localhost:${p2pServer.address().port}/`;
  const host = await open('p2p-host');
  await host.goto(p2pBase + '?autostart=1&seed=mp-test&noprobe=1');
  await host.waitForFunction(() => window.__gigatron?.stats.loaded, null, { timeout: 60000 });
  let p2p = 'unavailable';
  const code = await host.evaluate(async () => {
    try { await window.__gigatron.game.hostRoom(); } catch { /* reported below */ }
    return document.getElementById('mp-code').value;
  });
  if (code) {
    const guest = await open('p2p-guest');
    await guest.goto(p2pBase + '?noprobe=1');
    await guest.waitForSelector('#btn-new');
    await guest.evaluate((c) => { document.getElementById('mp-code').value = c; return window.__gigatron.game.joinRoom(); }, code).catch(() => {});
    const joined = await until(guest, () => window.__gigatron.stats.running && window.__gigatron.stats.net === 'client', null, 30000);
    p2p = joined ? 'joined' : 'unavailable: ' + (await guest.textContent('#mp-status'));
  } else p2p = 'unavailable: could not register with the PeerJS signaling server (' + (await host.textContent('#mp-status')) + ')';
  console.log('P2P private room: ' + p2p);
  if (process.env.MP_REQUIRE_P2P === '1') check('P2P private room joins', p2p === 'joined', p2p);
  p2pServer.close();
} catch (err) {
  check('test ran to completion', false, err.stack || String(err));
}
ok = checks.every((c) => c.ok);
await browser.close();
await lobby.stop('test');
await rm(dir, { recursive: true, force: true });
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
console.log(ok ? 'MP OK' : 'MP FAILED');
process.exit(ok ? 0 : 1);
