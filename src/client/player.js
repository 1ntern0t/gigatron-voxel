// First-person player controller with AABB collision against the voxel grid.
import { B } from '../core/blocks.js';

const HALF_W = 0.3;
const HEIGHT = 1.75;
export const EYE = 1.6;
const GRAVITY = 28;
const JUMP_V = 8.6;

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 0, y: 60, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.inFluid = false;
  }

  collides(x, y, z) {
    const x0 = Math.floor(x - HALF_W);
    const x1 = Math.floor(x + HALF_W);
    const y0 = Math.floor(y);
    const y1 = Math.floor(y + HEIGHT - 0.001);
    const z0 = Math.floor(z - HALF_W);
    const z1 = Math.floor(z + HALF_W);
    for (let by = y0; by <= y1; by++) for (let bz = z0; bz <= z1; bz++) for (let bx = x0; bx <= x1; bx++) {
      if (this.world.isSolid(bx, by, bz)) return true;
    }
    return false;
  }

  // Does the player's body overlap block (bx,by,bz)? Used to forbid placing blocks inside yourself.
  overlapsBlock(bx, by, bz) {
    return bx + 1 > this.pos.x - HALF_W && bx < this.pos.x + HALF_W &&
      by + 1 > this.pos.y && by < this.pos.y + HEIGHT &&
      bz + 1 > this.pos.z - HALF_W && bz < this.pos.z + HALF_W;
  }

  // input: {forward, right, jump, down, sprint} in [-1, 1]
  update(dt, input) {
    dt = Math.min(dt, 0.05);
    const feet = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z));
    this.inFluid = feet === B.FLUID;
    const speed = this.flying ? (input.sprint ? 22 : 11) : this.inFluid ? 3.2 : input.sprint ? 7.5 : 4.8;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Camera looks down -z when yaw = 0.
    let wx = -sin * input.forward + cos * input.right;
    let wz = -cos * input.forward - sin * input.right;
    const len = Math.hypot(wx, wz);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    const accel = this.onGround || this.flying ? 14 : 4;
    this.vel.x += (wx * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wz * speed - this.vel.z) * Math.min(1, accel * dt);

    if (this.flying) {
      const vy = (input.jump ? 1 : 0) - (input.down ? 1 : 0);
      this.vel.y += (vy * speed - this.vel.y) * Math.min(1, 10 * dt);
    } else if (this.inFluid) {
      this.vel.y -= GRAVITY * 0.25 * dt;
      if (input.jump) this.vel.y = Math.min(this.vel.y + 30 * dt, 3.5);
      this.vel.y = Math.max(this.vel.y, -3);
    } else {
      this.vel.y -= GRAVITY * dt;
      if (input.jump && this.onGround) this.vel.y = JUMP_V;
      this.vel.y = Math.max(this.vel.y, -50);
    }

    this.onGround = false;
    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('z', this.vel.z * dt);
    this.moveAxis('y', this.vel.y * dt);

    // Fell out of the world: respawn handled by caller.
    return this.pos.y < -20;
  }

  moveAxis(axis, delta) {
    if (delta === 0) return;
    const steps = Math.ceil(Math.abs(delta) / 0.4);
    const d = delta / steps;
    for (let i = 0; i < steps; i++) {
      const next = { ...this.pos };
      next[axis] += d;
      if (this.collides(next.x, next.y, next.z)) {
        // Auto step-up for walking onto a single block.
        if (axis !== 'y' && this.onGroundCheck() && !this.flying && !this.collides(next.x, next.y + 1.01, next.z) && !this.collides(this.pos.x, this.pos.y + 1.01, this.pos.z)) {
          this.pos.y += 1.01;
          this.pos[axis] = next[axis];
          continue;
        }
        if (axis === 'y') {
          if (d < 0) {
            this.onGround = true;
            this.pos.y = Math.floor(this.pos.y + d) + 1;
            if (this.collides(this.pos.x, this.pos.y, this.pos.z)) this.pos.y = next.y - d;
          }
          this.vel.y = 0;
        } else {
          this.vel[axis] = 0;
        }
        return;
      }
      this.pos[axis] = next[axis];
    }
  }

  onGroundCheck() {
    return this.collides(this.pos.x, this.pos.y - 0.05, this.pos.z);
  }

  eye() {
    return { x: this.pos.x, y: this.pos.y + EYE, z: this.pos.z };
  }

  lookDir() {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }
}
