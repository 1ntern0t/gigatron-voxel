// GIGATRON public lobby host: one persistent, authoritative survival world with three server bots
// (WARDEN, SPARK, HIVE), served to browsers over WebSocket.
//
//   node tools/lobby-host.mjs [--port 8787] [--bind 127.0.0.1] [--data ./lobby-data] [--log-dir ./logs]
//                             [--cap 24] [--seed gigatron-public] [--static] [--trust-proxy] [--max-per-ip 4]
//
// Endpoints: GET /health, GET /status (CORS, JSON), WebSocket /ws, and with --static the game itself
// plus a /lobby.json that points the game at this host (so http://host:port/ is a ready-to-play lobby).
// Only the game files are served (never the data dir). No accounts, no tracking: connection keys are
// salted hashes of the client IP, kept in memory only and used for rate limits and session bans.
import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, stat, appendFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createLobby } from '../src/core/lobby.js';
import { LOBBY_CAP, LOBBY_SEED_TEXT } from '../src/core/lobby-config.js';
import { MAX_CLIENT_MESSAGE_BYTES } from '../src/core/protocol.js';
import { createScorebook } from '../src/core/scorebook.js';

const root = resolve(new URL('..', import.meta.url).pathname);

export function parseArgs(argv) {
  const o = {
    port: Number(process.env.LOBBY_PORT || 8787), bind: process.env.LOBBY_BIND || '127.0.0.1',
    data: process.env.LOBBY_DATA || join(root, 'lobby-data'), logDir: process.env.LOBBY_LOG_DIR || join(root, 'logs'),
    cap: LOBBY_CAP, seed: LOBBY_SEED_TEXT, static: false, trustProxy: false, maxPerIp: 4, saveMs: 15000, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--port') o.port = Number(v());
    else if (a === '--bind') o.bind = v();
    else if (a === '--data') o.data = resolve(v());
    else if (a === '--log-dir') o.logDir = resolve(v());
    else if (a === '--cap') o.cap = Number(v());
    else if (a === '--seed') o.seed = v();
    else if (a === '--static') o.static = true;
    else if (a === '--trust-proxy') o.trustProxy = true;
    else if (a === '--max-per-ip') o.maxPerIp = Number(v());
    else if (a === '--save-ms') o.saveMs = Number(v());
    else if (a === '--quiet') o.quiet = true;
    else throw new Error('Unknown argument: ' + a);
  }
  if (!(o.cap >= 1 && o.cap <= 64)) throw new Error('--cap must be 1..64');
  return o;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
// Only these top-level paths are served with --static (never lobby-data/, logs/, node_modules/, .git/).
const STATIC_ALLOW = /^\/(index\.html|styles\.css|favicon\.svg|manifest\.webmanifest|sw\.js|src\/.+\.js|vendor\/.+\.(js|json)|assets\/.+)$/;

export async function startLobbyHost(opts = {}) {
  const o = { ...parseArgs([]), ...opts };
  const started = Date.now();
  const salt = randomBytes(16);
  const log = (msg, extra) => {
    if (o.quiet) return;
    console.log(new Date().toISOString() + ' ' + msg + (extra ? ' ' + JSON.stringify(extra) : ''));
  };
  await mkdir(o.data, { recursive: true });
  await mkdir(o.logDir, { recursive: true });
  const incidentFile = join(o.logDir, 'lobby-incidents.log');
  const worldFile = join(o.data, 'world.json');
  const scoresFile = join(o.data, 'scores.json');

  // ----- persistence (restart-safe) -----
  let saved = null;
  if (existsSync(worldFile)) {
    try {
      saved = JSON.parse(readFileSync(worldFile, 'utf8'));
      if (saved?.v !== 1 || saved.seedText !== o.seed || !Array.isArray(saved.edits) || saved.edits.length % 4) throw new Error('incompatible save');
      log('loaded world', { edits: saved.edits.length / 4, savedAt: saved.savedAt });
    } catch (err) {
      log('ignoring unreadable world save: ' + err.message);
      saved = null;
    }
  }

  let savedScores = null;
  if (existsSync(scoresFile)) {
    try {
      savedScores = JSON.parse(readFileSync(scoresFile, 'utf8'));
      if (savedScores?.v !== 1 || typeof savedScores.entries !== 'object') throw new Error('incompatible scores');
    } catch (err) {
      log('ignoring unreadable scores file: ' + err.message);
      savedScores = null;
    }
  }
  const scorebook = createScorebook({
    hash: (t) => createHash('sha256').update('gigatron-resume:' + t).digest('hex'),
    randomToken: () => randomBytes(16).toString('hex'),
    entries: savedScores?.entries || null,
  });
  if (savedScores) log('loaded scores', { players: scorebook.size });

  const sockets = new Map(); // id -> { ws, key, ip, alive }
  const stats = { bytesOut: 0, msgsOut: 0, bytesIn: 0, msgsIn: 0, ticks: 0, tickTotalMs: 0, tickMaxMs: 0, slowKicks: 0 };
  const incidentQueue = [];
  const lobby = createLobby({
    seedText: o.seed, cap: o.cap, edits: saved?.edits || null, scorebook,
    send: (id, msg) => {
      const s = sockets.get(id);
      if (!s || s.ws.readyState !== 1) return;
      if (s.ws.bufferedAmount > 4 * 1024 * 1024) {
        stats.slowKicks++;
        s.ws.terminate();
        return;
      }
      const data = JSON.stringify(msg);
      stats.bytesOut += data.length;
      stats.msgsOut++;
      s.ws.send(data);
    },
    close: (id) => {
      const s = sockets.get(id);
      if (s) setTimeout(() => s.ws.close(1000), 50);
    },
    log: (what, detail) => log(what, detail),
    incident: (entry) => incidentQueue.push(JSON.stringify({ ...entry, iso: new Date(entry.t).toISOString() })),
  });
  const { authority } = lobby;

  let dirty = false;
  authority.use({ afterEdit: () => { dirty = true; } });
  let saving = null;
  async function save(reason = 'periodic') {
    if (saving) return saving;
    saving = (async () => {
      authority.checkpointScores();
      if (dirty || reason !== 'periodic') {
        const edits = lobby.world.flatEdits();
        const body = JSON.stringify({ v: 1, seedText: o.seed, savedAt: new Date().toISOString(), edits });
        await writeFile(worldFile + '.tmp', body);
        await rename(worldFile + '.tmp', worldFile);
        dirty = false;
        log('saved world (' + reason + ')', { edits: edits.length / 4, bytes: body.length });
      }
      if (scorebook.dirty || reason !== 'periodic') {
        const sb = JSON.stringify({ v: 1, savedAt: new Date().toISOString(), entries: scorebook.toJSON() });
        await writeFile(scoresFile + '.tmp', sb);
        await rename(scoresFile + '.tmp', scoresFile);
      }
    })().finally(() => { saving = null; });
    return saving;
  }
  async function flushIncidents() {
    if (!incidentQueue.length) return;
    const lines = incidentQueue.splice(0).join('\n') + '\n';
    await appendFile(incidentFile, lines).catch((err) => log('incident log write failed: ' + err.message));
  }

  // ----- HTTP -----
  const lobbyJson = JSON.stringify({ ws: 'same-origin', peer: null });
  function statusBody() {
    const s = authority.status();
    return {
      ...s, ok: true, uptimeSec: Math.round((Date.now() - started) / 1000), seed: o.seed,
      roster: authority.roster().players.map((p) => ({ name: p.name, bot: p.bot, title: p.title, score: p.score })),
      counters: authority.counters, bytesOutPerSec: Math.round(stats.bytesOut / Math.max(1, (Date.now() - started) / 1000)),
      tickAvgMs: stats.ticks ? +(stats.tickTotalMs / stats.ticks).toFixed(3) : 0, tickMaxMs: +stats.tickMaxMs.toFixed(3),
      connections: sockets.size, memMB: Math.round(process.memoryUsage().rss / 1048576),
      lastTickAgoMs: stats.lastTickAt ? Date.now() - stats.lastTickAt : null,
      botsOnline: [...authority.peers.values()].filter((p) => p.bot && p.hello).map((p) => p.name),
      hive: { nextEventInSec: lobby.hive.nextEventAt === null ? null : Math.round((lobby.hive.nextEventAt - Date.now()) / 1000), rushActive: !!lobby.hive.rush },
      scorebook: { players: scorebook.size, top: scorebook.top(5) },
    };
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method' });
    if (url.pathname === '/health') {
      const s = authority.status();
      return json(200, { ok: true, players: s.players, cap: s.cap, bots: s.bots, uptimeSec: Math.round((Date.now() - started) / 1000) });
    }
    if (url.pathname === '/status') return json(200, statusBody());
    if (!o.static) return json(404, { error: 'not found' });
    if (url.pathname === '/lobby.json') return json(200, JSON.parse(lobbyJson));
    let path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    path = normalize(path).replace(/\\/g, '/');
    if (!STATIC_ALLOW.test(path)) return json(404, { error: 'not found' });
    const file = join(root, path);
    try {
      if (!(await stat(file)).isFile()) throw new Error('nf');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(await readFile(file));
    } catch {
      json(404, { error: 'not found' });
    }
  });

  // ----- WebSocket -----
  const perIp = new Map(); // key -> open connection count
  const recent = new Map(); // key -> [timestamps] of connection attempts
  let nextId = 1;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false });
  const clientIp = (req) => {
    if (o.trustProxy) {
      const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (h) return h;
    }
    return req.socket.remoteAddress || '?';
  };
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const key = createHash('sha256').update(salt).update(clientIp(req)).digest('hex').slice(0, 16);
    const now = Date.now();
    const times = (recent.get(key) || []).filter((t) => now - t < 60000);
    times.push(now);
    recent.set(key, times);
    if (times.length > Math.max(30, o.maxPerIp * 6) || (perIp.get(key) || 0) >= o.maxPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = 'p' + nextId++;
      perIp.set(key, (perIp.get(key) || 0) + 1);
      if (!authority.connect(id, { key })) {
        perIp.set(key, perIp.get(key) - 1);
        return setTimeout(() => ws.close(1008), 50);
      }
      sockets.set(id, { ws, key, alive: true });
      ws.on('pong', () => { const s = sockets.get(id); if (s) s.alive = true; });
      ws.on('message', (data, isBinary) => {
        stats.bytesIn += data.length;
        stats.msgsIn++;
        authority.receive(id, isBinary ? '' : data.toString('utf8'));
      });
      const done = () => {
        if (!sockets.has(id)) return;
        sockets.delete(id);
        perIp.set(key, Math.max(0, (perIp.get(key) || 1) - 1));
        if (!perIp.get(key)) perIp.delete(key);
        authority.disconnect(id, 'closed');
      };
      ws.on('close', done);
      ws.on('error', done);
    });
  });

  // ----- loops -----
  const tick = setInterval(() => {
    const t0 = performance.now();
    authority.tick(Date.now());
    const dt = performance.now() - t0;
    stats.ticks++;
    stats.lastTickAt = Date.now();
    stats.tickTotalMs += dt;
    if (dt > stats.tickMaxMs) stats.tickMaxMs = dt;
  }, 50);
  const pinger = setInterval(() => {
    for (const s of sockets.values()) {
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      s.ws.ping();
    }
    for (const [k, times] of recent) if (!times.some((t) => Date.now() - t < 60000)) recent.delete(k);
  }, 20000);
  const saver = setInterval(() => { save().catch((e) => log('save failed: ' + e.message)); }, o.saveMs);
  const incidentFlusher = setInterval(flushIncidents, 1000);

  await new Promise((r) => server.listen(o.port, o.bind, r));
  const port = server.address().port;
  log('lobby host up', { url: 'http://' + o.bind + ':' + port + '/', ws: 'ws://' + o.bind + ':' + port + '/ws', cap: o.cap, seed: o.seed, static: o.static, pid: process.pid });

  async function stop(reason = 'stop') {
    clearInterval(tick);
    clearInterval(pinger);
    clearInterval(saver);
    clearInterval(incidentFlusher);
    for (const s of sockets.values()) s.ws.close(1001, 'Server restarting');
    await save(reason).catch((e) => log('final save failed: ' + e.message));
    await flushIncidents();
    await new Promise((r) => { wss.close(); server.close(() => r()); setTimeout(r, 1000); });
    log('lobby host stopped (' + reason + ')');
  }
  return { port, lobby, authority, stop, save, status: statusBody, stats, incidentFile, worldFile, scoresFile, scorebook };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = await startLobbyHost(parseArgs(process.argv.slice(2)));
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      await host.stop(sig);
      process.exit(0);
    });
  }
}
