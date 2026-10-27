import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, createAchievementState, validateAchievementState, recordStat } from '../src/core/achievements.js';
import { nextNudge, NUDGES } from '../src/core/onboarding.js';

test('achievements unlock once at their targets and survive a save round-trip', () => {
  let s = createAchievementState();
  let r = recordStat(s, 'placed');
  assert.deepEqual(r.unlocked.map((a) => a.id), ['first-block']);
  s = r.state;
  for (let i = 0; i < 48; i++) s = recordStat(s, 'placed').state;
  r = recordStat(s, 'placed');
  assert.deepEqual(r.unlocked.map((a) => a.id), ['builder-50']);
  assert.equal(recordStat(r.state, 'placed').unlocked.length, 0, 'no repeats');
  const loaded = validateAchievementState(JSON.parse(JSON.stringify(r.state)));
  assert.deepEqual(loaded, r.state);
  assert.equal(recordStat(s, 'nonsense').state, s);
  assert.deepEqual(validateAchievementState({ stats: { placed: -5, broken: 'x' }, unlocked: ['bogus', 'lobby'] }).unlocked, ['lobby']);
  assert.ok(ACHIEVEMENTS.every((a) => a.title && a.desc && a.target > 0));
});

test('crystal + lobby + champion achievements', () => {
  let s = createAchievementState();
  const r1 = recordStat(s, 'crystals', 5);
  assert.deepEqual(r1.unlocked.map((a) => a.id), ['crystal-5']);
  assert.equal(recordStat(s, 'lobbyJoins').unlocked[0].id, 'lobby');
  assert.equal(recordStat(s, 'rushWins').unlocked[0].title, 'Crystal Champ');
});

test('onboarding nudges: in order, once each, skipping what the player already did', () => {
  const shown = new Set();
  const done = { moved: false, broken: true, placed: false, beacon: false, multiplayer: false };
  assert.equal(nextNudge(3, done, shown), null);
  assert.equal(nextNudge(6, done, shown).id, 'look');
  assert.equal(nextNudge(7, done, shown), null);
  done.moved = true;
  assert.equal(nextNudge(30, done, shown).id, 'place', 'break skipped because already done');
  assert.equal(nextNudge(45, done, shown).id, 'beacon');
  assert.equal(nextNudge(61, done, shown).id, 'lobby');
  assert.equal(nextNudge(90, done, shown), null);
  assert.equal(shown.size, NUDGES.length);
});
