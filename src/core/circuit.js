// Energy grid simulation. Discrete ticks; deterministic; operates through a getBlock callback.
//
// Rules (per tick, computed from the current block states):
// - Sources: Power Node, Switch (on), Inverter Gate currently outputting.
// - Wires conduct in all six directions; sources energise adjacent wires
//   (an Inverter never outputs downward, because below is its input).
// - Lamps light / doors open when an adjacent wire or source is live.
// - An Inverter outputs next tick if and only if the cell directly below it is NOT live.
import { B } from './blocks.js';

const CIRCUIT_IDS = new Set([
  B.WIRE, B.WIRE_ON, B.NODE, B.SWITCH_OFF, B.SWITCH_ON,
  B.LAMP_OFF, B.LAMP_ON, B.DOOR, B.DOOR_OPEN, B.NOT, B.NOT_ON,
]);
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export function isCircuitBlock(id) {
  return CIRCUIT_IDS.has(id);
}

function isSource(id) {
  return id === B.NODE || id === B.SWITCH_ON || id === B.NOT_ON;
}

function isWire(id) {
  return id === B.WIRE || id === B.WIRE_ON;
}

const key = (x, y, z) => x + ',' + y + ',' + z;

export class CircuitSim {
  constructor() {
    this.nodes = new Map();
  }

  // Call whenever any block changes; non-circuit ids untrack the position.
  track(x, y, z, id) {
    const k = key(x, y, z);
    if (isCircuitBlock(id)) this.nodes.set(k, [x, y, z]);
    else this.nodes.delete(k);
  }

  get size() {
    return this.nodes.size;
  }

  clear() {
    this.nodes.clear();
  }

  // True when any tracked lamp is currently lit. Used to credit the "First Light" quest
  // for lamps that were already lit before that quest became active.
  hasLitLamp(getBlock) {
    for (const p of this.nodes.values()) if (getBlock(p[0], p[1], p[2]) === B.LAMP_ON) return true;
    return false;
  }

  // getBlock returns an id, or null when the position is not loaded (skipped this tick).
  step(getBlock) {
    const cells = new Map();
    for (const [k, p] of this.nodes) {
      const id = getBlock(p[0], p[1], p[2]);
      if (id === null || id === undefined) continue;
      if (!isCircuitBlock(id)) {
        this.nodes.delete(k);
        continue;
      }
      cells.set(k, { x: p[0], y: p[1], z: p[2], id });
    }

    const live = new Set();
    const queue = [];
    for (const [k, c] of cells) {
      if (isSource(c.id)) {
        live.add(k);
        queue.push(c);
      }
    }
    while (queue.length) {
      const c = queue.pop();
      for (let d = 0; d < 6; d++) {
        if (c.id === B.NOT_ON && d === 3) continue;
        const nk = key(c.x + DIRS[d][0], c.y + DIRS[d][1], c.z + DIRS[d][2]);
        if (live.has(nk)) continue;
        const n = cells.get(nk);
        if (n && isWire(n.id)) {
          live.add(nk);
          queue.push(n);
        }
      }
    }

    const fedBy = (c) => {
      for (let d = 0; d < 6; d++) {
        const nk = key(c.x + DIRS[d][0], c.y + DIRS[d][1], c.z + DIRS[d][2]);
        if (!live.has(nk)) continue;
        const n = cells.get(nk);
        // An inverter above this cell does not feed downward.
        if (n.id === B.NOT_ON && d === 2) continue;
        return true;
      }
      return false;
    };

    const changes = [];
    for (const [k, c] of cells) {
      let want = c.id;
      switch (c.id) {
        case B.WIRE:
        case B.WIRE_ON:
          want = live.has(k) ? B.WIRE_ON : B.WIRE;
          break;
        case B.LAMP_OFF:
        case B.LAMP_ON:
          want = fedBy(c) ? B.LAMP_ON : B.LAMP_OFF;
          break;
        case B.DOOR:
        case B.DOOR_OPEN:
          want = fedBy(c) ? B.DOOR_OPEN : B.DOOR;
          break;
        case B.NOT:
        case B.NOT_ON:
          want = live.has(key(c.x, c.y - 1, c.z)) ? B.NOT : B.NOT_ON;
          break;
        default:
          break;
      }
      if (want !== c.id) changes.push({ x: c.x, y: c.y, z: c.z, id: want, from: c.id });
    }
    return changes;
  }
}

export function toggleSwitch(id) {
  if (id === B.SWITCH_OFF) return B.SWITCH_ON;
  if (id === B.SWITCH_ON) return B.SWITCH_OFF;
  return id;
}
