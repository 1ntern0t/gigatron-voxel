import test from 'node:test';
import assert from 'node:assert/strict';
import { meshVolume, createPaddedVolume, volIndex, PAD, PX, computeLight, buildPaddedVolume } from '../src/core/mesher.js';
import { B } from '../src/core/blocks.js';
import { CHUNK, HEIGHT, CHUNK_VOLUME, localIndex } from '../src/core/constants.js';
import { createWorldGen } from '../src/core/worldgen.js';

function vol(cells) {
  const v = createPaddedVolume();
  for (const [x, y, z, id] of cells) v[volIndex(x + PAD, y, z + PAD)] = id;
  return v;
}

test('a single block emits 6 faces (24 vertices, 36 indices)', () => {
  const m = meshVolume(vol([[5, 40, 5, B.STONE]]));
  assert.equal(m.opaque.quads, 6);
  assert.equal(m.opaque.positions.length, 24 * 3);
  assert.equal(m.opaque.uvs.length, 24 * 2);
  assert.equal(m.opaque.lights.length, 24 * 4);
  assert.equal(m.opaque.indices.length, 36);
  assert.equal(m.translucent.quads, 0);
});

test('shared faces between adjacent opaque blocks are culled', () => {
  const m = meshVolume(vol([[5, 40, 5, B.STONE], [6, 40, 5, B.STONE]]));
  assert.equal(m.opaque.quads, 10);
});

test('a solid 2x2x2 cube emits only its 24 outer faces', () => {
  const cells = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) cells.push([4 + x, 30 + y, 4 + z, B.CHROME]);
  assert.equal(meshVolume(vol(cells)).opaque.quads, 24);
});

test('translucent blocks go to the translucent mesh and cull against their own kind', () => {
  const m = meshVolume(vol([[3, 20, 3, B.GLASS], [4, 20, 3, B.GLASS]]));
  assert.equal(m.opaque.quads, 0);
  assert.equal(m.translucent.quads, 10);
});

test('faces against padding neighbours are culled across chunk borders', () => {
  const v = vol([[0, 40, 0, B.STONE]]);
  v[volIndex(PAD - 1, 40, PAD)] = B.STONE; // neighbour chunk to the west
  const m = meshVolume(v);
  assert.equal(m.opaque.quads, 5);
});

test('blocks outside the inner chunk region are not meshed', () => {
  const v = createPaddedVolume();
  v[volIndex(0, 40, 0)] = B.STONE;
  v[volIndex(PX - 1, 40, PX - 1)] = B.STONE;
  assert.equal(meshVolume(v).opaque.quads, 0);
});

test('vertex positions stay within chunk-local bounds', () => {
  const m = meshVolume(vol([[0, 0, 0, B.STONE], [15, HEIGHT - 1, 15, B.STONE]]));
  const p = m.opaque.positions;
  for (let i = 0; i < p.length; i += 3) {
    assert.ok(p[i] >= 0 && p[i] <= CHUNK);
    assert.ok(p[i + 1] >= 0 && p[i + 1] <= HEIGHT);
    assert.ok(p[i + 2] >= 0 && p[i + 2] <= CHUNK);
  }
  // Bottom face at y=0 is skipped (bedrock below the world) so 5 + 6 faces.
  assert.equal(m.opaque.quads, 11);
});

test('sky light fills open air and is blocked under a roof; emitters light their surroundings', () => {
  const cells = [];
  for (let x = 0; x < CHUNK; x++) for (let z = 0; z < CHUNK; z++) cells.push([x, 50, z, B.STONE]);
  cells.push([8, 45, 8, B.LAMP_ON]);
  const v = vol(cells);
  const { sky, blk } = computeLight(v);
  assert.equal(sky[volIndex(PAD + 8, 60, PAD + 8)], 15);
  assert.ok(sky[volIndex(PAD + 8, 40, PAD + 8)] < 15);
  assert.equal(blk[volIndex(PAD + 8, 45, PAD + 8)], 15);
  assert.equal(blk[volIndex(PAD + 9, 45, PAD + 8)], 14);
  assert.equal(blk[volIndex(PAD + 8, 45, PAD + 12)], 11);
});

test('buildPaddedVolume copies neighbour columns into the right place', () => {
  const g = createWorldGen(77);
  const chunks = new Map();
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) chunks.set(cx + ',' + cz, g.generateChunk(cx, cz).data);
  const v = buildPaddedVolume(0, 0, (cx, cz) => chunks.get(cx + ',' + cz) ?? null);
  const west = chunks.get('-1,0');
  for (let y = 0; y < HEIGHT; y++) assert.equal(v[volIndex(PAD - 1, y, PAD)], west[localIndex(CHUNK - 1, y, 0)]);
  const self = chunks.get('0,0');
  for (let y = 0; y < HEIGHT; y++) assert.equal(v[volIndex(PAD + 3, y, PAD + 4)], self[localIndex(3, y, 4)]);
  const m = meshVolume(v);
  assert.ok(m.opaque.quads > 200, 'real terrain should produce a surface');
  assert.equal(m.opaque.indices.length, m.opaque.quads * 6);
  assert.equal(CHUNK_VOLUME, self.length);
});
