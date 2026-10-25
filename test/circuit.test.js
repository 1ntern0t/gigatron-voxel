import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitSim, toggleSwitch, isCircuitBlock } from '../src/core/circuit.js';
import { B } from '../src/core/blocks.js';

function makeWorld() {
  const m = new Map();
  const sim = new CircuitSim();
  const k = (x, y, z) => x + ',' + y + ',' + z;
  return {
    sim,
    set(x, y, z, id) { m.set(k(x, y, z), id); sim.track(x, y, z, id); },
    get(x, y, z) { return m.get(k(x, y, z)) ?? B.AIR; },
    tick(n = 1) {
      let all = [];
      for (let i = 0; i < n; i++) {
        const ch = sim.step((x, y, z) => this.get(x, y, z));
        for (const c of ch) m.set(k(c.x, c.y, c.z), c.id);
        all = all.concat(ch);
      }
      return all;
    },
  };
}

test('node -> wire -> lamp lights the lamp and energises wires', () => {
  const w = makeWorld();
  w.set(0, 0, 0, B.NODE);
  w.set(1, 0, 0, B.WIRE);
  w.set(2, 0, 0, B.WIRE);
  w.set(3, 0, 0, B.LAMP_OFF);
  w.tick();
  assert.equal(w.get(3, 0, 0), B.LAMP_ON);
  assert.equal(w.get(1, 0, 0), B.WIRE_ON);
  assert.equal(w.get(2, 0, 0), B.WIRE_ON);
});

test('a gap in the wire leaves the lamp dark', () => {
  const w = makeWorld();
  w.set(0, 0, 0, B.NODE);
  w.set(1, 0, 0, B.WIRE);
  w.set(3, 0, 0, B.WIRE);
  w.set(4, 0, 0, B.LAMP_OFF);
  w.tick(2);
  assert.equal(w.get(4, 0, 0), B.LAMP_OFF);
  assert.equal(w.get(3, 0, 0), B.WIRE);
});

test('switch toggles a lamp on and off', () => {
  const w = makeWorld();
  w.set(0, 0, 0, B.SWITCH_OFF);
  w.set(0, 0, 1, B.WIRE);
  w.set(0, 0, 2, B.LAMP_OFF);
  w.tick();
  assert.equal(w.get(0, 0, 2), B.LAMP_OFF);
  w.set(0, 0, 0, toggleSwitch(w.get(0, 0, 0)));
  w.tick();
  assert.equal(w.get(0, 0, 2), B.LAMP_ON);
  w.set(0, 0, 0, toggleSwitch(w.get(0, 0, 0)));
  w.tick();
  assert.equal(w.get(0, 0, 2), B.LAMP_OFF);
  assert.equal(w.get(0, 0, 1), B.WIRE);
});

test('energy door opens while powered and closes when power is cut', () => {
  const w = makeWorld();
  w.set(0, 0, 0, B.SWITCH_ON);
  w.set(0, 1, 0, B.WIRE);
  w.set(0, 2, 0, B.DOOR);
  w.tick();
  assert.equal(w.get(0, 2, 0), B.DOOR_OPEN);
  w.set(0, 0, 0, B.SWITCH_OFF);
  w.tick();
  assert.equal(w.get(0, 2, 0), B.DOOR);
});

test('inverter outputs when its input (below) is dead, and stops when live', () => {
  const w = makeWorld();
  w.set(0, 0, 0, B.SWITCH_OFF);
  w.set(1, 0, 0, B.WIRE); // input wire running under the gate
  w.set(1, 1, 0, B.NOT);
  w.set(2, 1, 0, B.WIRE);
  w.set(3, 1, 0, B.LAMP_OFF);
  w.tick(3);
  assert.equal(w.get(1, 1, 0), B.NOT_ON);
  assert.equal(w.get(3, 1, 0), B.LAMP_ON);
  w.set(0, 0, 0, B.SWITCH_ON);
  w.tick(3);
  assert.equal(w.get(1, 1, 0), B.NOT);
  assert.equal(w.get(3, 1, 0), B.LAMP_OFF);
});

test('inverter does not feed downward into its own input', () => {
  const w = makeWorld();
  w.set(0, 1, 0, B.NOT);
  w.set(0, 0, 0, B.WIRE);
  w.tick(4);
  assert.equal(w.get(0, 1, 0), B.NOT_ON);
  assert.equal(w.get(0, 0, 0), B.WIRE);
});

test('an inverter feeding back into its own input oscillates (a clock)', () => {
  const w = makeWorld();
  w.set(0, 1, 0, B.NOT);
  w.set(1, 1, 0, B.WIRE);
  w.set(1, 0, 0, B.WIRE);
  w.set(0, 0, 0, B.WIRE);
  const states = [];
  for (let i = 0; i < 6; i++) {
    w.tick();
    states.push(w.get(0, 1, 0));
  }
  assert.ok(states.includes(B.NOT) && states.includes(B.NOT_ON));
});

test('stable circuits produce no changes on extra ticks', () => {
  const w = makeWorld();
  w.set(0, 0, 0, B.NODE);
  w.set(1, 0, 0, B.WIRE);
  w.set(2, 0, 0, B.LAMP_OFF);
  w.tick();
  assert.equal(w.tick().length, 0);
});

test('removed blocks are untracked and unloaded cells are skipped', () => {
  const sim = new CircuitSim();
  sim.track(0, 0, 0, B.WIRE);
  sim.track(1, 0, 0, B.LAMP_OFF);
  assert.equal(sim.size, 2);
  sim.track(0, 0, 0, B.AIR);
  assert.equal(sim.size, 1);
  assert.deepEqual(sim.step(() => null), []);
  assert.equal(sim.size, 1);
  assert.ok(isCircuitBlock(B.WIRE) && !isCircuitBlock(B.STONE));
});
