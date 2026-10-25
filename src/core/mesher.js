// Culled-face mesher with smooth sky/block lighting and ambient occlusion.
// Input is a padded volume: the chunk plus PAD blocks of neighbour data on each side,
// so lighting and face culling are seamless across chunk borders.
import { CHUNK, HEIGHT } from './constants.js';
import { B, OPAQUE, EMIT, TRANSLUCENT, TILE_TOP, TILE_SIDE, TILE_BOTTOM, ATLAS_GRID } from './blocks.js';

export const PAD = 8;
export const PX = CHUNK + PAD * 2;
export const PADDED_VOLUME = PX * PX * HEIGHT;
const SX = HEIGHT; // x stride
const SZ = HEIGHT * PX; // z stride

export function volIndex(px, y, pz) {
  return y + HEIGHT * (px + PX * pz);
}

export function createPaddedVolume() {
  return new Uint8Array(PADDED_VOLUME);
}

// Flood-fill sky light (15 from open sky) and block light (from emitters) through non-opaque cells.
export function computeLight(vol) {
  const sky = new Uint8Array(PADDED_VOLUME);
  const blk = new Uint8Array(PADDED_VOLUME);
  let queue = new Int32Array(1 << 16);
  let head = 0;
  let tail = 0;
  const push = (i) => {
    if (tail >= queue.length) {
      if (head > 0) {
        queue.copyWithin(0, head, tail);
        tail -= head;
        head = 0;
      }
      if (tail >= queue.length) {
        const next = new Int32Array(queue.length * 2);
        next.set(queue);
        queue = next;
      }
    }
    queue[tail++] = i;
  };

  const flood = (light) => {
    while (head < tail) {
      const i = queue[head++];
      const level = light[i];
      if (level <= 1) continue;
      const next = level - 1;
      const y = i % HEIGHT;
      const col = (i - y) / HEIGHT;
      const px = col % PX;
      const pz = (col - px) / PX;
      if (px > 0) visit(i - SX, next, light);
      if (px < PX - 1) visit(i + SX, next, light);
      if (pz > 0) visit(i - SZ, next, light);
      if (pz < PX - 1) visit(i + SZ, next, light);
      if (y > 0) visit(i - 1, next, light);
      if (y < HEIGHT - 1) visit(i + 1, next, light);
    }
    head = 0;
    tail = 0;
  };
  const visit = (n, level, light) => {
    if (light[n] >= level || OPAQUE[vol[n]]) return;
    light[n] = level;
    push(n);
  };

  for (let col = 0; col < PX * PX; col++) {
    const base = col * HEIGHT;
    for (let y = HEIGHT - 1; y >= 0; y--) {
      const i = base + y;
      if (OPAQUE[vol[i]]) break;
      sky[i] = 15;
      push(i);
    }
  }
  flood(sky);

  for (let i = 0; i < PADDED_VOLUME; i++) {
    const e = EMIT[vol[i]];
    if (e > 0) {
      blk[i] = e;
      push(i);
    }
  }
  flood(blk);
  return { sky, blk };
}

// Face table: normal, u axis, v axis, origin corner. u x v = normal (CCW from outside).
const FACES = [
  { n: [1, 0, 0], o: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], tile: 1 },
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0], tile: 1 },
  { n: [0, 1, 0], o: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], tile: 0 },
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], tile: 2 },
  { n: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], tile: 1 },
  { n: [0, 0, -1], o: [0, 0, 0], u: [0, 1, 0], v: [1, 0, 0], tile: 1 },
];
const FACE_SHADE = [0.82, 0.82, 1.0, 0.55, 0.7, 0.7];
const AO_CURVE = [0.45, 0.65, 0.82, 1.0];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function createBuffers() {
  return { positions: [], uvs: [], lights: [], indices: [], quads: 0 };
}

function finish(buf) {
  return {
    positions: new Float32Array(buf.positions),
    uvs: new Float32Array(buf.uvs),
    lights: new Float32Array(buf.lights),
    indices: new Uint32Array(buf.indices),
    quads: buf.quads,
  };
}

export function meshVolume(vol, light = computeLight(vol)) {
  const { sky, blk } = light;
  const opaque = createBuffers();
  const translucent = createBuffers();
  const tileSize = 1 / ATLAS_GRID;
  const inset = 0.5 / (ATLAS_GRID * 16);

  const cellAt = (px, y, pz) => {
    if (y >= HEIGHT) return B.AIR;
    if (y < 0) return B.BEDROCK;
    return vol[y + SX * px + SZ * pz];
  };
  const occludes = (px, y, pz) => OPAQUE[cellAt(px, y, pz)] === 1;
  const lightAt = (px, y, pz, out) => {
    if (y >= HEIGHT) {
      out[0] = 15;
      out[1] = 0;
      return true;
    }
    if (y < 0) return false;
    const i = y + SX * px + SZ * pz;
    if (OPAQUE[vol[i]]) return false;
    out[0] = sky[i];
    out[1] = blk[i];
    return true;
  };
  const tmp = [0, 0];
  const ao = [0, 0, 0, 0];
  const ls = [0, 0, 0, 0];
  const lb = [0, 0, 0, 0];

  for (let pz = PAD; pz < PAD + CHUNK; pz++) {
    for (let px = PAD; px < PAD + CHUNK; px++) {
      const colBase = SX * px + SZ * pz;
      for (let y = 0; y < HEIGHT; y++) {
        const id = vol[colBase + y];
        if (id === B.AIR) continue;
        const isOpaque = OPAQUE[id] === 1;
        const buf = isOpaque ? opaque : translucent;
        const emissive = EMIT[id] > 0 ? 1 : 0;
        const fluid = id === B.FLUID;
        const fluidTop = fluid && cellAt(px, y + 1, pz) !== B.FLUID;
        for (let f = 0; f < 6; f++) {
          const F = FACES[f];
          const nx = px + F.n[0];
          const ny = y + F.n[1];
          const nz = pz + F.n[2];
          const nid = cellAt(nx, ny, nz);
          if (OPAQUE[nid]) continue;
          if (!isOpaque && nid === id) continue;
          if (fluid && f === 3 && ny < 0) continue;
          const tile = F.tile === 0 ? TILE_TOP[id] : F.tile === 1 ? TILE_SIDE[id] : TILE_BOTTOM[id];
          const tu = (tile % ATLAS_GRID) * tileSize;
          const tv = 1 - (Math.floor(tile / ATLAS_GRID) + 1) * tileSize;
          // Lighting + AO samples for each corner.
          let faceSky = 0;
          let faceBlk = 0;
          if (lightAt(nx, ny, nz, tmp)) {
            faceSky = tmp[0];
            faceBlk = tmp[1];
          }
          for (let c = 0; c < 4; c++) {
            const su = CORNERS[c][0] ? 1 : -1;
            const sv = CORNERS[c][1] ? 1 : -1;
            const ax = F.u[0] * su;
            const ay = F.u[1] * su;
            const az = F.u[2] * su;
            const bx = F.v[0] * sv;
            const by = F.v[1] * sv;
            const bz = F.v[2] * sv;
            const s1 = occludes(nx + ax, ny + ay, nz + az);
            const s2 = occludes(nx + bx, ny + by, nz + bz);
            const cc = occludes(nx + ax + bx, ny + ay + by, nz + az + bz);
            ao[c] = s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (cc ? 1 : 0));
            let sumS = faceSky;
            let sumB = faceBlk;
            let n = 1;
            if (!s1 && lightAt(nx + ax, ny + ay, nz + az, tmp)) { sumS += tmp[0]; sumB += tmp[1]; n++; }
            if (!s2 && lightAt(nx + bx, ny + by, nz + bz, tmp)) { sumS += tmp[0]; sumB += tmp[1]; n++; }
            if (!(s1 && s2) && !cc && lightAt(nx + ax + bx, ny + ay + by, nz + az + bz, tmp)) { sumS += tmp[0]; sumB += tmp[1]; n++; }
            ls[c] = sumS / n / 15;
            lb[c] = sumB / n / 15;
          }
          const vbase = buf.quads * 4;
          for (let c = 0; c < 4; c++) {
            const cu = CORNERS[c][0];
            const cv = CORNERS[c][1];
            const lx = px - PAD + F.o[0] + F.u[0] * cu + F.v[0] * cv;
            let ly = y + F.o[1] + F.u[1] * cu + F.v[1] * cv;
            const lz = pz - PAD + F.o[2] + F.u[2] * cu + F.v[2] * cv;
            if (fluidTop && ly === y + 1) ly -= 0.12;
            buf.positions.push(lx, ly, lz);
            // Texture coordinates: sides use (horizontal, y); top/bottom use (x, z).
            let tx;
            let ty;
            if (f === 2 || f === 3) {
              tx = lx - (px - PAD);
              ty = lz - (pz - PAD);
            } else {
              tx = f < 2 ? lz - (pz - PAD) : lx - (px - PAD);
              ty = Math.min(1, Math.max(0, ly - y));
            }
            buf.uvs.push(tu + inset + tx * (tileSize - 2 * inset), tv + inset + ty * (tileSize - 2 * inset));
            const shade = emissive ? 1 : FACE_SHADE[f] * AO_CURVE[ao[c]];
            buf.lights.push(shade, ls[c], emissive ? 1 : lb[c], emissive);
          }
          if (ao[0] + ao[2] < ao[1] + ao[3]) {
            buf.indices.push(vbase + 1, vbase + 2, vbase + 3, vbase + 1, vbase + 3, vbase);
          } else {
            buf.indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
          }
          buf.quads++;
        }
      }
    }
  }
  return { opaque: finish(opaque), translucent: finish(translucent) };
}

// Build the padded volume from a chunk lookup: getChunkData(cx, cz) -> Uint8Array | null.
export function buildPaddedVolume(cx, cz, getChunkData, out = createPaddedVolume()) {
  out.fill(0);
  for (let pz = 0; pz < PX; pz++) {
    const wz = cz * CHUNK - PAD + pz;
    const ncz = Math.floor(wz / CHUNK);
    const lz = wz - ncz * CHUNK;
    for (let px = 0; px < PX; px++) {
      const wx = cx * CHUNK - PAD + px;
      const ncx = Math.floor(wx / CHUNK);
      const lx = wx - ncx * CHUNK;
      const data = getChunkData(ncx, ncz);
      if (!data) continue;
      const src = HEIGHT * (lx + CHUNK * lz);
      out.set(data.subarray(src, src + HEIGHT), HEIGHT * (px + PX * pz));
    }
  }
  return out;
}

export { TRANSLUCENT };
