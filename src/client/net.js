// Experimental P2P multiplayer over WebRTC data channels (PeerJS, vendored).
// Topology: star. The host is authoritative for the seed, edits and circuits; clients relay through it.
import {
  PROTOCOL_VERSION, makeRoomCode, normalizeRoomCode, roomPeerId, validateMessage, createRateLimiter, sanitizeName,
} from '../core/protocol.js';

let peerLoad = null;
function loadPeerJS() {
  if (self.peerjs?.Peer) return Promise.resolve(self.peerjs.Peer);
  if (!peerLoad) {
    peerLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/peerjs/peerjs.min.js', import.meta.url).href;
      s.onload = () => (self.peerjs?.Peer ? resolve(self.peerjs.Peer) : reject(new Error('PeerJS failed to initialise')));
      s.onerror = () => reject(new Error('Could not load vendor/peerjs/peerjs.min.js'));
      document.head.appendChild(s);
    });
  }
  return peerLoad;
}

export class Net {
  constructor(game) {
    this.game = game;
    this.peer = null;
    this.role = 'offline';
    this.code = null;
    this.conns = new Map(); // host: peerId -> {conn, name, editLimit, msgLimit}
    this.hostConn = null;
    this.name = 'Builder';
    this.lastState = 0;
    this.onStatus = () => {};
  }

  get active() {
    return this.role !== 'offline';
  }

  status(text, kind = 'info') {
    this.onStatus(text, kind);
  }

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
    this.peer.on('connection', (conn) => this.acceptClient(conn));
    this.peer.on('error', (err) => this.status('Network: ' + describeError(err), 'warn'));
    this.peer.on('disconnected', () => {
      this.status('Lost signaling server; existing players stay connected. Reconnecting...', 'warn');
      try { this.peer.reconnect(); } catch { /* ignore */ }
    });
    this.status('Hosting room ' + this.code + '. Share the code with friends.', 'ok');
    return this.code;
  }

  acceptClient(conn) {
    if (this.conns.size >= 7) {
      conn.on('open', () => conn.close());
      return;
    }
    const entry = { conn, name: 'Builder', hello: false, editLimit: createRateLimiter(40, 80), msgLimit: createRateLimiter(30, 60), chatLimit: createRateLimiter(1, 5) };
    const id = sanitizeName(conn.peer);
    conn.on('data', (raw) => this.onHostData(id, entry, raw));
    conn.on('close', () => {
      this.conns.delete(id);
      this.game.removeRemote(id);
      this.broadcast({ t: 'leave', p: id });
      this.status(entry.name + ' left.');
    });
    conn.on('error', () => conn.close());
    this.conns.set(id, entry);
  }

  onHostData(id, entry, raw) {
    const now = performance.now();
    if (!entry.msgLimit(now) && raw?.t !== 'edit') return;
    const msg = validateMessage(raw);
    if (!msg) return;
    if (msg.t === 'hello') {
      entry.name = msg.name;
      entry.hello = true;
      const w = this.game.snapshotForNet();
      entry.conn.send({ t: 'welcome', v: PROTOCOL_VERSION, seed: w.seed, edits: w.edits, time: w.time, id });
      this.status(msg.name + ' joined.', 'ok');
      return;
    }
    if (!entry.hello) return;
    if (msg.t === 'edit') {
      if (!entry.editLimit(now)) return;
      if (this.game.applyNetEdit(msg)) this.broadcast(msg, id);
    } else if (msg.t === 'state') {
      msg.p = id;
      msg.name = entry.name;
      this.game.updateRemote(msg);
      this.broadcast(msg, id);
    } else if (msg.t === 'chat') {
      if (!entry.chatLimit(now)) return;
      msg.p = id;
      msg.name = entry.name;
      this.game.showChat(msg.name, msg.text);
      this.broadcast(msg, id);
    }
  }

  broadcast(msg, exceptId = null) {
    for (const [id, e] of this.conns) if (id !== exceptId && e.hello && e.conn.open) e.conn.send(msg);
  }

  async join(codeInput, name) {
    const code = normalizeRoomCode(codeInput);
    if (!code) throw new Error('Room codes are 6 letters/numbers.');
    this.name = sanitizeName(name);
    const Peer = await loadPeerJS();
    this.leave();
    this.role = 'client';
    this.code = code;
    this.status('Contacting signaling server...');
    await new Promise((resolve, reject) => {
      this.peer = new Peer({ debug: 1 });
      const timer = setTimeout(() => reject(new Error('Timed out connecting to room ' + code + '.')), 20000);
      this.peer.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(describeError(err)));
      });
      this.peer.on('open', () => {
        this.status('Connecting to host ' + code + '...');
        const conn = this.peer.connect(roomPeerId(code), { reliable: true, serialization: 'json' });
        this.hostConn = conn;
        conn.on('open', () => conn.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name }));
        conn.on('data', (raw) => {
          const msg = validateMessage(raw);
          if (!msg) return;
          if (msg.t === 'welcome') {
            clearTimeout(timer);
            this.game.joinNetWorld(msg);
            this.status('Joined room ' + code + '.', 'ok');
            resolve();
          } else if (msg.t === 'edit') this.game.applyNetEdit(msg);
          else if (msg.t === 'state') this.game.updateRemote(msg.p ? msg : { ...msg, p: 'host' });
          else if (msg.t === 'chat') this.game.showChat(msg.name, msg.text);
          else if (msg.t === 'leave') this.game.removeRemote(msg.p);
        });
        conn.on('close', () => {
          this.status('Disconnected from host.', 'warn');
          this.game.onNetClosed();
          this.leave();
        });
      });
    });
  }

  sendEdit(x, y, z, id) {
    if (this.role === 'host') this.broadcast({ t: 'edit', x, y, z, id });
    else if (this.role === 'client' && this.hostConn?.open) this.hostConn.send({ t: 'edit', x, y, z, id });
  }

  sendChat(text) {
    const msg = { t: 'chat', name: this.name, text: String(text).slice(0, 140) };
    if (this.role === 'host') {
      this.broadcast({ ...msg, p: 'host' });
      this.game.showChat(this.name, msg.text);
    } else if (this.hostConn?.open) {
      this.hostConn.send(msg);
      this.game.showChat(this.name, msg.text);
    }
  }

  tick(now, player) {
    if (!this.active || now - this.lastState < 100) return;
    this.lastState = now;
    const msg = { t: 'state', name: this.name, x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch };
    if (this.role === 'host') this.broadcast({ ...msg, p: 'host' });
    else if (this.hostConn?.open) this.hostConn.send(msg);
  }

  get playerCount() {
    if (this.role === 'host') return 1 + [...this.conns.values()].filter((e) => e.hello).length;
    return this.role === 'client' ? 2 : 1;
  }

  leave() {
    for (const e of this.conns.values()) e.conn.close();
    this.conns.clear();
    this.hostConn?.close();
    this.hostConn = null;
    this.peer?.destroy();
    this.peer = null;
    this.role = 'offline';
    this.code = null;
  }
}

function describeError(err) {
  const t = err?.type;
  if (t === 'peer-unavailable') return 'No room with that code is open (the host may have left).';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Signaling server unreachable. Multiplayer needs internet access to 0.peerjs.com.';
  if (t === 'browser-incompatible') return 'This browser does not support WebRTC.';
  if (t === 'unavailable-id') return 'Room code collision, please try again.';
  return err?.message || String(err);
}
