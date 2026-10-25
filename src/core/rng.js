// Deterministic hashing and PRNG helpers.

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Accepts a number or any text; integers are used directly, text is hashed.
export function parseSeed(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.floor(Math.abs(input)) >>> 0;
  const text = String(input ?? '').trim();
  if (/^\d{1,10}$/.test(text)) return Number(text) >>> 0;
  if (text === '') return 0;
  return hashString(text);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Uniform [0, 1) hash of an integer lattice point.
export function hash2(seed, x, z) {
  return mix((seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1)) | 0) / 4294967296;
}

export function hash3(seed, x, y, z) {
  return mix((seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x9e3779b1) ^ Math.imul(z | 0, 0x165667b1)) | 0) / 4294967296;
}
