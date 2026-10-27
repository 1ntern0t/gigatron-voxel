// Health check for a running lobby host. Exits 0 when healthy, 1 otherwise.
//   node tools/lobby-health.mjs [http://127.0.0.1:8787] [--deep]
// Quick mode: GET /health. --deep also checks that the tick loop is running, that WARDEN, SPARK and
// HIVE are all present, and that a real WebSocket connection to /ws gets a live status answer
// (a probe: it is not counted as a player and does not appear in the roster).
import WebSocket from 'ws';

const args = process.argv.slice(2);
const deep = args.includes('--deep');
const base = (args.find((a) => !a.startsWith('--')) || `http://127.0.0.1:${process.env.LOBBY_PORT || 8787}`).replace(/\/$/, '');
const BOTS = ['HIVE', 'SPARK', 'WARDEN'];

function probe(url, ms = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('websocket probe timed out')); }, ms);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'probe' })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t !== 'status') return;
      clearTimeout(timer);
      ws.close();
      resolve(m);
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('unexpected-response', (_, r) => { clearTimeout(timer); reject(new Error('websocket HTTP ' + r.statusCode)); });
  });
}

try {
  const res = await fetch(base + '/health', { signal: AbortSignal.timeout(5000) });
  const h = await res.json();
  if (!res.ok || h.ok !== true) throw new Error('unhealthy: HTTP ' + res.status);
  let extra = '';
  if (deep) {
    const s = await (await fetch(base + '/status', { signal: AbortSignal.timeout(5000) })).json();
    if (!(s.lastTickAgoMs < 2000)) throw new Error('tick loop stalled (' + s.lastTickAgoMs + ' ms since last tick)');
    const missing = BOTS.filter((b) => !(s.botsOnline || []).includes(b));
    if (missing.length) throw new Error('bots missing: ' + missing.join(', '));
    const p = await probe(base.replace(/^http/, 'ws') + '/ws');
    if (p.bots !== 3) throw new Error('websocket probe reports ' + p.bots + ' bots');
    extra = `; bots ${s.botsOnline.join('+')}; ws probe ok; tick ${s.lastTickAgoMs}ms ago; next HIVE event in ${s.hive?.nextEventInSec ?? '-'}s; ${s.scorebook?.players ?? 0} saved scores`;
  }
  console.log(`${new Date().toISOString()} lobby OK at ${base}: ${h.players}/${h.cap} players, ${h.bots} bots, up ${h.uptimeSec}s${extra}`);
  process.exit(0);
} catch (err) {
  console.error(`${new Date().toISOString()} lobby DOWN at ${base}: ${err.message}`);
  process.exit(1);
}
