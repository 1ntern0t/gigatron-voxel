// Multiplayer networking for the browser.
// - Private rooms: peer-to-peer WebRTC data channels via PeerJS (vendored). The hosting browser runs
//   the shared authoritative host logic (core/authority.js); everyone else is a client.
// - Public lobby: a dedicated host (tools/lobby-host.mjs) reachable over WebSocket, or over PeerJS at a
//   well-known peer id when the lobby host runs its WebRTC bridge.
// Every message from the other side is size-capped and validated (core/protocol.js).
import {
  PROTOCOL_VERSION, MAX_HOST_MESSAGE_BYTES, makeRoomCode, normalizeRoomCode, roomPeerId, parseWire, validateHostMessage,
  cleanChat, sanitizeName,
} from '../core/protocol.js';
import { Authority } from '../core/authority.js';
import { ROOM_CAP, LOBBY_PROBE_TIMEOUT_MS } from '../core/lobby-config.js';

let peerLoad = null;
function loadPeerJS() {
  if (self.peerjs?.Peer) return Promise.resolve(self.peerjs.Peer);
  if (!peerLoad) {
    peerLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/peerjs/peerjs.min.js', import.meta.url).href;
      s.onload = () => (self.peerjs?.Peer ? resolve(self.peerjs.Peer) : reject(new Error('PeerJS failed to initialise')));
      s.onerror = () => { peerLoad = null; reject(new Error('Could not load vendor/peerjs/peerjs.min.js')); };
      document.head.appendChild(s);
    });
  }
  return peerLoad;
}

// ----- links: a uniform {send(obj), close(), onmessage(raw), onclose(reason)} over WebSocket or PeerJS -----
class WsLink {
  constructor(url) {
    this.url = url;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.closed = false;
  }

  open(timeoutMs) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        reject(new Error('Bad lobby address: ' + err.message));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timed out reaching the lobby server.')); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(this); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Lobby server unreachable.')); };
      ws.onmessage = (e) => typeof e.data === 'string' && this.onmessage(e.data);
      ws.onclose = () => { clearTimeout(timer); if (!this.closed) { this.closed = true; this.onclose('closed'); } };
    });
  }

  get open_() {
    return this.ws?.readyState === 1;
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

class PeerLink {
  constructor(Peer, target) {
    this.Peer = Peer;
    this.target = target;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.closed = false;
  }

  open(timeoutMs, onStatus = () => {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Timed out: the host did not answer (WebRTC could not connect - strict NAT/firewall, or the host is offline).')); }, timeoutMs);
      const fail = (err) => { clearTimeout(timer); this.close(); reject(err); };
      this.peer = new this.Peer({ debug: 1 });
      this.peer.on('error', (err) => fail(new Error(describeError(err))));
      this.peer.on('open', () => {
        onStatus('Connecting to host...');
        const conn = this.peer.connect(this.target, { reliable: true, serialization: 'raw' });
        this.conn = conn;
        conn.on('open', () => { clearTimeout(timer); resolve(this); });
        conn.on('data', (d) => typeof d === 'string' && this.onmessage(d));
        conn.on('close', () => { if (!this.closed) { this.closed = true; this.onclose('closed'); } this.peer?.destroy(); });
        conn.on('error', () => conn.close());
      });
    });
  }

  send(obj) {
    if (this.conn?.open) this.conn.send(JSON.stringify(obj));
  }

  close() {
    this.closed = true;
    this.conn?.close();
    this.peer?.destroy();
  }
}

export class Net {
  constructor(game) {
    this.game = game;
    this.peer = null;
    this.role = 'offline';
    this.code = null;
    this.lobby = false;
    this.link = null;
    this.authority = null;
    this.conns = new Map(); // host: short id -> PeerJS conn
    this.connSeq = 0;
    this.name = 'Builder';
    this.myId = null;
    this.roster = { cap: 0, players: [] };
    this.lastState = 0;
    this.tickTimer = null;
    this.onStatus = () => {};
  }

  get active() {
    return this.role !== 'offline';
  }

  status(text, kind = 'info') {
    this.onStatus(text, kind);
  }

  // ---------- hosting a private P2P room (the host's browser is the authority) ----------
  async host(name) {
    this.name = sanitizeName(name);
    const Peer = await loadPeerJS();
    this.leave();
    this.role = 'host';
    for (let attempt = 0; attempt < 3; attempt++) {
      this.code = makeRoomCode();
      try {
        await new Promise((resolve, reject) => {
          this.status('Contacting signaling server...');
          this.peer = new Peer(roomPeerId(this.code), { debug: 1 });
          this.peer.on('open', resolve);
          this.peer.on('error', (err) => reject(err));
        });
        break;
      } catch (err) {
        this.peer?.destroy();
        this.peer = null;
        if (err?.type !== 'unavailable-id' || attempt === 2) {
          this.role = 'offline';
          throw new Error(describeError(err));
        }
      }
    }
    const g = this.game;
    this.authority = new Authority({
      world: {
        getBlock: (x, y, z) => g.world?.getBlockOrNull(x, y, z) ?? null,
        setBlock: (x, y, z, id) => g.setBlock(x, y, z, id, { fromNet: true }),
      },
      snapshotEdits: () => g.snapshotForNet().edits,
      time: () => g.time,
      seed: g.seed,
      spawn: g.gen?.findSpawn() || { x: 0.5, y: 40, z: 0.5 },
      cap: ROOM_CAP,
      mode: 'creative',
      allowUnloaded: true,
      name: 'Room ' + this.code,
      now: () => performance.now(),
      send: (id, msg) => { const c = this.conns.get(id); if (c?.open) c.send(JSON.stringify(msg)); },
      close: (id) => setTimeout(() => this.conns.get(id)?.close(), 50),
    });
    this.myId = 'host';
    this.authority.addLocal('host', { name: this.name, privileged: 'host', sink: (m) => this.onHostMessage(m, true) });
    this.peer.on('connection', (conn) => this.acceptClient(conn));
    this.peer.on('error', (err) => this.status('Network: ' + describeError(err), 'warn'));
    this.peer.on('disconnected', () => {
      this.status('Lost signaling server; existing players stay connected. Reconnecting...', 'warn');
      try { this.peer.reconnect(); } catch { /* ignore */ }
    });
    this.tickTimer = setInterval(() => this.authority?.tick(performance.now()), 50);
    this.authority.flushRoster(performance.now(), true);
    this.status('Hosting room ' + this.code + '. Share the code with friends.', 'ok');
    return this.code;
  }

  acceptClient(conn) {
    // Only accept our own wire format: JSON strings ("raw" serialization) so sizes are checked before parsing.
    if (conn.serialization !== 'raw' || this.conns.size >= ROOM_CAP * 2) {
      conn.on('open', () => conn.close());
      return;
    }
    const id = 'p' + (++this.connSeq);
    this.conns.set(id, conn);
    conn.on('open', () => this.authority?.connect(id, { key: String(conn.peer).slice(0, 64) }));
    conn.on('data', (raw) => this.authority?.receive(id, raw));
    conn.on('close', () => {
      this.conns.delete(id);
      this.authority?.disconnect(id);
    });
    conn.on('error', () => conn.close());
  }

  // ---------- joining (private room code, or the public lobby) ----------
  async join(codeInput, name) {
    const code = normalizeRoomCode(codeInput);
    if (!code) throw new Error('Room codes are 6 letters/numbers.');
    const Peer = await loadPeerJS();
    return this.connectAndJoin(new PeerLink(Peer, roomPeerId(code)), name, { code, timeout: 20000 });
  }

  // `resume` is the random token this lobby gave us last time (kept in localStorage), so the lobby
  // can restore our score. It identifies nothing but that score.
  async joinLobby(target, name, resume = null) {
    const link = await this.makeLink(target);
    return this.connectAndJoin(link, name, { code: 'LOBBY', lobby: true, timeout: 20000, resume });
  }

  async makeLink(target) {
    if (target?.ws) return new WsLink(target.ws);
    if (target?.peer) return new PeerLink(await loadPeerJS(), target.peer);
    throw new Error('No public lobby is configured.');
  }

  // Liveness check: really connect, ask for the player count, disconnect. Never guesses a number.
  async probe(target, timeoutMs = LOBBY_PROBE_TIMEOUT_MS) {
    const link = await this.makeLink(target);
    const started = performance.now();
    await link.open(timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { link.close(); reject(new Error('Lobby did not answer.')); }, Math.max(1000, timeoutMs - (performance.now() - started)));
      link.onmessage = (raw) => {
        const msg = validateHostMessage(parseWire(raw, 4096));
        if (msg?.t !== 'status') return;
        clearTimeout(timer);
        link.close();
        resolve({ ...msg, rtt: Math.round(performance.now() - started) });
      };
      link.onclose = () => { clearTimeout(timer); reject(new Error('Lobby closed the connection.')); };
      link.send({ t: 'probe' });
    });
  }

  async connectAndJoin(link, name, { code, lobby = false, timeout, resume = null }) {
    this.name = sanitizeName(name);
    this.leave();
    this.role = 'client';
    this.code = code;
    this.lobby = lobby;
    this.link = link;
    this.status(lobby ? 'Connecting to the public lobby...' : 'Contacting signaling server...');
    try {
      await link.open(timeout, (t) => this.status(t));
    } catch (err) {
      this.leave();
      throw err;
    }
    if (this.link !== link) throw new Error('Cancelled.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Host did not send the world in time.')); this.leave(); }, timeout);
      this.pendingJoin = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      link.onmessage = (raw) => this.onHostMessage(raw, false);
      link.onclose = () => {
        if (this.link !== link) return;
        if (this.pendingJoin) {
          this.pendingJoin.reject(new Error(this.kickReason || 'The host closed the connection.'));
          this.pendingJoin = null;
        }
        this.status(this.kickReason ? 'Disconnected: ' + this.kickReason : 'Disconnected from host.', 'warn');
        this.game.onNetClosed(this.kickReason);
        this.leave();
      };
      link.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, ...(lobby && typeof resume === 'string' ? { resume } : {}) });
    });
  }

  // Messages from the host. `local` = delivered in-process by the host's own Authority.
  onHostMessage(raw, local) {
    const msg = local ? validateHostMessage(raw) : validateHostMessage(parseWire(raw, MAX_HOST_MESSAGE_BYTES));
    if (!msg) return;
    const g = this.game;
    switch (msg.t) {
      case 'welcome':
        if (!this.pendingJoin) return;
        this.myId = msg.id;
        this.welcome = msg;
        if (this.lobby && msg.resume) g.onLobbyResume?.(msg.resume);
        g.joinNetWorld(msg);
        this.status((this.lobby ? 'Joined the public lobby' : 'Joined room ' + this.code) + '.', 'ok');
        this.pendingJoin.resolve();
        this.pendingJoin = null;
        break;
      case 'edits': g.applyNetEdits?.(msg.edits); break;
      case 'edit': g.applyNetEdit(msg); break;
      case 'snap':
        for (const [p, x, y, z, yaw, pitch] of msg.s) if (p !== this.myId) g.updateRemote({ p, x, y, z, yaw, pitch, info: this.info(p) });
        break;
      case 'roster':
        this.roster = msg;
        g.onRoster?.(msg);
        break;
      case 'chat': g.showChat(msg.name, msg.text, { bot: msg.bot, sys: msg.sys }); break;
      case 'leave': g.removeRemote(msg.p); break;
      case 'deny': g.onNetDeny?.(msg.reason); break;
      case 'pos': g.onNetPos?.(msg); break;
      case 'event': g.onNetEvent?.(msg); break;
      case 'kick': this.kickReason = msg.reason; break;
      default: break;
    }
  }

  info(id) {
    return this.roster.players.find((p) => p.p === id) || null;
  }

  // ---------- outbound ----------
  sendEdit(x, y, z, id) {
    if (this.role === 'host') this.authority?.localEdit('host', x, y, z, id, { applied: true });
    else if (this.role === 'client') this.link?.send({ t: 'edit', x, y, z, id });
  }

  sendChat(text) {
    const t = cleanChat(text);
    if (!t) return false;
    if (this.role === 'host') {
      this.authority?.localChat('host', t);
    } else if (this.role === 'client') {
      this.link?.send({ t: 'chat', text: t });
    } else return false;
    return true;
  }

  sendQuest(index) {
    if (this.role === 'client') this.link?.send({ t: 'quest', index });
    else if (this.role === 'host') this.authority?.quest(this.authority.peers.get('host'), { index });
  }

  tick(now, player) {
    if (!this.active || now - this.lastState < 100) return;
    this.lastState = now;
    const s = { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch, fly: !!player.flying };
    if (this.role === 'host') this.authority?.localState('host', s);
    else this.link?.send({ t: 'state', ...s });
  }

  get playerCount() {
    if (this.role === 'offline') return 1;
    return Math.max(1, this.roster.players.filter((p) => !p.bot).length);
  }

  get botCount() {
    return this.roster.players.filter((p) => p.bot).length;
  }

  leave() {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    const link = this.link;
    this.link = null;
    link?.close();
    this.peer?.destroy();
    this.peer = null;
    this.authority = null;
    this.role = 'offline';
    this.code = null;
    this.lobby = false;
    this.myId = null;
    this.kickReason = null;
    this.roster = { cap: 0, players: [] };
    if (this.pendingJoin) {
      this.pendingJoin.reject(new Error('Cancelled.'));
      this.pendingJoin = null;
    }
  }
}

export function describeError(err) {
  const t = err?.type;
  if (t === 'peer-unavailable') return 'No host with that code is online (the host may have left).';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Signaling server unreachable. P2P multiplayer needs internet access to 0.peerjs.com.';
  if (t === 'browser-incompatible') return 'This browser does not support WebRTC.';
  if (t === 'unavailable-id') return 'Room code collision, please try again.';
  return err?.message || String(err);
}
