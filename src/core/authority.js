// Authoritative multiplayer host logic. Transport-agnostic and DOM-free: the same code runs in the
// hosting browser (PeerJS rooms) and in the Node lobby host (tools/lobby-host.mjs).
// Clients are never trusted: every message is size-capped, parsed defensively, validated, rate limited
// and checked against the world (reach, protected regions, unbreakable blocks, movement speed).
import { B, BLOCKS } from './blocks.js';
import { CircuitSim } from './circuit.js';
import {
  PROTOCOL_VERSION, MAX_CLIENT_MESSAGE_BYTES, EDIT_BATCH, PEER_FORBIDDEN, parseWire, validateClientMessage,
  createRateLimiter, sanitizeName, isReservedName, colorFor,
} from './protocol.js';

export const AUTHORITY_DEFAULTS = Object.freeze({
  cap: 8,
  mode: 'creative', // 'survival' disables flight (checked) for non-privileged players
  reach: 8.5, // blocks from the player's eye to the edited block centre (client reach is 7)
  tickMs: 100, // snapshot rate: 10 Hz
  circuitMs: 200,
  editRate: 12, editBurst: 30,
  msgRate: 60, msgBurst: 120,
  chatRate: 0.8, chatBurst: 4,
  maxWalk: 7.5, maxFly: 22, speedSlack: 1.4,
  maxMalformed: 25,
  editLogSize: 20000,
  ownerMapSize: 200000,
  allowUnloaded: false,
  circuits: false,
  protect: [],
  lobby: false,
  name: 'GIGATRON room',
  motd: '',
});

const r2 = (v) => Math.round(v * 100) / 100;

export class Authority {
  constructor(opts) {
    this.o = { ...AUTHORITY_DEFAULTS, ...opts };
    this.world = opts.world; // { getBlock(x,y,z) -> id|null, setBlock(x,y,z,id), groundBelow?(x,y,z) }
    this.seed = opts.seed >>> 0;
    this.now = opts.now || (() => Date.now());
    this.transportSend = opts.send || (() => {});
    this.transportClose = opts.close || (() => {});
    this.log = opts.log || (() => {});
    this.timeOfDay = opts.time || (() => 0);
    this.spawn = opts.spawn || { x: 0.5, y: 40, z: 0.5 };
    this.peers = new Map();
    this.plugins = [];
    this.banned = new Set();
    this.editLog = [];
    this.editSeq = 0;
    this.owners = new Map(); // "x,y,z" -> { by, name, t } last non-air placer
    this.circuit = this.o.circuits ? new CircuitSim() : null;
    this.lastTick = -Infinity;
    this.lastCircuit = -Infinity;
    this.rosterDirty = false;
    this.lastRoster = -Infinity;
    this.nextId = 1;
    this.counters = { malformed: 0, oversize: 0, rateLimited: 0, denied: 0, edits: 0 };
  }

  use(plugin) {
    this.plugins.push(plugin);
    plugin.attach?.(this);
    return plugin;
  }

  emit(hook, ...args) {
    let out;
    for (const p of this.plugins) {
      if (typeof p[hook] !== 'function') continue;
      const r = p[hook](...args);
      if (r !== undefined && out === undefined) out = r;
    }
    return out;
  }

  get humans() {
    let n = 0;
    for (const p of this.peers.values()) if (p.hello && !p.bot) n++;
    return n;
  }

  get bots() {
    let n = 0;
    for (const p of this.peers.values()) if (p.bot) n++;
    return n;
  }

  status() {
    return { t: 'status', name: this.o.name, players: this.humans, cap: this.o.cap, bots: this.bots, open: this.humans < this.o.cap };
  }

  newPeer(id, extra) {
    const now = this.now();
    return {
      id, key: id, name: 'Builder', hello: false, bot: false, privileged: false, local: null, color: colorFor(id), title: '',
      pos: null, lastStateAt: 0, moveBudget: 0, hover: 0, joinedAt: now,
      limits: { msg: createRateLimiter(this.o.msgRate, this.o.msgBurst), edit: createRateLimiter(this.o.editRate, this.o.editBurst), chat: createRateLimiter(this.o.chatRate, this.o.chatBurst), slow: createRateLimiter(1, 2) },
      stats: { placed: 0, broken: 0, crystals: 0, quests: 0 }, questSeen: new Set(),
      mutedUntil: 0, throttleUntil: 0, malformed: 0, drops: 0, lastDenyAt: -Infinity, lastProbe: false,
      ...extra,
    };
  }

  // ----- transport entry points -----
  connect(id, { key } = {}) {
    if (this.peers.has(id)) return false;
    const peer = this.newPeer(id, { key: key || id });
    if (this.banned.has(peer.key)) {
      this.transportSend(id, { t: 'kick', reason: 'You are banned from this session.' });
      this.transportClose(id, 'banned');
      return false;
    }
    this.peers.set(id, peer);
    return true;
  }

  receive(id, raw) {
    const peer = this.peers.get(id);
    if (!peer || peer.local) return;
    const now = this.now();
    if (!peer.limits.msg(now)) {
      this.counters.rateLimited++;
      if (++peer.drops > this.o.msgBurst * 4) this.kick(id, 'Too many messages.');
      return;
    }
    const obj = parseWire(raw, MAX_CLIENT_MESSAGE_BYTES);
    const msg = obj && validateClientMessage(obj);
    if (!msg) {
      this.counters.malformed++;
      if (!obj) this.counters.oversize++;
      if (++peer.malformed > this.o.maxMalformed) this.kick(id, 'Malformed traffic.');
      return;
    }
    this.handle(peer, msg, now);
  }

  disconnect(id, reason = 'left') {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (!peer.hello) return;
    if (peer.resume && !peer.bot) this.o.scorebook?.put(peer.resume, peer.name, peer.stats);
    this.broadcast({ t: 'leave', p: id });
    this.system(peer.name + (peer.bot ? ' [BOT]' : '') + ' left.');
    this.rosterDirty = true;
    this.emit('onLeave', peer, reason);
  }

  // ----- local peers (the hosting browser's own player, bots) -----
  addLocal(id, { name, bot = false, privileged = 'host', color, sink = null, pos = null }) {
    const peer = this.newPeer(id, { local: sink || (() => {}), bot, privileged, name, hello: true, pos: pos || { ...this.spawn, yaw: 0, pitch: 0 } });
    if (color !== undefined) peer.color = color;
    this.peers.set(id, peer);
    this.rosterDirty = true;
    if (bot) this.emit('onJoin', peer);
    return peer;
  }

  localState(id, s) {
    const peer = this.peers.get(id);
    if (peer) this.applyState(peer, { t: 'state', x: s.x, y: s.y, z: s.z, yaw: s.yaw || 0, pitch: s.pitch || 0, fly: !!s.fly }, this.now());
  }

  localEdit(id, x, y, z, blockId, { applied = false } = {}) {
    const peer = this.peers.get(id);
    if (!peer) return { ok: false, reason: 'unknown peer' };
    return this.edit(peer, { t: 'edit', x, y, z, id: blockId }, this.now(), { applied });
  }

  localChat(id, text) {
    const peer = this.peers.get(id);
    if (!peer) return false;
    const msg = validateClientMessage({ t: 'chat', text });
    return msg ? this.chat(peer, msg, this.now()) : false;
  }

  // ----- dispatch -----
  handle(peer, msg, now) {
    if (msg.t === 'probe') {
      this.send(peer, this.status());
      if (!peer.hello) this.transportClose(peer.id, 'probe');
      return;
    }
    if (msg.t === 'hello') return this.hello(peer, msg, now);
    if (!peer.hello) return;
    if (msg.t === 'state') this.applyState(peer, msg, now);
    else if (msg.t === 'edit') this.edit(peer, msg, now);
    else if (msg.t === 'chat') this.chat(peer, msg, now);
    else if (msg.t === 'quest') this.quest(peer, msg);
  }

  uniqueName(base) {
    let name = isReservedName(base) ? 'Builder' : base;
    const taken = new Set([...this.peers.values()].filter((p) => p.hello).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 1000; i++) {
      const n = (name.slice(0, 12) + '-' + i);
      if (!taken.has(n.toLowerCase())) return n;
    }
    return 'Builder-' + this.nextId++;
  }

  hello(peer, msg, now) {
    if (peer.hello) return;
    if (this.humans >= this.o.cap) {
      this.send(peer, { t: 'kick', reason: 'This world is full (' + this.humans + '/' + this.o.cap + ' players). Try again soon.' });
      this.transportClose(peer.id, 'full');
      return;
    }
    peer.name = this.uniqueName(sanitizeName(msg.name));
    let restored = false;
    const book = this.o.scorebook;
    if (book) {
      // A token already in use by a connected player is not honoured twice.
      const inUse = msg.resume && [...this.peers.values()].some((p) => p !== peer && p.resume === msg.resume);
      const saved = inUse ? null : book.take(msg.resume);
      if (saved) {
        peer.stats = { ...peer.stats, ...saved.stats };
        restored = true;
      }
      peer.resume = saved ? msg.resume : book.issue();
    }
    peer.hello = true;
    peer.joinedAt = now;
    peer.pos = { ...this.spawn, yaw: 0, pitch: 0 };
    peer.lastStateAt = now;
    peer.moveBudget = 16; // small grace while the client settles (spawn itself is exempt below)
    const edits = this.world.flatEdits ? this.world.flatEdits() : (this.o.snapshotEdits?.() || []);
    const first = edits.slice(0, EDIT_BATCH * 4);
    const rest = Math.max(0, Math.ceil((edits.length - first.length) / (EDIT_BATCH * 4)));
    this.send(peer, {
      t: 'welcome', v: PROTOCOL_VERSION, id: peer.id, seed: this.seed, edits: first, more: rest, time: this.timeOfDay(),
      mode: this.o.mode, cap: this.o.cap, protect: this.o.protect, spawn: this.spawn, lobby: this.o.lobby, motd: this.o.motd,
      ...(peer.resume ? { resume: peer.resume } : {}),
    });
    for (let i = first.length; i < edits.length; i += EDIT_BATCH * 4) this.send(peer, { t: 'edits', edits: edits.slice(i, i + EDIT_BATCH * 4) });
    this.system(peer.name + ' joined.');
    if (restored) this.send(peer, { t: 'chat', p: '', name: 'SERVER', sys: true, text: 'Welcome back! Your lobby score (' + this.score(peer) + ' pts) was restored.' });
    this.rosterDirty = true;
    this.flushRoster(now, true);
    this.emit('onJoin', peer);
  }

  // ----- movement -----
  applyState(peer, msg, now) {
    const prev = peer.pos;
    const dt = Math.max(16, now - (peer.lastStateAt || now));
    peer.lastStateAt = now;
    if (!prev || peer.privileged === 'host') {
      peer.pos = { x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch };
      return true;
    }
    const creative = this.o.mode === 'creative';
    const vmax = (creative ? this.o.maxFly : this.o.maxWalk) * this.o.speedSlack;
    peer.moveBudget = Math.min(Math.max(peer.moveBudget, 0) + (vmax * dt) / 1000, Math.max(vmax + 2, peer.moveBudget));
    const dh = Math.hypot(msg.x - prev.x, msg.z - prev.z);
    const up = msg.y - prev.y;
    const nearSpawn = Math.hypot(msg.x - this.spawn.x, msg.z - this.spawn.z) < 3 && Math.abs(msg.y - this.spawn.y) < 6;
    const upMax = ((creative ? this.o.maxFly : 12) * dt) / 1000 + 2;
    if (!nearSpawn && (dh > peer.moveBudget + 0.5 || up > upMax)) {
      peer.moveBudget = vmax * 0.25;
      this.send(peer, { t: 'pos', x: prev.x, y: prev.y, z: prev.z });
      this.emit('onViolation', peer, 'speed', { dh: r2(dh), up: r2(up), dt });
      return false;
    }
    peer.moveBudget -= dh;
    if (!creative && !peer.privileged && this.world.groundBelow) {
      const ground = this.world.groundBelow(msg.x, msg.y, msg.z);
      const air = msg.y - (ground + 1);
      if (air > 2.2 && msg.y >= prev.y - 0.02) peer.hover += dt;
      else peer.hover = Math.max(0, peer.hover - dt);
      if (peer.hover > 2000) {
        peer.hover = 0;
        const gy = ground + 1;
        peer.pos = { x: msg.x, y: gy, z: msg.z, yaw: msg.yaw, pitch: msg.pitch };
        this.send(peer, { t: 'pos', x: msg.x, y: gy, z: msg.z });
        this.emit('onViolation', peer, 'flight', { air: r2(air) });
        return false;
      }
    }
    peer.pos = { x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch };
    return true;
  }

  setPos(peer, x, y, z) {
    peer.pos = { ...(peer.pos || {}), x, y, z };
    if (!peer.local) this.send(peer, { t: 'pos', x, y, z });
  }

  // ----- edits -----
  inProtected(x, z) {
    for (const r of this.o.protect) if (Math.hypot(x + 0.5 - r.x, z + 0.5 - r.z) <= r.r) return r;
    return null;
  }

  checkEdit(peer, e, now) {
    const host = peer.privileged === 'host';
    if (!host && peer.throttleUntil > now && !peer.limits.slow(now)) return 'throttled'; // WARDEN throttle: 1 edit/s
    if (!host && !peer.limits.edit(now)) return 'rate';
    if (!host && PEER_FORBIDDEN.has(e.id)) return 'forbidden block';
    const cur = this.world.getBlock(e.x, e.y, e.z);
    if (cur === null && !this.o.allowUnloaded) return 'unloaded';
    if (cur !== null) {
      if (cur === e.id) return 'no change';
      const curDef = BLOCKS[cur];
      const toggle = (cur === B.SWITCH_OFF && e.id === B.SWITCH_ON) || (cur === B.SWITCH_ON && e.id === B.SWITCH_OFF);
      if (!host && e.id === B.SWITCH_ON && !toggle) return 'forbidden block';
      if (!host && cur !== B.AIR && cur !== B.FLUID && curDef && !curDef.breakable) return 'unbreakable';
      if (!host && e.id !== B.AIR && cur !== B.AIR && cur !== B.FLUID && !toggle) return 'occupied';
    }
    if (!host) {
      const p = peer.pos;
      if (!p) return 'no position';
      const d = Math.hypot(e.x + 0.5 - p.x, e.y + 0.5 - (p.y + 1.6), e.z + 0.5 - p.z);
      if (d > this.o.reach) return 'out of reach';
    }
    // Protected regions (spawn plaza, Gigatron Beacon): only the host and the server bots edit there.
    if (!peer.privileged) {
      const region = this.inProtected(e.x, e.z);
      if (region) return 'protected:' + (region.label || 'area');
    }
    const veto = this.emit('onEdit', peer, e, cur, now);
    if (veto) return veto;
    return null;
  }

  edit(peer, e, now, { applied = false } = {}) {
    // The hosting browser applies its own edits before reporting them (applied=true); they are trusted.
    const reason = applied && peer.privileged === 'host' ? null : this.checkEdit(peer, e, now);
    const cur = this.world.getBlock(e.x, e.y, e.z);
    if (reason) {
      this.counters.denied++;
      if (!peer.local && cur !== null && reason !== 'no change') this.send(peer, { t: 'edit', x: e.x, y: e.y, z: e.z, id: cur });
      if (!peer.local && now - peer.lastDenyAt > 1000 && reason !== 'no change') {
        peer.lastDenyAt = now;
        this.send(peer, { t: 'deny', reason: denyText(reason) });
      }
      this.emit('onDeny', peer, reason, e, now);
      return { ok: false, reason };
    }
    const ownerBefore = this.owners.get(e.x + ',' + e.y + ',' + e.z);
    this.commit(peer.id, peer.name, e.x, e.y, e.z, e.id, cur, { applied, except: peer.id });
    if (e.id !== B.AIR) {
      peer.stats.placed++;
      this.rosterDirty = true;
    } else peer.stats.broken++;
    this.emit('afterEdit', peer, { ...e, ownerBefore }, cur, now);
    return { ok: true };
  }

  // Apply + log + broadcast. Used by validated peer edits, bots, rollback and the circuit sim.
  commit(by, name, x, y, z, id, prev, { applied = false, except = null, log = true } = {}) {
    if (!applied) this.world.setBlock(x, y, z, id);
    this.circuit?.track(x, y, z, id);
    const k = x + ',' + y + ',' + z;
    if (log) {
      const entry = { seq: ++this.editSeq, t: this.now(), by, x, y, z, prev: prev ?? B.AIR, id, prevOwner: this.owners.get(k) || null };
      this.editLog.push(entry);
      if (this.editLog.length > this.o.editLogSize) this.editLog.splice(0, this.editLog.length - this.o.editLogSize);
      if (id === B.AIR) this.owners.delete(k);
      else {
        this.owners.delete(k);
        this.owners.set(k, { by, name, t: entry.t });
        if (this.owners.size > this.o.ownerMapSize) this.owners.delete(this.owners.keys().next().value);
      }
    }
    this.counters.edits++;
    this.broadcast({ t: 'edit', x, y, z, id }, except);
  }

  serverEdit(by, x, y, z, id) {
    const cur = this.world.getBlock(x, y, z);
    if (cur === id) return false;
    this.commit(by, by, x, y, z, id, cur);
    return true;
  }

  // Undo a peer's edits newer than `since` (ms timestamp), newest first. Only restores a cell if it
  // still holds what that peer put there, so later legitimate edits are not clobbered.
  rollback(peerId, since, by = 'WARDEN') {
    let n = 0;
    for (let i = this.editLog.length - 1; i >= 0; i--) {
      const e = this.editLog[i];
      if (e.t < since) break;
      if (e.by !== peerId) continue;
      if (this.world.getBlock(e.x, e.y, e.z) !== e.id) continue;
      this.commit(by, by, e.x, e.y, e.z, e.prev, e.id);
      // Restored blocks go back to whoever owned them before (so they stay protected as theirs).
      const k = e.x + ',' + e.y + ',' + e.z;
      this.owners.delete(k);
      if (e.prevOwner && e.prev !== B.AIR) this.owners.set(k, e.prevOwner);
      n++;
    }
    return n;
  }

  // ----- chat -----
  chat(peer, msg, now) {
    if (peer.mutedUntil > now) {
      this.tell(peer, 'You are muted for ' + Math.ceil((peer.mutedUntil - now) / 1000) + ' s.', 'WARDEN');
      return false;
    }
    if (!peer.limits.chat(now)) {
      this.emit('onChatFlood', peer, now);
      return false;
    }
    if (msg.text.startsWith('/')) {
      const [cmd, ...args] = msg.text.slice(1).split(' ');
      if (this.emit('onCommand', peer, cmd.toLowerCase(), args, now)) return true;
    }
    if (this.emit('onChat', peer, msg.text, now) === false) return false;
    this.broadcast({ t: 'chat', p: peer.id, name: peer.name, bot: peer.bot, text: msg.text });
    return true;
  }

  quest(peer, msg) {
    if (peer.questSeen.has(msg.index) || peer.questSeen.size >= 8) return;
    peer.questSeen.add(msg.index);
    peer.stats.quests++;
    this.rosterDirty = true;
  }

  // ----- moderation helpers (used by WARDEN) -----
  tell(peer, text, from = 'SERVER') {
    this.send(peer, { t: 'chat', p: '', name: from, bot: from !== 'SERVER', sys: from === 'SERVER', text });
  }

  // Write every connected player's score to the scorebook (the host calls this before saving).
  checkpointScores() {
    const book = this.o.scorebook;
    if (!book) return;
    for (const p of this.peers.values()) if (p.hello && !p.bot && p.resume) book.put(p.resume, p.name, p.stats);
  }

  system(text) {
    this.broadcast({ t: 'chat', p: '', name: 'SERVER', sys: true, text });
  }

  kick(id, reason) {
    const peer = this.peers.get(id);
    if (!peer || peer.local) return false;
    this.log('kick', { peer: id, name: peer.name, key: peer.key, reason });
    this.send(peer, { t: 'kick', reason });
    this.transportClose(id, 'kick');
    this.disconnect(id, 'kick');
    return true;
  }

  ban(id, reason) {
    const peer = this.peers.get(id);
    if (!peer || peer.local) return false;
    this.banned.add(peer.key);
    return this.kick(id, reason + ' (banned for this session)');
  }

  // ----- outbound -----
  send(peer, msg) {
    if (peer.local) peer.local(msg);
    else this.transportSend(peer.id, msg);
  }

  broadcast(msg, exceptId = null) {
    for (const p of this.peers.values()) if (p.hello && p.id !== exceptId && !p.bot) this.send(p, msg);
  }

  score(p) {
    return p.stats.placed + p.stats.crystals * 10 + p.stats.quests * 5;
  }

  roster() {
    const players = [...this.peers.values()].filter((p) => p.hello).map((p) => ({
      p: p.id, name: p.name, bot: p.bot, host: p.privileged === 'host', color: p.color, title: p.title,
      score: this.score(p), placed: p.stats.placed, crystals: p.stats.crystals, quests: p.stats.quests,
    }));
    return { t: 'roster', cap: this.o.cap, players };
  }

  flushRoster(now, force = false) {
    if (!this.rosterDirty || (!force && now - this.lastRoster < 1000)) return;
    this.rosterDirty = false;
    this.lastRoster = now;
    this.broadcast(this.roster());
  }

  tick(now = this.now()) {
    if (this.circuit && now - this.lastCircuit >= this.o.circuitMs) {
      this.lastCircuit = now;
      for (const c of this.circuit.step((x, y, z) => this.world.getBlock(x, y, z))) {
        this.commit('circuit', 'circuit', c.x, c.y, c.z, c.id, null, { log: false });
      }
    }
    this.emit('tick', now);
    if (now - this.lastTick >= this.o.tickMs) {
      this.lastTick = now;
      const states = [];
      for (const p of this.peers.values()) if (p.hello && p.pos) states.push([p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.pos.yaw || 0), r2(p.pos.pitch || 0)]);
      if (states.length > 1) {
        for (const p of this.peers.values()) {
          if (!p.hello || p.bot) continue;
          const s = states.filter((e) => e[0] !== p.id);
          if (s.length) this.send(p, { t: 'snap', s });
        }
      }
    }
    this.flushRoster(now);
  }

  trackCircuitsFromWorld(positions) {
    if (!this.circuit) return;
    for (const [x, y, z] of positions) this.circuit.track(x, y, z, this.world.getBlock(x, y, z));
  }
}

function denyText(reason) {
  if (reason.startsWith('protected:')) return 'The ' + reason.slice(10) + ' is protected. Build outside the glowing plaza.';
  return {
    rate: 'Slow down - too many edits.', throttled: 'You are rate-limited for a moment.', 'forbidden block': 'That block cannot be placed in multiplayer.',
    unbreakable: 'That block cannot be broken.', occupied: 'Something is already there.', 'out of reach': 'Too far away.',
    unloaded: 'That area is not loaded on the host yet.', 'no position': 'Move a little first.',
  }[reason] || 'Edit rejected: ' + reason;
}
