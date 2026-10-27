// Exercises the private-room session logic (src/client/net.js + core/authority.js in the hosting
// browser) against an in-memory fake of the PeerJS API using the real wire format (JSON strings,
// "raw" serialization). It verifies host/join/relay/validation logic; it does NOT exercise real WebRTC.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const registry = new Map();
const tick = () => new Promise((r) => setTimeout(r, 0));

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
}
class FakeConn extends Emitter {
  constructor(peer, serialization = 'raw') { super(); this.peer = peer; this.open = false; this.other = null; this.serialization = serialization; }
  send(data) {
    const other = this.other;
    setTimeout(() => other.open && other.emit('data', data), 0);
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
    if (this.other.open) this.other.close();
  }
}
let anon = 0;
class FakePeer extends Emitter {
  constructor(id) {
    super();
    this.id = typeof id === 'string' ? id : 'anon-' + (++anon);
    setTimeout(() => {
      if (registry.has(this.id)) return this.emit('error', { type: 'unavailable-id' });
      registry.set(this.id, this);
      this.emit('open', this.id);
    }, 0);
  }
  connect(target, opts = {}) {
    const a = new FakeConn(target, opts.serialization || 'binary');
    const b = new FakeConn(this.id, opts.serialization || 'binary');
    a.other = b;
    b.other = a;
    setTimeout(() => {
      const t = registry.get(target);
      if (!t) return this.emit('error', { type: 'peer-unavailable' });
      t.emit('connection', b);
      a.open = b.open = true;
      b.emit('open');
      a.emit('open');
    }, 0);
    return a;
  }
  destroy() { if (registry.get(this.id) === this) registry.delete(this.id); }
  reconnect() {}
}
globalThis.self = globalThis;
globalThis.peerjs = { Peer: FakePeer };

const { Net } = await import('../src/client/net.js');
const { B } = await import('../src/core/blocks.js');

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const games = [];
after(() => { for (const g of games) g.net.leave(); });

function fakeGame(seed = 1234) {
  const g = {
    seed, time: 42, blocks: new Map(), remotes: new Map(), chats: [], joined: null, closed: null, roster: null, denies: [], net: null,
    world: { getBlockOrNull: (x, y, z) => g.blocks.get(`${x},${y},${z}`) ?? B.AIR },
    setBlock: (x, y, z, id, { fromNet = false } = {}) => {
      g.blocks.set(`${x},${y},${z}`, id);
      if (!fromNet) g.net.sendEdit(x, y, z, id);
      return true;
    },
    snapshotForNet: () => ({ seed: g.seed, edits: [...g.blocks].flatMap(([k, id]) => [...k.split(',').map(Number), id]), time: 42 }),
    joinNetWorld: (msg) => { g.joined = msg; g.seed = msg.seed; g.applyNetEdits(msg.edits); },
    applyNetEdits: (e) => { for (let i = 0; i < e.length; i += 4) g.blocks.set(e.slice(i, i + 3).join(','), e[i + 3]); },
    applyNetEdit: (m) => { g.blocks.set(`${m.x},${m.y},${m.z}`, m.id); return true; },
    updateRemote: (m) => g.remotes.set(m.p, m),
    removeRemote: (id) => g.remotes.delete(id),
    showChat: (name, text) => g.chats.push(`${name}: ${text}`),
    onRoster: (r) => { g.roster = r; },
    onNetDeny: (r) => g.denies.push(r),
    onNetClosed: (reason) => { g.closed = reason || 'closed'; },
  };
  g.net = new Net(g);
  games.push(g);
  return g;
}
const player = (x, y = 40, z = 0) => ({ pos: { x, y, z }, yaw: 0, pitch: 0 });

test('private room: host + two clients over the real wire format', async () => {
  const hg = fakeGame(777);
  hg.blocks.set('1,30,2', 10);
  const host = hg.net;
  const code = await host.host('Host');
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal(host.role, 'host');

  const ag = fakeGame(1), bg = fakeGame(2);
  const a = ag.net, b = bg.net;
  await a.join(code.toLowerCase(), 'Alice');
  await b.join(code, 'Bob');
  await settle();
  assert.equal(ag.seed, 777);
  assert.equal(ag.blocks.get('1,30,2'), 10, 'existing edits arrive in welcome');
  assert.equal(ag.joined.mode, 'creative');
  await sleep(1100); // roster broadcasts are coalesced to at most 1/s
  assert.equal(host.playerCount, 3);
  assert.equal(a.playerCount, 3, 'clients learn the real count from the roster');

  // Clients report positions (reach checks use them).
  a.tick(1000, player(5, 31, 5));
  b.tick(1000, player(6, 31, 6));
  await settle();

  ag.setBlock(5, 32, 7, 12);
  await settle();
  assert.equal(hg.blocks.get('5,32,7'), 12, 'host applies client edit');
  assert.equal(bg.blocks.get('5,32,7'), 12, 'host relays edit to other clients');

  ag.setBlock(6, 32, 6, B.BEACON); // forbidden: rejected and corrected on the sender
  await settle();
  assert.equal(hg.blocks.has('6,32,6'), false);
  assert.equal(bg.blocks.has('6,32,6'), false);
  assert.equal(ag.blocks.get('6,32,6'), B.AIR, 'sender is corrected');
  assert.equal(ag.denies.length, 1);

  ag.setBlock(60, 32, 60, 12); // out of reach
  await settle();
  assert.equal(hg.blocks.has('60,32,60'), false);

  hg.setBlock(7, 31, 7, 20); // host's own edits go to everyone
  await settle();
  assert.equal(ag.blocks.get('7,31,7'), 20);

  host.tick(5000, player(3));
  a.tick(5000, player(5.5, 31, 5));
  await sleep(250); // host ticks snapshots at 10 Hz
  assert.equal(ag.remotes.get('host').x, 3);
  const alice = a.myId;
  assert.equal(bg.remotes.get(alice).x, 5.5, 'client state relayed in snapshots');
  assert.equal(bg.remotes.get(alice).info.name, 'Alice', 'host-assigned name attached');

  b.link.conn.send(JSON.stringify({ t: 'chat', name: 'Mallory', text: 'hi\u0007\u0000 there' }));
  await settle();
  assert.ok(ag.chats.includes('Bob: hi there'), 'host attaches the real name; control characters stripped');

  a.leave();
  await settle();
  await sleep(1100);
  assert.equal(host.playerCount, 2);
  assert.equal(hg.remotes.has(alice), false);
  host.leave();
  await settle();
  assert.ok(bg.closed, 'client notified when host leaves');
  b.leave();
});

test('host ignores clients that skip hello, use other serializations, or send junk', async () => {
  const hg = fakeGame();
  const code = await hg.net.host('H');
  const rogue = new FakePeer();
  await tick();
  const conn = rogue.connect('gigatron-voxel-v1-' + code, { serialization: 'raw' });
  await settle();
  conn.send(JSON.stringify({ t: 'edit', x: 1, y: 1, z: 1, id: 3 })); // no hello yet
  conn.send(JSON.stringify({ t: 'hello', v: 2, name: 'R' }));
  conn.send(JSON.stringify({ t: 'edit', x: 'a', y: 1, z: 1, id: 3 }));
  conn.send(JSON.stringify({ t: 'edit', x: 1, y: 9999, z: 1, id: 3 }));
  conn.send('{' + 'x'.repeat(5000));
  conn.send(JSON.stringify({ t: 'nope' }));
  await settle(12);
  assert.equal(hg.blocks.size, 0);
  assert.ok(hg.net.authority.counters.malformed >= 3);

  const binary = new FakePeer();
  await tick();
  const bconn = binary.connect('gigatron-voxel-v1-' + code); // default PeerJS binary serialization
  let closed = false;
  bconn.on('close', () => { closed = true; });
  await settle(12);
  assert.equal(closed, true, 'non-raw connections are refused');
  hg.net.leave();
});

test('room cap: the 9th player is told the room is full', async () => {
  const hg = fakeGame();
  const code = await hg.net.host('H');
  const guests = [];
  for (let i = 0; i < 7; i++) {
    const g = fakeGame();
    await g.net.join(code, 'G' + i);
    guests.push(g);
  }
  const late = fakeGame();
  await assert.rejects(late.net.join(code, 'Late'), /full/);
  for (const g of guests) g.net.leave();
  hg.net.leave();
});

test('join rejects bad codes and reports missing rooms', async () => {
  const n = fakeGame().net;
  await assert.rejects(n.join('!!', 'x'), /6 letters/);
  await assert.rejects(n.join('ZZZZZZ', 'x'), /No host|No room/);
  n.leave();
});
