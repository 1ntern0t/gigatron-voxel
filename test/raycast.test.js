import test from 'node:test';
import assert from 'node:assert/strict';
import { raycastVoxels } from '../src/core/raycast.js';

const solid = (cells) => {
  const set = new Set(cells.map((c) => c.join(',')));
  return (x, y, z) => (set.has(x + ',' + y + ',' + z) ? 1 : 0);
};
const pick = (id) => id !== 0;

test('a ray straight down from an exact integer position hits the block below', () => {
  // Before the fix, 0 * Infinity produced NaN and the ray returned null.
  const hit = raycastVoxels(solid([[3, 2, 5]]), { x: 3, y: 6, z: 5 }, { x: 0, y: -1, z: 0 }, 8, pick);
  assert.deepEqual(hit, { x: 3, y: 2, z: 5, nx: 0, ny: 1, nz: 0, id: 1 });
});

test('axis-aligned rays work along each axis and in both directions', () => {
  const get = solid([[5, 0, 0], [-5, 0, 0], [0, 0, 5], [0, 0, -5], [0, 5, 0]]);
  const o = { x: 0.5, y: 0.5, z: 0.5 };
  assert.equal(raycastVoxels(get, o, { x: 1, y: 0, z: 0 }, 8, pick).x, 5);
  assert.equal(raycastVoxels(get, o, { x: -1, y: 0, z: 0 }, 8, pick).x, -5);
  assert.equal(raycastVoxels(get, o, { x: 0, y: 0, z: 1 }, 8, pick).z, 5);
  assert.equal(raycastVoxels(get, o, { x: 0, y: 0, z: -1 }, 8, pick).z, -5);
  assert.equal(raycastVoxels(get, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 8, pick).y, 5);
});

test('diagonal ray reports the entry face normal, and maxDist is respected', () => {
  const d = Math.SQRT1_2;
  const hit = raycastVoxels(solid([[3, 0, 3]]), { x: 0.5, y: 0.5, z: 0.2 }, { x: d, y: 0, z: d }, 8, pick);
  assert.equal(hit.x, 3);
  assert.equal(hit.z, 3);
  assert.equal(hit.nx + hit.nz, -1);
  assert.equal(raycastVoxels(solid([[20, 0, 0]]), { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 8, pick), null);
});
