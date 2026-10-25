import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorldGen, BIOMES } from '../src/core/worldgen.js';
import { CHUNK, HEIGHT, SEA, CHUNK_VOLUME, localIndex } from '../src/core/constants.js';
import { B, BLOCK_COUNT } from '../src/core/blocks.js';
import { parseSeed, hashString } from '../src/core/rng.js';

const digest = (u8) => createHash('sha256').update(u8).digest('hex');

test('same seed and coords produce identical chunks', () => {
  const a = createWorldGen(1234).generateChunk(3, -2).data;
  const b = createWorldGen(1234).generateChunk(3, -2).data;
  assert.equal(a.length, CHUNK_VOLUME);
  assert.equal(digest(a), digest(b));
});

test('different seeds produce different terrain', () => {
  const a = createWorldGen(1).generateChunk(0, 0).data;
  const b = createWorldGen(2).generateChunk(0, 0).data;
  assert.notEqual(digest(a), digest(b));
});

test('generation order does not affect results', () => {
  const g1 = createWorldGen(99);
  const first = digest(g1.generateChunk(5, 5).data);
  const g2 = createWorldGen(99);
  g2.generateChunk(-7, 4);
  g2.generateChunk(0, 0);
  assert.equal(digest(g2.generateChunk(5, 5).data), first);
});

test('chunks contain only valid ids, bedrock floor, and nothing at the ceiling', () => {
  const g = createWorldGen(42);
  for (const [cx, cz] of [[0, 0], [10, -10], [-30, 17]]) {
    const { data } = g.generateChunk(cx, cz);
    for (let i = 0; i < data.length; i++) assert.ok(data[i] < BLOCK_COUNT);
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        assert.equal(data[localIndex(lx, 0, lz)], B.BEDROCK);
        assert.equal(data[localIndex(lx, HEIGHT - 1, lz)], B.AIR);
      }
    }
  }
});

test('heightAt agrees with generated column tops', () => {
  const g = createWorldGen(7);
  const { data } = g.generateChunk(2, 3);
  for (const [lx, lz] of [[0, 0], [5, 9], [15, 15]]) {
    const h = g.heightAt(2 * CHUNK + lx, 3 * CHUNK + lz);
    assert.notEqual(data[localIndex(lx, h, lz)], B.AIR);
    assert.notEqual(data[localIndex(lx, h, lz)], B.FLUID);
  }
});

test('low terrain is flooded with data-stream fluid up to sea level', () => {
  const g = createWorldGen(5);
  let found = false;
  for (let cx = -12; cx <= 12 && !found; cx++) {
    for (let cz = -12; cz <= 12 && !found; cz++) {
      const { data, heights } = g.generateChunk(cx, cz);
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] < SEA - 1) {
          const lx = i % CHUNK;
          const lz = (i - lx) / CHUNK;
          assert.equal(data[localIndex(lx, SEA, lz)], B.FLUID);
          found = true;
          break;
        }
      }
    }
  }
  assert.ok(found, 'expected at least one flooded column nearby');
});

test('all four biomes appear across a wide area', () => {
  const g = createWorldGen(2026);
  const seen = new Set();
  for (let x = -3000; x <= 3000; x += 37) {
    for (let z = -3000; z <= 3000; z += 41) seen.add(g.biomeAt(x, z));
  }
  for (const b of Object.values(BIOMES)) assert.ok(seen.has(b), 'missing biome ' + b);
});

test('the Gigatron beacon structure is generated with core and lens', () => {
  const g = createWorldGen(31337);
  const { x, y, z } = g.beacon;
  const cx = Math.floor(x / CHUNK);
  const cz = Math.floor(z / CHUNK);
  const { data } = g.generateChunk(cx, cz);
  const lx = x - cx * CHUNK;
  const lz = z - cz * CHUNK;
  assert.equal(data[localIndex(lx, y + 22, lz)], B.BEACON);
  assert.equal(data[localIndex(lx, y + 20, lz)], B.CORE);
  assert.equal(g.biomeAt(x, z), 'Gigatron Beacon');
  const d = Math.hypot(x, z);
  assert.ok(d >= 30 && d <= 70, 'beacon should be a short walk from spawn');
});

test('spawn point is on dry land', () => {
  const g = createWorldGen(8);
  const s = g.findSpawn();
  assert.ok(s.y > SEA + 1);
});

test('wild drone spawns are deterministic', () => {
  const a = createWorldGen(11);
  const b = createWorldGen(11);
  const bc = [Math.floor(a.beacon.x / CHUNK), Math.floor(a.beacon.z / CHUNK)];
  assert.deepEqual(a.droneSpawnsForChunk(...bc), b.droneSpawnsForChunk(...bc));
  assert.ok(a.droneSpawnsForChunk(...bc).length >= 3);
});

test('parseSeed handles numbers and text deterministically', () => {
  assert.equal(parseSeed('12345'), 12345);
  assert.equal(parseSeed('gigatron'), hashString('gigatron'));
  assert.equal(parseSeed('gigatron'), parseSeed('gigatron'));
  assert.notEqual(parseSeed('a'), parseSeed('b'));
});
