// The sky-light seeding in computeLight skips cells that cannot spread light.
// These tests check it against the original "seed every sky cell" version, byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLight, buildPaddedVolume, createPaddedVolume, PADDED_VOLUME, PX } from '../src/core/mesher.js';
import { B, OPAQUE, EMIT } from '../src/core/blocks.js';
import { HEIGHT } from '../src/core/constants.js';
import { createWorldGen } from '../src/core/worldgen.js';
import { mulberry32 } from '../src/core/rng.js';

const SX = HEIGHT;
const SZ = HEIGHT * PX;

// Reference: the pre-optimisation algorithm (plain BFS seeded from every sky cell).
function referenceLight(vol) {
  const sky = new Uint8Array(PADDED_VOLUME);
  const blk = new Uint8Array(PADDED_VOLUME);
  const flood = (light, seeds) => {
    const queue = seeds;
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const level = light[i];
      if (level <= 1) continue;
      const y = i % HEIGHT;
      const col = (i - y) / HEIGHT;
      const px = col % PX;
      const pz = (col - px) / PX;
      const nb = [];
      if (px > 0) nb.push(i - SX);
      if (px < PX - 1) nb.push(i + SX);
      if (pz > 0) nb.push(i - SZ);
      if (pz < PX - 1) nb.push(i + SZ);
      if (y > 0) nb.push(i - 1);
      if (y < HEIGHT - 1) nb.push(i + 1);
      for (const n of nb) {
        if (light[n] >= level - 1 || OPAQUE[vol[n]]) continue;
        light[n] = level - 1;
        queue.push(n);
      }
    }
  };
  const skySeeds = [];
  for (let col = 0; col < PX * PX; col++) {
    for (let y = HEIGHT - 1; y >= 0; y--) {
      const i = col * HEIGHT + y;
      if (OPAQUE[vol[i]]) break;
      sky[i] = 15;
      skySeeds.push(i);
    }
  }
  flood(sky, skySeeds);
  const blkSeeds = [];
  for (let i = 0; i < PADDED_VOLUME; i++) {
    if (EMIT[vol[i]] > 0) {
      blk[i] = EMIT[vol[i]];
      blkSeeds.push(i);
    }
  }
  flood(blk, blkSeeds);
  return { sky, blk };
}

function assertSame(vol, label) {
  const a = computeLight(vol);
  const b = referenceLight(vol);
  assert.ok(Buffer.from(a.sky).equals(Buffer.from(b.sky)), label + ': sky light differs');
  assert.ok(Buffer.from(a.blk).equals(Buffer.from(b.blk)), label + ': block light differs');
}

test('optimised sky light matches the reference on generated terrain (3 seeds)', () => {
  for (const seed of [1, 1234, 'gigatron']) {
    const gen = createWorldGen(typeof seed === 'number' ? seed : 987654);
    const data = new Map();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) data.set(x + ',' + z, gen.generateChunk(x, z).data);
    const get = (x, z) => data.get(x + ',' + z) || null;
    for (const [cx, cz] of [[0, 0], [1, -1], [-1, 1], [2, 2]]) assertSame(buildPaddedVolume(cx, cz, get), `seed ${seed} chunk ${cx},${cz}`);
  }
});

test('optimised sky light matches the reference on random caves, overhangs and emitters', () => {
  const rnd = mulberry32(42);
  for (let k = 0; k < 6; k++) {
    const v = createPaddedVolume();
    for (let i = 0; i < PADDED_VOLUME; i++) {
      const r = rnd();
      v[i] = r < 0.35 ? B.STONE : r < 0.352 ? B.CRYSTAL : B.AIR;
    }
    assertSame(v, 'random volume ' + k);
  }
});
