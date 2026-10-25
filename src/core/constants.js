// Shared world constants. Pure module: safe to import from Node, workers and the browser.
export const CHUNK = 16;
export const HEIGHT = 96;
export const SEA = 28;
export const CHUNK_VOLUME = CHUNK * CHUNK * HEIGHT;

export function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

export function parseChunkKey(key) {
  const [a, b] = key.split(',');
  return [Number(a), Number(b)];
}

// Column-major layout: y is contiguous so whole columns can be copied with one set().
export function localIndex(lx, y, lz) {
  return y + HEIGHT * (lx + CHUNK * lz);
}

export function fromLocalIndex(idx) {
  const y = idx % HEIGHT;
  const col = (idx - y) / HEIGHT;
  const lx = col % CHUNK;
  const lz = (col - lx) / CHUNK;
  return [lx, y, lz];
}

export function worldToChunk(x, z) {
  return [Math.floor(x / CHUNK), Math.floor(z / CHUNK)];
}
