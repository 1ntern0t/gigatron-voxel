// Multiplayer wire protocol. Every inbound message is validated: peers are untrusted.
import { HEIGHT } from './constants.js';
import { isValidBlockId } from './blocks.js';

export const PROTOCOL_VERSION = 1;
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_PREFIX = 'gigatron-voxel-v1-';
const MAX_COORD = 1e7;
const MAX_EDITS_IN_WELCOME = 200000;

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
  const n = String(name ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 16);
  return n || 'Builder';
}

export function sanitizeText(text, max = 140) {
  // Strip control characters and Unicode bidi overrides (which can make a chat line read
  // backwards or spoof another player's name); rendering always uses textContent (never innerHTML).
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);
}

const isInt = (v) => Number.isInteger(v) && Math.abs(v) <= MAX_COORD;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'hello':
      if (msg.v !== PROTOCOL_VERSION) return null;
      return { t: 'hello', v: PROTOCOL_VERSION, name: sanitizeName(msg.name) };
    case 'welcome': {
      if (msg.v !== PROTOCOL_VERSION || !Number.isInteger(msg.seed) || msg.seed < 0 || msg.seed > 0xffffffff) return null;
      if (!Array.isArray(msg.edits) || msg.edits.length > MAX_EDITS_IN_WELCOME * 4 || msg.edits.length % 4 !== 0) return null;
      for (let i = 0; i < msg.edits.length; i += 4) {
        if (!isInt(msg.edits[i]) || !Number.isInteger(msg.edits[i + 1]) || msg.edits[i + 1] < 0 || msg.edits[i + 1] >= HEIGHT || !isInt(msg.edits[i + 2]) || !isValidBlockId(msg.edits[i + 3])) return null;
      }
      const time = isNum(msg.time) ? msg.time : 0;
      return { t: 'welcome', v: PROTOCOL_VERSION, seed: msg.seed, edits: msg.edits, time, id: sanitizeName(msg.id) };
    }
    case 'edit':
      if (!isInt(msg.x) || !isInt(msg.z) || !Number.isInteger(msg.y) || msg.y < 0 || msg.y >= HEIGHT || !isValidBlockId(msg.id)) return null;
      return { t: 'edit', x: msg.x, y: msg.y, z: msg.z, id: msg.id };
    case 'state':
      if (![msg.x, msg.y, msg.z, msg.yaw, msg.pitch].every(isNum)) return null;
      return { t: 'state', p: typeof msg.p === 'string' ? sanitizeName(msg.p) : '', name: sanitizeName(msg.name), x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch };
    case 'chat':
      return { t: 'chat', p: typeof msg.p === 'string' ? sanitizeName(msg.p) : '', name: sanitizeName(msg.name), text: sanitizeText(msg.text) };
    case 'leave':
      return { t: 'leave', p: sanitizeName(msg.p) };
    default:
      return null;
  }
}

// Simple token bucket per peer.
export function createRateLimiter(ratePerSec, burst) {
  let tokens = burst;
  let last = 0;
  return function allow(now) {
    if (last === 0) last = now;
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSec);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };
}
