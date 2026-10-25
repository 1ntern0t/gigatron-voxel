// Exercises the multiplayer session logic (src/client/net.js) against an in-memory fake of the
// PeerJS API. This verifies host/join/relay/validation logic; it does NOT exercise real WebRTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const registry = new Map();
const tick = () => new Promise((r) => setTimeout(r, 0));

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
}
class FakeConn extends Emitter {
  constructor(peer) { super(); this.peer = peer; this.open = false; this.other = null; }
  send(data) {
    const copy = JSON.parse(JSON.stringify(data));
    const other = this.other;
    setTimeout(() => other.open && other.emit('data', copy), 0);
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
  connect(target) {
    const a = new FakeConn(target);
    const b = new FakeConn(this.id);
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

function fakeGame(seed = 1234) {
  const g = {
    seed, blocks: new Map(), remotes: new Map(), chats: [], joined: null, closed: false,
    snapshotForNet: () => ({ seed: g.seed, edits: [...g.blocks].flatMap(([k, id]) => [...k.split(',').map(Number), id]), time: 42 }),
    joinNetWorld: (msg) => { g.joined = msg; g.seed = msg.seed; for (let i = 0; i < msg.edits.length; i += 4) g.blocks.set(msg.edits.slice(i, i + 3).join(','), msg.edits[i + 3]); },
    applyNetEdit: (m) => { if (m.id === 29) return false; g.blocks.set(`${m.x},${m.y},${m.z}`, m.id); return true; },
    updateRemote: (m) => g.remotes.set(m.p, m),
    removeRemote: (id) => g.remotes.delete(id),
    showChat: (name, text) => g.chats.push(`${name}: ${text}`),
    onNetClosed: () => { g.closed = true; },
  };
  return g;
}
const player = (x) => ({ pos: { x, y: 40, z: 0 }, yaw: 0, pitch: 0 });

test('host + two clients: welcome, edits, relay, state, chat, leave', async () => {
  const hg = fakeGame(777);
  hg.blocks.set('1,30,2', 10);
  const host = new Net(hg);
  const code = await host.host('Host');
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal(host.role, 'host');

  const ag = fakeGame(1), bg = fakeGame(2);
  const a = new Net(ag), b = new Net(bg);
  await a.join(code.toLowerCase(), 'Alice');
  await b.join(code, 'Bob');
  assert.equal(ag.seed, 777);
  assert.equal(ag.blocks.get('1,30,2'), 10, 'existing edits arrive in welcome');
  assert.equal(host.playerCount, 3);

  a.sendEdit(5, 31, 5, 12);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(hg.blocks.get('5,31,5'), 12, 'host applies client edit');
  assert.equal(bg.blocks.get('5,31,5'), 12, 'host relays edit to other clients');

  a.sendEdit(6, 31, 6, 29); // host rejects forbidden blocks
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(hg.blocks.has('6,31,6'), false);
  assert.equal(bg.blocks.has('6,31,6'), false);

  host.sendEdit(7, 31, 7, 20);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(ag.blocks.get('7,31,7'), 20);

  host.tick(1000, player(3));
  a.tick(1000, player(9));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(ag.remotes.get('host').x, 3);
  assert.equal(hg.remotes.size, 1);
  assert.equal([...bg.remotes.values()].some((r) => r.x === 9 && r.name === 'Alice'), true, 'client state relayed with host-assigned name');

  b.hostConn.send({ t: 'chat', name: 'Bob', text: 'hi\u0007\u0000 there' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(hg.chats.length, 1);
  assert.equal(ag.chats.length, 1);
  assert.equal(ag.chats[0], 'Bob: hi there', 'control characters stripped (UI renders via textContent)');

  a.leave();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(host.playerCount, 2);
  assert.equal(hg.remotes.size, 0);
  host.leave();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(bg.closed, true, 'client notified when host leaves');
  b.leave();
});

test('host ignores clients that skip hello and malformed messages', async () => {
  const hg = fakeGame();
  const host = new Net(hg);
  const code = await host.host('H');
  const rogue = new FakePeer();
  await tick();
  const conn = rogue.connect('gigatron-voxel-v1-' + code);
  await tick(); await tick();
  conn.send({ t: 'edit', x: 1, y: 1, z: 1, id: 3 }); // no hello yet
  conn.send({ t: 'hello', v: 1, name: 'R' });
  conn.send({ t: 'edit', x: 'a', y: 1, z: 1, id: 3 });
  conn.send({ t: 'edit', x: 1, y: 9999, z: 1, id: 3 });
  conn.send({ t: 'nope' });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(hg.blocks.size, 0);
  host.leave();
});

test('join rejects bad codes and reports missing rooms', async () => {
  const n = new Net(fakeGame());
  await assert.rejects(n.join('!!', 'x'), /6 letters/);
  await assert.rejects(n.join('ZZZZZZ', 'x'), /No room/);
  n.leave();
});
