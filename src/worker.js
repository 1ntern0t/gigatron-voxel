// Chunk worker: terrain generation and meshing off the main thread.
import { createWorldGen } from './core/worldgen.js';
import { meshVolume } from './core/mesher.js';

let gen = null;
let genSeed = null;

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'gen') {
      if (genSeed !== msg.seed) {
        gen = createWorldGen(msg.seed);
        genSeed = msg.seed;
      }
      const { data } = gen.generateChunk(msg.cx, msg.cz);
      self.postMessage({ type: 'gen', job: msg.job, cx: msg.cx, cz: msg.cz, data }, [data.buffer]);
    } else if (msg.type === 'mesh') {
      const m = meshVolume(msg.vol);
      const transfer = [];
      for (const part of [m.opaque, m.translucent]) transfer.push(part.positions.buffer, part.uvs.buffer, part.lights.buffer, part.indices.buffer);
      self.postMessage({ type: 'mesh', job: msg.job, cx: msg.cx, cz: msg.cz, version: msg.version, mesh: m, vol: msg.vol }, [...transfer, msg.vol.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', job: msg.job, message: String(err && err.message || err) });
  }
};
