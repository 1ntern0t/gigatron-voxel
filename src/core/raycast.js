// Voxel DDA raycast (Amanatides & Woo). Pure: reads blocks through getBlock(x, y, z).
// Returns { x, y, z, nx, ny, nz, id } for the first cell where pick(id) is true, or null.
export function raycastVoxels(getBlock, origin, dir, maxDist, pick) {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);
  const stepX = dir.x > 0 ? 1 : -1;
  const stepY = dir.y > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;
  // An axis the ray does not move along is never crossed. Using Infinity here (instead of
  // 1 / 0 multiplied by a 0 offset, which is NaN) keeps axis-aligned rays working.
  const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
  let tMaxX = dir.x !== 0 ? (dir.x > 0 ? x + 1 - origin.x : origin.x - x) * tDeltaX : Infinity;
  let tMaxY = dir.y !== 0 ? (dir.y > 0 ? y + 1 - origin.y : origin.y - y) * tDeltaY : Infinity;
  let tMaxZ = dir.z !== 0 ? (dir.z > 0 ? z + 1 - origin.z : origin.z - z) * tDeltaZ : Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  while (t <= maxDist) {
    const id = getBlock(x, y, z);
    if (pick(id)) return { x, y, z, nx, ny, nz, id };
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return null;
}
