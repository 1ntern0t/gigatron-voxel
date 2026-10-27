// SPARK [BOT]: builder/lighter. Builds and maintains the lit spawn plaza (chrome floor, four lamp
// posts powered by Power Nodes, and four lamp paths wired to a central switch it pulses), so new
// players always see something alive. It walks like a player and edits through the same rate limit
// and reach checks as everyone else; it only edits inside its own plot (the plaza).
import { B } from '../blocks.js';

const FAMILY = new Map([
  [B.WIRE_ON, B.WIRE], [B.LAMP_ON, B.LAMP_OFF], [B.SWITCH_ON, B.SWITCH_OFF], [B.DOOR_OPEN, B.DOOR], [B.NOT_ON, B.NOT],
]);
const family = (id) => FAMILY.get(id) ?? id;

// Deterministic build plan relative to the plaza centre. Pure: depends only on the world at plan time.
export function buildPlazaPlan(store, cx, cz, radius = 4) {
  // Anchor on the NATURAL terrain height, not the edited one: after a restart the plaza (and its
  // central switch) is already in the world, and anchoring on that would rebuild it a level higher.
  const h0 = store.naturalSurface ? store.naturalSurface(cx, cz) : store.surface(cx, cz);
  const inPlot = (x, z) => Math.abs(x - cx) <= radius && Math.abs(z - cz) <= radius;
  const build = [];
  // Floor: chrome with a black-alloy border.
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const edge = Math.abs(dx) === radius || Math.abs(dz) === radius;
      build.push({ x: cx + dx, y: h0, z: cz + dz, id: edge ? B.ALLOY : B.CHROME });
    }
  }
  // Corner lamp posts: Power Node -> Power Wire -> Lumen Lamp (always lit by the circuit sim).
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const x = cx + sx * radius;
    const z = cz + sz * radius;
    build.push({ x, y: h0 + 1, z, id: B.NODE }, { x, y: h0 + 2, z, id: B.WIRE }, { x, y: h0 + 3, z, id: B.LAMP_OFF });
  }
  // Central switch with four wire paths, each ending under a lamp. SPARK pulses the switch.
  build.push({ x: cx, y: h0 + 1, z: cz, id: B.SWITCH_OFF, pulse: true });
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let i = 1; i <= 3; i++) build.push({ x: cx + dx * i, y: h0 + 1, z: cz + dz * i, id: B.WIRE });
    build.push({ x: cx + dx * 3, y: h0 + 2, z: cz + dz * 3, id: B.LAMP_OFF });
  }
  const built = new Set(build.map((p) => p.x + ',' + p.y + ',' + p.z));
  // First clear the air space above the plaza (top-down so nothing floats), except cells the
  // build itself occupies (so an existing plaza is never torn down and rebuilt).
  const plan = [];
  for (let y = h0 + 5; y >= h0 + 1; y--) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (built.has((cx + dx) + ',' + y + ',' + (cz + dz))) continue;
        const id = store.getBlock(cx + dx, y, cz + dz);
        if (id !== B.AIR && id !== B.FLUID) plan.push({ x: cx + dx, y, z: cz + dz, id: B.AIR });
      }
    }
  }
  plan.push(...build);
  const kept = plan.filter((p) => inPlot(p.x, p.z));
  // The final desired state per cell (later entries win, e.g. a lamp post replaces a cleared hill).
  const finalCells = new Map();
  for (const p of kept) finalCells.set(p.x + ',' + p.y + ',' + p.z, p);
  return { h0, plan: kept, final: [...finalCells.values()], center: { x: cx, z: cz }, radius };
}

export class Spark {
  constructor({ store, center, radius = 4, placeEveryMs = 900, maintainEveryMs = 10000, pulseEveryMs = 20000, speed = 4 } = {}) {
    this.store = store;
    this.center = center;
    this.radius = radius;
    this.placeEveryMs = placeEveryMs;
    this.maintainEveryMs = maintainEveryMs;
    this.pulseEveryMs = pulseEveryMs;
    this.speed = speed;
    this.index = 0;
    this.lastAct = 0;
    this.lastMove = 0;
    this.lastMaintain = 0;
    this.lastPulse = 0;
    this.complete = false;
    this.placed = 0;
    this.repaired = 0;
    this.denied = 0;
    this.repairQueue = [];
  }

  attach(a) {
    this.a = a;
    const { plan, h0, final } = buildPlazaPlan(this.store, this.center.x, this.center.z, this.radius);
    this.plan = plan;
    this.final = final;
    this.h0 = h0;
    this.switchCell = plan.find((p) => p.pulse);
    this.peer = a.addLocal('bot-spark', { name: 'SPARK', bot: true, privileged: 'bot', color: 0xffc94d, pos: this.standAt(this.center.x + 2, this.center.z + 2) });
    this.peer.title = 'builder';
  }

  standAt(x, z) {
    // Stand on top of whatever is there (the bot obeys the same reach rule as players).
    const y = this.store.surface(Math.floor(x), Math.floor(z)) + 1;
    return { x: x + 0.5, y, z: z + 0.5, yaw: 0, pitch: 0 };
  }

  matches(cell) {
    return family(this.store.getBlock(cell.x, cell.y, cell.z)) === family(cell.id);
  }

  nextTarget() {
    if (this.repairQueue.length) return this.repairQueue[0];
    while (this.index < this.plan.length && this.matches(this.plan[this.index])) this.index++;
    if (this.index >= this.plan.length) {
      this.complete = true;
      return null;
    }
    return this.plan[this.index];
  }

  moveToward(target, now) {
    const p = this.peer.pos;
    const dt = this.lastMove ? Math.min(0.5, (now - this.lastMove) / 1000) : 0.1;
    this.lastMove = now;
    const goal = this.standAt(target.x + (target.x >= this.center.x ? -1 : 1), target.z);
    const dx = goal.x - p.x;
    const dz = goal.z - p.z;
    const d = Math.hypot(dx, dz);
    const step = Math.min(d, this.speed * dt);
    const nx = d > 0 ? p.x + (dx / d) * step : p.x;
    const nz = d > 0 ? p.z + (dz / d) * step : p.z;
    const ny = this.store.surface(Math.floor(nx), Math.floor(nz)) + 1;
    this.a.localState(this.peer.id, { x: nx, y: Math.max(ny, p.y - 1), z: nz, yaw: Math.atan2(-dx, -dz), pitch: 0 });
  }

  inReach(cell) {
    const p = this.peer.pos;
    return Math.hypot(cell.x + 0.5 - p.x, cell.y + 0.5 - (p.y + 1.6), cell.z + 0.5 - p.z) <= 6;
  }

  tick(now) {
    if (now - this.lastMaintain >= this.maintainEveryMs && this.complete) {
      this.lastMaintain = now;
      const broken = this.final.filter((c) => !c.pulse && !this.matches(c));
      for (const c of broken) if (!this.repairQueue.includes(c)) this.repairQueue.push(c);
    }
    const target = this.nextTarget();
    if (!target) {
      if (this.switchCell && now - this.lastPulse >= this.pulseEveryMs) {
        if (!this.inReach(this.switchCell)) return this.moveToward(this.switchCell, now);
        this.lastPulse = now;
        const cur = this.store.getBlock(this.switchCell.x, this.switchCell.y, this.switchCell.z);
        this.a.localEdit(this.peer.id, this.switchCell.x, this.switchCell.y, this.switchCell.z, cur === B.SWITCH_ON ? B.SWITCH_OFF : B.SWITCH_ON);
      } else this.moveToward({ x: this.center.x + 2, y: this.h0, z: this.center.z + 2 }, now);
      return;
    }
    if (!this.inReach(target)) return this.moveToward(target, now);
    if (now - this.lastAct < this.placeEveryMs) return;
    this.lastAct = now;
    const cur = this.store.getBlock(target.x, target.y, target.z);
    if (target.id !== B.AIR && cur !== B.AIR && cur !== B.FLUID) {
      // Occupied by the wrong block: clear it first (same rule as players: no placing into blocks).
      const clear = this.a.localEdit(this.peer.id, target.x, target.y, target.z, B.AIR);
      if (!clear.ok && clear.reason !== 'rate') {
        this.denied++;
        if (this.repairQueue[0] === target) this.repairQueue.shift();
        else this.index++;
      }
      return;
    }
    const res = this.a.localEdit(this.peer.id, target.x, target.y, target.z, target.id);
    if (res.ok) {
      if (this.repairQueue[0] === target) this.repaired++;
      else this.placed++;
    } else if (res.reason !== 'rate') this.denied++;
    if (this.repairQueue[0] === target) this.repairQueue.shift();
    else if (!res.ok && res.reason !== 'rate') this.index++; // skip cells it may not edit (never forces)
  }
}
