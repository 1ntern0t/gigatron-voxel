// Multiplayer wire protocol. Every inbound message is validated: peers are untrusted.
// Pure module (no DOM): shared by the browser client, the browser host and the Node lobby host.
import { HEIGHT } from './constants.js';
import { B, isValidBlockId } from './blocks.js';

export const PROTOCOL_VERSION = 2;
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_PREFIX = 'gigatron-voxel-v1-';
// Inbound client->host messages are tiny (hello/state/edit/chat). Anything bigger is dropped unparsed.
export const MAX_CLIENT_MESSAGE_BYTES = 2048;
// Host->client messages (welcome + edit batches). Batches keep each message far below this.
export const MAX_HOST_MESSAGE_BYTES = 1 << 20;
export const EDIT_BATCH = 4000;
export const MAX_CHAT = 140;
export const MAX_NAME = 16;
const MAX_COORD = 1e6;
const MAX_EDITS_IN_WELCOME = 200000;
const MAX_SNAP = 128;
const MAX_ROSTER = 128;

// Blocks a peer may never place directly. Powered variants are produced only by the host's
// circuit simulation; Switch (on) is allowed only as a toggle of an existing switch (checked by the host).
export const PEER_FORBIDDEN = new Set([B.BEDROCK, B.CORE, B.BEACON, B.FLUID, B.WIRE_ON, B.LAMP_ON, B.DOOR_OPEN, B.NOT_ON]);

// Names that only the host/bots may use, so nobody can pretend to be a bot or the host.
const RESERVED_NAMES = /^(warden|spark|hive|gigatron|host|server|admin|mod|moderator|system|bot)\b/i;

export function makeRoomCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return s;
}

export function normalizeRoomCode(code) {
  const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 6) return null;
  for (const ch of c) if (!ROOM_ALPHABET.includes(ch)) return null;
  return c;
}

export function roomPeerId(code) {
  return ROOM_PREFIX + code;
}

export function sanitizeName(name) {
  const n = String(name ?? '').replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return n || 'Builder';
}

export function isReservedName(name) {
  return RESERVED_NAMES.test(String(name).trim());
}

// Strip control characters, zero-width characters and Unicode bidi overrides (which can make a chat
// line read backwards or spoof another player's name). Rendering always uses textContent (never innerHTML).
export function sanitizeText(text, max = MAX_CHAT) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g, '')
    .slice(0, max);
}

export function cleanChat(text) {
  return sanitizeText(text, 400).replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT);
}

const isInt = (v) => Number.isInteger(v) && Math.abs(v) <= MAX_COORD;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const isY = (v) => Number.isInteger(v) && v >= 0 && v < HEIGHT;
const isResumeToken = (v) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const shortId = (v) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) : '');

// Parse raw transport data with a byte cap. Returns an object or null.
export function parseWire(raw, maxBytes = MAX_CLIENT_MESSAGE_BYTES) {
  if (typeof raw === 'string') {
    if (raw.length > maxBytes) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object' && !ArrayBuffer.isView(raw) && !(raw instanceof ArrayBuffer)) {
    let s;
    try {
      s = JSON.stringify(raw);
    } catch {
      return null;
    }
    return s && s.length <= maxBytes ? JSON.parse(s) : null;
  }
  return null;
}

function validEditList(edits) {
  if (!Array.isArray(edits) || edits.length > MAX_EDITS_IN_WELCOME * 4 || edits.length % 4 !== 0) return false;
  for (let i = 0; i < edits.length; i += 4) {
    if (!isInt(edits[i]) || !isY(edits[i + 1]) || !isInt(edits[i + 2]) || !isValidBlockId(edits[i + 3])) return false;
  }
  return true;
}

function validRegions(list) {
  if (!Array.isArray(list) || list.length > 16) return [];
  return list.filter((r) => r && isNum(r.x) && isNum(r.z) && isNum(r.r) && r.r > 0 && r.r < 200)
    .map((r) => ({ x: r.x, z: r.z, r: r.r, label: sanitizeText(r.label, 32) }));
}

// Messages a CLIENT sends; validated by the host (authority.js).
export function validateClientMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'hello':
      if (msg.v !== PROTOCOL_VERSION) return null;
      return { t: 'hello', v: PROTOCOL_VERSION, name: sanitizeName(msg.name), resume: isResumeToken(msg.resume) ? msg.resume : null };
    case 'probe':
      return { t: 'probe' };
    case 'edit':
      if (!isInt(msg.x) || !isInt(msg.z) || !isY(msg.y) || !isValidBlockId(msg.id)) return null;
      return { t: 'edit', x: msg.x, y: msg.y, z: msg.z, id: msg.id };
    case 'state':
      if (![msg.x, msg.y, msg.z, msg.yaw, msg.pitch].every(isNum)) return null;
      if (msg.y < -64 || msg.y > HEIGHT + 64) return null;
      return { t: 'state', x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch, fly: msg.fly === true };
    case 'chat': {
      const text = cleanChat(msg.text);
      return text ? { t: 'chat', text } : null;
    }
    case 'quest':
      return Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 32 ? { t: 'quest', index: msg.index } : null;
    default:
      return null;
  }
}

// Messages the HOST sends; validated by clients (a hostile host must not be able to break the page).
export function validateHostMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'welcome': {
      if (msg.v !== PROTOCOL_VERSION || !Number.isInteger(msg.seed) || msg.seed < 0 || msg.seed > 0xffffffff) return null;
      if (!validEditList(msg.edits)) return null;
      const spawn = msg.spawn && [msg.spawn.x, msg.spawn.y, msg.spawn.z].every(isNum) ? { x: msg.spawn.x, y: msg.spawn.y, z: msg.spawn.z } : null;
      return {
        t: 'welcome', v: PROTOCOL_VERSION, seed: msg.seed, edits: msg.edits, time: isNum(msg.time) ? msg.time : 0, id: shortId(msg.id),
        mode: msg.mode === 'survival' ? 'survival' : 'creative', cap: Number.isInteger(msg.cap) && msg.cap > 0 && msg.cap <= 256 ? msg.cap : 8,
        protect: validRegions(msg.protect), spawn, lobby: msg.lobby === true, more: Number.isInteger(msg.more) && msg.more >= 0 ? msg.more : 0,
        motd: sanitizeText(msg.motd, 200), resume: isResumeToken(msg.resume) ? msg.resume : null,
      };
    }
    case 'edits':
      return validEditList(msg.edits) ? { t: 'edits', edits: msg.edits } : null;
    case 'edit':
      if (!isInt(msg.x) || !isInt(msg.z) || !isY(msg.y) || !isValidBlockId(msg.id)) return null;
      return { t: 'edit', x: msg.x, y: msg.y, z: msg.z, id: msg.id };
    case 'snap': {
      if (!Array.isArray(msg.s) || msg.s.length > MAX_SNAP) return null;
      const s = [];
      for (const e of msg.s) {
        if (!Array.isArray(e) || e.length !== 6 || !shortId(e[0]) || !e.slice(1).every(isNum)) return null;
        s.push([shortId(e[0]), e[1], e[2], e[3], e[4], e[5]]);
      }
      return { t: 'snap', s };
    }
    case 'roster': {
      if (!Array.isArray(msg.players) || msg.players.length > MAX_ROSTER) return null;
      const players = msg.players.filter((p) => p && shortId(p.p)).map((p) => ({
        p: shortId(p.p), name: sanitizeName(p.name), bot: p.bot === true, host: p.host === true,
        color: Number.isInteger(p.color) && p.color >= 0 && p.color <= 0xffffff ? p.color : 0x7ff6ff,
        title: sanitizeText(p.title, 24), score: Number.isInteger(p.score) && p.score >= 0 ? Math.min(p.score, 1e9) : 0,
        placed: Number.isInteger(p.placed) ? Math.max(0, p.placed) : 0, crystals: Number.isInteger(p.crystals) ? Math.max(0, p.crystals) : 0,
        quests: Number.isInteger(p.quests) ? Math.max(0, p.quests) : 0,
      }));
      const cap = Number.isInteger(msg.cap) && msg.cap > 0 && msg.cap <= 256 ? msg.cap : 8;
      return { t: 'roster', cap, players };
    }
    case 'chat':
      return { t: 'chat', p: shortId(msg.p), name: sanitizeName(msg.name), bot: msg.bot === true, sys: msg.sys === true, text: sanitizeText(msg.text, 300) };
    case 'leave':
      return { t: 'leave', p: shortId(msg.p) };
    case 'deny':
      return { t: 'deny', reason: sanitizeText(msg.reason, 120) };
    case 'pos':
      return [msg.x, msg.y, msg.z].every(isNum) ? { t: 'pos', x: msg.x, y: msg.y, z: msg.z } : null;
    case 'kick':
      return { t: 'kick', reason: sanitizeText(msg.reason, 160) };
    case 'event':
      return { t: 'event', kind: sanitizeText(msg.kind, 24), text: sanitizeText(msg.text, 200) };
    case 'status':
      return {
        t: 'status', name: sanitizeText(msg.name, 48), players: Number.isInteger(msg.players) ? Math.max(0, msg.players) : 0,
        cap: Number.isInteger(msg.cap) && msg.cap > 0 ? msg.cap : 0, bots: Number.isInteger(msg.bots) ? Math.max(0, msg.bots) : 0,
        open: msg.open !== false,
      };
    default:
      return null;
  }
}

// Back-compat helper used by older tests/tools: accepts either direction.
export function validateMessage(msg) {
  return validateClientMessage(msg) || validateHostMessage(msg);
}

// Simple token bucket per peer.
export function createRateLimiter(ratePerSec, burst) {
  let tokens = burst;
  let last = null;
  const allow = function allow(now) {
    if (last === null) last = now;
    tokens = Math.min(burst, tokens + (Math.max(0, now - last) / 1000) * ratePerSec);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };
  allow.drain = () => { tokens = 0; };
  return allow;
}

// Stable per-player color (bright, readable on the dark UI).
export function colorFor(key) {
  let h = 0x811c9dc5;
  for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  const hue = ((h >>> 0) % 360) / 360;
  const f = (n) => {
    const k = (n + hue * 12) % 12;
    return Math.round(255 * (0.62 - 0.38 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
