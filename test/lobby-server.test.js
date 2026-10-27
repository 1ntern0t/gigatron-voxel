// tools/lobby-host.mjs over real WebSockets on localhost: endpoints, joins, relay, limits, static
// file allow-list, incident log, and restart-safe persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startLobbyHost } from '../tools/lobby-host.mjs';
import { B } from '../src/core/blocks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const c = {
    ws, msgs,
    opened: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); ws.on('unexpected-response', (_, r) => rej(new Error('HTTP ' + r.statusCode))); }),
    closed: new Promise((res) => ws.on('close', (code) => res(code))),
    send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
    wait: async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = msgs.find(pred);
        if (m) return m;
        await sleep(20);
      }
      throw new Error('timeout waiting for message');
    },
  };
  return c;
}

test('lobby host: health, probe, join, relay, chat, limits, static allow-list, incidents, persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobby-test-'));
  const opts = { port: 0, data: join(dir, 'data'), logDir: join(dir, 'logs'), static: true, quiet: true, maxPerIp: 3, saveMs: 100000 };
  let host = await startLobbyHost(opts);
  try {
    const base = `http://127.0.0.1:${host.port}`;
    const health = await fetch(base + '/health');
    assert.equal(health.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(Object.keys(await health.json()).sort(), ['bots', 'cap', 'ok', 'players', 'uptimeSec']);
    const status = await (await fetch(base + '/status')).json();
    assert.equal(status.bots, 3);
    assert.equal(status.players, 0);
    assert.deepEqual(await (await fetch(base + '/lobby.json')).json(), { ws: 'same-origin', peer: null });
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/src/main.js')).status, 200);
    for (const path of ['/lobby-data/world.json', '/data/world.json', '/package.json', '/.git/config', '/%2e%2e/etc/passwd', '/node_modules/ws/index.js', '/logs/lobby-incidents.log']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }

    const probe = client(host.port);
    await probe.opened;
    probe.send({ t: 'probe' });
    const st = await probe.wait((m) => m.t === 'status');
    assert.equal(st.players, 0);
    await probe.closed;

    const a = client(host.port);
    const b = client(host.port);
    await Promise.all([a.opened, b.opened]);
    a.send({ t: 'hello', v: 2, name: 'Ann' });
    b.send({ t: 'hello', v: 2, name: 'Bob' });
    const wa = await a.wait((m) => m.t === 'welcome');
    assert.equal(wa.mode, 'survival');
    assert.match(wa.resume, /^[a-f0-9]{32}$/, 'lobby issues a resume token');
    await b.wait((m) => m.t === 'welcome');

    // Place a block outside the plaza: walk there legitimately first.
    const L = host.lobby;
    const s = { x: Math.floor(L.spawn.x), z: Math.floor(L.spawn.z) - 16 };
    const peerA = host.authority.peers.get(wa.id);
    peerA.pos = { x: s.x + 0.5, y: L.world.surface(s.x, s.z) + 1, z: s.z + 0.5, yaw: 0, pitch: 0 };
    const y = L.world.surface(s.x + 2, s.z) + 1;
    assert.equal(host.lobby.authority.inProtected(s.x + 2, s.z), null);
    a.send({ t: 'edit', x: s.x + 2, y, z: s.z, id: B.ALLOY });
    await b.wait((m) => m.t === 'edit' && m.x === s.x + 2 && m.y === y && m.id === B.ALLOY);
    a.send({ t: 'chat', text: 'hi bob' });
    await b.wait((m) => m.t === 'chat' && m.name === 'Ann' && m.text === 'hi bob');
    await a.wait((m) => m.t === 'snap' && m.s.some((e) => e[0] === 'bot-spark'));

    // Chat spam -> WARDEN mute -> incident log line.
    for (let i = 0; i < 3; i++) {
      a.send({ t: 'chat', text: 'spam spam' });
      await sleep(1300);
    }
    await a.wait((m) => m.t === 'chat' && m.name === 'WARDEN' && /Muted/.test(m.text));

    // Per-IP connection cap (3): a + b + c ok, the 4th is refused with 429.
    const c = client(host.port);
    await c.opened;
    const d = client(host.port);
    await assert.rejects(d.opened, /429/);
    c.ws.close();

    // Oversize frame: the socket is closed (1009) before the payload is parsed.
    b.send('x'.repeat(5000));
    assert.equal(await b.closed, 1009);

    await sleep(1200);
    const incidents = await readFile(host.incidentFile, 'utf8');
    assert.match(incidents, /"rule":"chat-spam","action":"mute"/);
    assert.doesNotMatch(incidents, /127\.0\.0\.1/, 'no IP addresses in the incident log');

    // Restart: the edit survives.
    a.ws.close();
    await host.stop('test');
    host = await startLobbyHost(opts);
    assert.equal(host.lobby.world.getBlock(s.x + 2, y, s.z), B.ALLOY, 'world persisted across restart');
    const e = client(host.port);
    await e.opened;
    e.send({ t: 'hello', v: 2, name: 'Eve' });
    const we = await e.wait((m) => m.t === 'welcome');
    const flat = we.edits;
    let found = false;
    for (let i = 0; i < flat.length; i += 4) if (flat[i] === s.x + 2 && flat[i + 1] === y && flat[i + 2] === s.z && flat[i + 3] === B.ALLOY) found = true;
    assert.ok(found, 'rejoining players receive the persisted edit');
    e.ws.close();

    // Ann comes back with her resume token after the restart: her score is restored.
    const scores = await readFile(host.scoresFile, 'utf8');
    assert.ok(!scores.includes(wa.resume), 'raw resume tokens are not written to disk');
    const a2 = client(host.port);
    await a2.opened;
    a2.send({ t: 'hello', v: 2, name: 'Ann', resume: wa.resume });
    await a2.wait((m) => m.t === 'chat' && /Welcome back/.test(m.text));
    const ro = await a2.wait((m) => m.t === 'roster' && m.players.some((p) => p.name === 'Ann' && p.placed >= 1));
    assert.ok(ro);
    const st2 = await (await fetch(`http://127.0.0.1:${host.port}/status`)).json();
    assert.deepEqual(st2.botsOnline.sort(), ['HIVE', 'SPARK', 'WARDEN']);
    assert.ok(st2.lastTickAgoMs < 1000);
    a2.ws.close();
  } finally {
    await host.stop('test');
    await rm(dir, { recursive: true, force: true });
  }
});
