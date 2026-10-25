// Block registry. Every texture is generated procedurally at runtime (see client/atlas.js).

export const B = Object.freeze({
  AIR: 0,
  BEDROCK: 1,
  STONE: 2,
  SOIL: 3,
  TURF: 4,
  CIRCUIT: 5,
  CRYSTAL: 6,
  FLUID: 7,
  SAND: 8,
  CHROME: 9,
  ALLOY: 10,
  CORE: 11,
  GLASS: 12,
  MOSS: 13,
  AETHER: 14,
  WIRE: 15,
  WIRE_ON: 16,
  NODE: 17,
  SWITCH_OFF: 18,
  SWITCH_ON: 19,
  LAMP_OFF: 20,
  LAMP_ON: 21,
  DOOR: 22,
  DOOR_OPEN: 23,
  NOT: 24,
  NOT_ON: 25,
  HUB: 26,
  FIBER: 27,
  LEAF: 28,
  BEACON: 29,
});

// Items that are not blocks.
export const ITEM_DRONE_POD = 100;

// Atlas tile order (8x8 grid of 16px tiles). Names are painted by client/atlas.js.
export const TILE_NAMES = [
  'bedrock', 'stone', 'soil', 'turf_top', 'turf_side', 'circuit', 'crystal', 'fluid',
  'sand', 'chrome', 'alloy', 'core', 'glass', 'moss_top', 'moss_side', 'aether',
  'wire', 'wire_on', 'node', 'switch_off', 'switch_on', 'lamp_off', 'lamp_on', 'door',
  'door_open', 'not', 'not_on', 'hub_side', 'hub_top', 'fiber_side', 'fiber_top', 'leaf',
  'beacon', 'drone_pod',
];
export const TILE = Object.freeze(Object.fromEntries(TILE_NAMES.map((n, i) => [n, i])));
export const ATLAS_GRID = 8;

function def(id, name, opts) {
  const tile = opts.tile ?? 'stone';
  return {
    id,
    name,
    solid: opts.solid ?? true,
    opaque: opts.opaque ?? true,
    translucent: opts.translucent ?? false,
    emit: opts.emit ?? 0,
    breakable: opts.breakable ?? true,
    drop: opts.drop ?? id,
    tiles: [TILE[opts.top ?? tile], TILE[opts.side ?? tile], TILE[opts.bottom ?? opts.top ?? tile]],
    desc: opts.desc ?? '',
  };
}

export const BLOCKS = [
  def(B.AIR, 'Air', { solid: false, opaque: false, breakable: false }),
  def(B.BEDROCK, 'Null Bedrock', { tile: 'bedrock', breakable: false }),
  def(B.STONE, 'Basalt Matrix', { tile: 'stone' }),
  def(B.SOIL, 'Carbon Soil', { tile: 'soil' }),
  def(B.TURF, 'Neon Turf', { top: 'turf_top', side: 'turf_side', bottom: 'soil', drop: B.SOIL }),
  def(B.CIRCUIT, 'Circuit Rock', { tile: 'circuit' }),
  def(B.CRYSTAL, 'Neon Crystal', { tile: 'crystal', emit: 12, desc: 'Glowing shard. Drones love it.' }),
  def(B.FLUID, 'Data Stream', { tile: 'fluid', solid: false, opaque: false, translucent: true, emit: 5, breakable: false }),
  def(B.SAND, 'Silicon Sand', { tile: 'sand' }),
  def(B.CHROME, 'Chrome Plate', { tile: 'chrome' }),
  def(B.ALLOY, 'Black Alloy', { tile: 'alloy' }),
  def(B.CORE, 'Gigatron Core', { tile: 'core', emit: 15, breakable: false }),
  def(B.GLASS, 'Holo Glass', { tile: 'glass', opaque: false, translucent: true }),
  def(B.MOSS, 'Sky Moss', { top: 'moss_top', side: 'moss_side', bottom: 'aether' }),
  def(B.AETHER, 'Aether Rock', { tile: 'aether' }),
  def(B.WIRE, 'Power Wire', { tile: 'wire', desc: 'Carries energy to neighbours.' }),
  def(B.WIRE_ON, 'Power Wire (live)', { tile: 'wire_on', emit: 4, drop: B.WIRE }),
  def(B.NODE, 'Power Node', { tile: 'node', emit: 8, desc: 'Always-on energy source.' }),
  def(B.SWITCH_OFF, 'Switch', { tile: 'switch_off', desc: 'Right-click / E to toggle. On = energy source.' }),
  def(B.SWITCH_ON, 'Switch (on)', { tile: 'switch_on', emit: 6, drop: B.SWITCH_OFF }),
  def(B.LAMP_OFF, 'Lumen Lamp', { tile: 'lamp_off', desc: 'Lights up when touching live energy.' }),
  def(B.LAMP_ON, 'Lumen Lamp (lit)', { tile: 'lamp_on', emit: 15, drop: B.LAMP_OFF }),
  def(B.DOOR, 'Energy Door', { tile: 'door', desc: 'Opens (becomes passable) while powered.' }),
  def(B.DOOR_OPEN, 'Energy Door (open)', { tile: 'door_open', solid: false, opaque: false, translucent: true, drop: B.DOOR }),
  def(B.NOT, 'Inverter Gate', { tile: 'not', desc: 'Outputs energy (sides/top) unless the block below is live.' }),
  def(B.NOT_ON, 'Inverter Gate (out)', { tile: 'not_on', emit: 5, drop: B.NOT }),
  def(B.HUB, 'Swarm Hub', { top: 'hub_top', side: 'hub_side', emit: 7, desc: 'Drones assigned here harvest crystals. Hubs link into chains.' }),
  def(B.FIBER, 'Fiber Trunk', { top: 'fiber_top', side: 'fiber_side' }),
  def(B.LEAF, 'Holo Foliage', { tile: 'leaf', emit: 2 }),
  def(B.BEACON, 'Beacon Lens', { tile: 'beacon', emit: 15, breakable: false }),
];

export const BLOCK_COUNT = BLOCKS.length;

export const SOLID = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256);
export const TRANSLUCENT = new Uint8Array(256);
export const EMIT = new Uint8Array(256);
export const TILE_TOP = new Uint8Array(256);
export const TILE_SIDE = new Uint8Array(256);
export const TILE_BOTTOM = new Uint8Array(256);
for (const b of BLOCKS) {
  SOLID[b.id] = b.solid ? 1 : 0;
  OPAQUE[b.id] = b.opaque ? 1 : 0;
  TRANSLUCENT[b.id] = b.translucent ? 1 : 0;
  EMIT[b.id] = b.emit;
  TILE_TOP[b.id] = b.tiles[0];
  TILE_SIDE[b.id] = b.tiles[1];
  TILE_BOTTOM[b.id] = b.tiles[2];
}

export function isValidBlockId(id) {
  return Number.isInteger(id) && id >= 0 && id < BLOCK_COUNT;
}

export function isValidItemId(id) {
  return (isValidBlockId(id) && id !== B.AIR) || id === ITEM_DRONE_POD;
}

export function itemName(id) {
  if (id === ITEM_DRONE_POD) return 'Drone Pod';
  return BLOCKS[id]?.name ?? 'Unknown';
}

export function itemTile(id) {
  if (id === ITEM_DRONE_POD) return TILE.drone_pod;
  return BLOCKS[id]?.tiles[1] ?? 0;
}
