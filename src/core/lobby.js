// Assembles the public lobby: authoritative host + persistent world + the three server bots.
// Pure (no Node or DOM APIs); tools/lobby-host.mjs adds transports, persistence and logging.
import { Authority } from './authority.js';
import { VoxelStore } from './voxelstore.js';
import { parseSeed, mulberry32 } from './rng.js';
import { isCircuitBlock } from './circuit.js';
import { Warden } from './bots/warden.js';
import { Spark } from './bots/spark.js';
import { Hive } from './bots/hive.js';
import { LOBBY_CAP, LOBBY_SEED_TEXT } from './lobby-config.js';

export const BOT_IDS = ['bot-warden', 'bot-spark', 'bot-hive'];

export function createLobby({
  seedText = LOBBY_SEED_TEXT, cap = LOBBY_CAP, now = () => Date.now(), send, close, log = () => {}, incident = () => {},
  edits = null, rng = null, wardenRules = {}, hiveOptions = {}, sparkOptions = {}, store = null, scorebook = null,
} = {}) {
  const seed = parseSeed(seedText);
  const world = store || new VoxelStore(seed);
  if (edits) world.loadFlatEdits(edits);
  const s = world.gen.findSpawn();
  const spawn = { x: s.x, y: s.y, z: s.z };
  const center = { x: Math.floor(s.x), z: Math.floor(s.z) };
  const beacon = world.gen.beacon;
  const protect = [
    { x: center.x + 0.5, z: center.z + 0.5, r: 12, label: 'spawn plaza' },
    { x: beacon.x + 0.5, z: beacon.z + 0.5, r: 10, label: 'Gigatron Beacon' },
  ];
  const authority = new Authority({
    world, seed, now, send, close, log, spawn, protect, cap, mode: 'survival', circuits: true, lobby: true, scorebook,
    name: 'GIGATRON Public Lobby', motd: 'Public lobby: be kind. WARDEN, SPARK and HIVE are server bots.',
  });
  if (edits) {
    const pos = [];
    for (let i = 0; i + 3 < edits.length; i += 4) if (isCircuitBlock(edits[i + 3])) pos.push([edits[i], edits[i + 1], edits[i + 2]]);
    authority.trackCircuitsFromWorld(pos);
  }
  const random = rng || mulberry32(seed ^ 0x51ab);
  const warden = authority.use(new Warden({ rules: wardenRules, center, store: world, log: incident }));
  const spark = authority.use(new Spark({ store: world, center, ...sparkOptions }));
  const hive = authority.use(new Hive({ store: world, center, rng: random, ...hiveOptions }));
  return { authority, world, warden, spark, hive, spawn, center, protect, seed, scorebook };
}
