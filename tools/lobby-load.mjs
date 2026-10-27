// Load test for the public lobby host. For each player count N it starts a FRESH host process
// (tools/lobby-host.mjs, cap 64) and connects N scripted WebSocket players that walk at normal speed
// (10 state msgs/s each, like the real client), chat now and then, and place + break a block every
// few seconds. It reports server tick time, host CPU, host upstream bandwidth and per-client download.
//
//   node tools/lobby-load.mjs [--counts 8,16,24,32,48] [--secs 30]
//
// Everything runs on this machine (clients and host share the CPU), so the numbers are a
// conservative upper bound on host cost; real players add network latency, not host CPU.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { VoxelStore } from '../src/core/voxelstore.js';
import { parseSeed } from '../src/core/rng.js';
import { HEIGHT } from '../src/core/constants.js';
import { B } from '../src/core/blocks.js';
import { LOBBY_SEED_TEXT } from '../src/core/lobby-config.js';
import { PROTOCOL_VERSION } from '../src/core/protocol.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const counts = arg('--counts', '8,16,24,32,48').split(',').map(Number);
const secs = Number(arg('--secs', 30));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = new VoxelStore(parseSeed(LOBBY_SEED_TEXT));
const H = HEIGHT;
const SPAWN = store.gen.findSpawn();

function cpuTicks(pid) {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(f[11]) + Number(f[12]); // utime + stime, in clock ticks (100/s)
}

async function startHost(port, dir) {
  const p = spawn(process.execPath, [join(root, 'tools/lobby-host.mjs'), '--port', String(port), '--cap', '64',
    '--max-per-ip', '200', '--data', join(dir, 'data'), '--log-dir', join(dir, 'logs'), '--quiet'], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return p; } catch { /* not up yet */ }
    await sleep(100);
  }
  p.kill();
  throw new Error('host did not start');
}

function player(port, i, spawnPt) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const me = { ws, bytes: 0, msgs: 0, kicked: null, welcome: false, denies: 0, corrections: 0, timers: [] };
  const ang0 = (i / 7) * Math.PI * 2;
  const radius = 18 + (i % 6) * 2;
  let t = 0;
  let pos = null;
  ws.on('message', (d) => {
    me.bytes += d.length; me.msgs++;
    const m = JSON.parse(d.toString());
    if (m.t === 'welcome') {
      me.welcome = true;
      store.loadFlatEdits?.(m.edits);
    } else if (m.t === 'edit') store.setBlock(m.x, m.y, m.z, m.id);
    else if (m.t === 'deny') { me.denies++; (me.denyReasons ||= new Set()).add(m.reason); }
    else if (m.t === 'pos') { me.corrections++; pos = { x: m.x, y: m.y, z: m.z }; }
    else if (m.t === 'kick') me.kicked = m.reason;
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Load' + i }));
    // Walk (3.5 blocks/s, stepping up at most one block, like the real client) toward a point that
    // circles a ring around spawn. Server corrections ('pos') are honoured, as the real client does.
    me.timers.push(setInterval(() => {
      if (!me.welcome || ws.readyState !== 1) return;
      if (!pos) pos = { x: spawnPt.x, y: spawnPt.y, z: spawnPt.z };
      t += 0.1;
      const a = ang0 + (t * 3.5) / radius;
      const tx = spawnPt.x + Math.cos(a) * radius, tz = spawnPt.z + Math.sin(a) * radius;
      const dx = tx - pos.x, dz = tz - pos.z, d = Math.hypot(dx, dz) || 1;
      const step = Math.min(d, 0.35);
      const x = pos.x + (dx / d) * step, z = pos.z + (dz / d) * step;
      const y = store.groundBelow(x, pos.y + 1.0, z, 0) + 1;
      if (y > pos.y + 1.05) return; // wall: wait for the ring point to move on
      pos = { x, y, z };
      ws.send(JSON.stringify({ t: 'state', x, y, z, yaw: a, pitch: 0 }));
    }, 100));
    let phase = 0;
    me.timers.push(setInterval(() => {
      if (!pos || ws.readyState !== 1 || t < 8) return;
      const bx = Math.floor(pos.x) + 1, bz = Math.floor(pos.z);
      const by = store.groundBelow(bx + 0.5, H - 1, bz + 0.5, 0) + 1;
      if (phase++ % 2 === 0) {
        ws.send(JSON.stringify({ t: 'edit', x: bx, y: by, z: bz, id: B.ALLOY }));
        me.last = [bx, by, bz];
      } else if (me.last) ws.send(JSON.stringify({ t: 'edit', x: me.last[0], y: me.last[1], z: me.last[2], id: B.AIR }));
    }, 2000 + (i % 5) * 300));
    me.timers.push(setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'chat', text: 'load test ' + i + ' ' + Date.now() % 1000 })), 15000 + i * 97));
  });
  ws.on('close', () => me.timers.forEach(clearInterval));
  return me;
}

async function run(n, port) {
  const dir = await mkdtemp(join(tmpdir(), 'lobby-load-'));
  const host = await startHost(port, dir);
  const spawnPt = { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z };
  const players = [];
  for (let i = 0; i < n; i++) { players.push(player(port, i, spawnPt)); await sleep(30); }
  await sleep(3000); // settle: everyone joined and walking
  const s0 = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  const c0 = cpuTicks(host.pid); const t0 = Date.now();
  const b0 = players.reduce((a, p) => a + p.bytes, 0);
  await sleep(secs * 1000);
  const s1 = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  const c1 = cpuTicks(host.pid); const dt = (Date.now() - t0) / 1000;
  const b1 = players.reduce((a, p) => a + p.bytes, 0);
  const joined = players.filter((p) => p.welcome).length;
  const kicked = players.filter((p) => p.kicked).map((p) => p.kicked);
  const res = {
    players: n, joined, reportedPlayers: s1.players, kicked: kicked.length, kickReasons: [...new Set(kicked)].slice(0, 3),
    hostCpuPct: +(((c1 - c0) / 100 / dt) * 100).toFixed(1),
    tickAvgMs: s1.tickAvgMs, tickMaxMs: s1.tickMaxMs, memMB: s1.memMB,
    hostUpKBps: +(((b1 - b0) / dt) / 1024).toFixed(1),
    perClientDownKBps: +(((b1 - b0) / dt / Math.max(1, joined)) / 1024).toFixed(2),
    denies: players.reduce((a, p) => a + p.denies, 0), corrections: players.reduce((a, p) => a + p.corrections, 0),
    denyReasons: [...new Set(players.flatMap((p) => [...(p.denyReasons || [])]))].slice(0, 4),
    serverEditsAccepted: (s1.counters?.edits ?? 0) - (s0.counters?.edits ?? 0),
  };
  for (const p of players) p.ws.terminate();
  host.kill('SIGTERM');
  await new Promise((r) => host.on('exit', r));
  await rm(dir, { recursive: true, force: true });
  return res;
}

console.log(`lobby load test: ${cpus().length} CPU (${cpus()[0]?.model}), ${secs}s per step, Node ${process.version}`);
const results = [];
let port = 18900;
for (const n of counts) {
  const r = await run(n, port++);
  results.push(r);
  console.log(JSON.stringify(r));
}
console.log('\n players | joined | kicked | host CPU % | tick avg/max ms | host up KB/s | per-client down KB/s | RSS MB');
for (const r of results) {
  console.log(` ${String(r.players).padStart(7)} | ${String(r.joined).padStart(6)} | ${String(r.kicked).padStart(6)} | ${String(r.hostCpuPct).padStart(10)} | ${(r.tickAvgMs + ' / ' + r.tickMaxMs).padStart(15)} | ${String(r.hostUpKBps).padStart(12)} | ${String(r.perClientDownKBps).padStart(20)} | ${r.memMB}`);
}
process.exit(0);
