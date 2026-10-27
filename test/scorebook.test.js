// Resume tokens: scores survive reconnects and restarts; tokens are hashed at rest, single-use per
// session, validated, expiring and size-capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createScorebook } from '../src/core/scorebook.js';
import { validateClientMessage, validateHostMessage } from '../src/core/protocol.js';
import { makeLobby } from './lobby-harness.mjs';

const hash = (t) => createHash('sha256').update(t).digest('hex');
const randomToken = () => randomBytes(16).toString('hex');

test('scorebook: put/take round trip, hashed keys, expiry, cap, junk input ignored', () => {
  let t = 1000;
  const b = createScorebook({ hash, randomToken, now: () => t, ttlMs: 10000, maxEntries: 2 });
  const tok = b.issue();
  assert.match(tok, /^[a-f0-9]{32}$/);
  b.put(tok, 'Ann', { placed: 5, crystals: 1, quests: 2, broken: 3 });
  const json = JSON.stringify(b.toJSON());
  assert.ok(!json.includes(tok), 'raw tokens are never stored');
  assert.deepEqual(b.take(tok).stats, { placed: 5, broken: 3, crystals: 1, quests: 2 });
  assert.equal(b.take('nope'), null);
  assert.equal(b.take(randomToken()), null);
  const b2 = createScorebook({ hash, randomToken, now: () => t, ttlMs: 10000, entries: JSON.parse(json) });
  assert.equal(b2.take(tok).name, 'Ann', 'survives serialisation (restart)');
  t += 20000;
  assert.equal(b2.take(tok), null, 'expired');
  b.put(randomToken(), 'B', {}); b.put(randomToken(), 'C', {}); b.put(randomToken(), 'D', {});
  assert.equal(b.size, 2, 'size-capped');
  const junk = createScorebook({ hash, randomToken, entries: { x: 1, ['a'.repeat(64)]: { name: 5, seen: Date.now(), stats: { placed: -3, crystals: 'x' } } } });
  assert.equal(junk.size, 1);
  assert.deepEqual(junk.toJSON()['a'.repeat(64)].stats, { placed: 0, broken: 0, crystals: 0, quests: 0 });
});

test('protocol: resume tokens are validated both ways', () => {
  assert.equal(validateClientMessage({ t: 'hello', v: 2, name: 'A', resume: 'x'.repeat(32) }).resume, null);
  const tok = randomToken();
  assert.equal(validateClientMessage({ t: 'hello', v: 2, name: 'A', resume: tok }).resume, tok);
  const w = { t: 'welcome', v: 2, seed: 1, edits: [], resume: '<script>' };
  assert.equal(validateHostMessage(w).resume, null);
});

test('lobby: a returning player gets their score back; a token cannot be used twice at once', () => {
  let t = 0;
  const book = createScorebook({ hash, randomToken, now: () => t });
  const h = makeLobby({ spark: false, hive: false, scorebook: book });
  const a = h.join('Ann');
  const tok = a.of('welcome')[0].resume;
  assert.match(tok, /^[a-f0-9]{32}$/);
  h.a.peers.get(a.id).stats.placed = 42;
  a.leave();
  const back = h.join('Ann', { resume: tok });
  assert.equal(h.a.peers.get(back.id).stats.placed, 42);
  assert.ok(back.chats().some((c) => /Welcome back/.test(c)));
  const thief = h.join('Mallory', { resume: tok });
  assert.equal(h.a.peers.get(thief.id).stats.placed, 0, 'same token while the owner is online: no restore');
  assert.notEqual(thief.of('welcome')[0].resume, tok, 'and a fresh token is issued');
});
