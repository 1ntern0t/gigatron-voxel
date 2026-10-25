// Procedural meshes for drones, item drops, remote players, the beacon beam and hub links.
import * as THREE from '../../vendor/three/three.module.js';
import { itemTile } from '../core/blocks.js';
import { ATLAS_GRID } from '../core/blocks.js';

const chrome = new THREE.MeshLambertMaterial({ color: 0xc8d2e0, emissive: 0x1a2230 });
const black = new THREE.MeshLambertMaterial({ color: 0x101216, emissive: 0x050608 });
const cyan = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
const amber = new THREE.MeshBasicMaterial({ color: 0xffb020 });
const dim = new THREE.MeshBasicMaterial({ color: 0x336677 });

export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xbfeaff, 0x221133, 1.2);
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(0.5, 1, 0.3);
  scene.add(hemi, dir);
  return { hemi, dir };
}

export function createDroneMesh(wild = false) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.42), chrome);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05), black);
  visor.position.set(0, 0.02, -0.22);
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.03), wild ? dim : cyan);
  eye.position.set(0, 0.02, -0.25);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.03, 6, 20), black);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.16;
  const rotor = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.06), wild ? dim : cyan);
  rotor.position.y = 0.17;
  const carry = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), amber);
  carry.position.y = -0.24;
  carry.visible = false;
  g.add(body, visor, eye, ring, rotor, carry);
  g.userData = { eye, rotor, carry };
  return g;
}

export function setDroneTamed(mesh) {
  mesh.userData.eye.material = cyan;
  mesh.userData.rotor.material = cyan;
}

export function animateDrone(mesh, d, t) {
  mesh.position.set(d.x, d.y + Math.sin(t * 3 + d.id) * 0.06, d.z);
  mesh.userData.rotor.rotation.y = t * 18;
  mesh.userData.carry.visible = !!d.carry;
  if (d.mode === 'work') mesh.userData.eye.material = amber;
  else if (!d.wild) mesh.userData.eye.material = cyan;
}

export function createDropMesh(atlasTexture, item) {
  const tile = itemTile(item);
  const g = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const ts = 1 / ATLAS_GRID;
  const u0 = (tile % ATLAS_GRID) * ts;
  const v0 = 1 - (Math.floor(tile / ATLAS_GRID) + 1) * ts;
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * ts, v0 + uv.getY(i) * ts);
  const mat = new THREE.MeshBasicMaterial({ map: atlasTexture });
  return new THREE.Mesh(g, mat);
}

export function createAvatar(name) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.35), chrome);
  body.position.y = 0.95;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.3), black);
  legs.position.y = 0.25;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.4), black);
  head.position.y = 1.6;
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.02), cyan);
  eye.position.set(0, 1.62, -0.21);
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.02), cyan);
  core.position.set(0, 1.05, -0.18);
  g.add(body, legs, head, eye, core);
  g.add(makeLabel(name));
  return g;
}

export function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,10,20,0.6)';
  ctx.fillRect(0, 8, 256, 48);
  ctx.fillStyle = '#7ff6ff';
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(1.6, 0.4, 1);
  s.position.y = 2.2;
  return s;
}

export function createBeaconBeam(beacon) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x00e8ff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 200, 12, 1, true), mat);
  beam.position.set(beacon.x + 0.5, beacon.y + 23 + 100, beacon.z + 0.5);
  return beam;
}

export function createSelectionBox() {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
  const box = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x00f0ff }));
  box.visible = false;
  return box;
}

export function createLinkLine(a, b) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(a.x + 0.5, a.y + 1.2, a.z + 0.5),
    new THREE.Vector3(b.x + 0.5, b.y + 1.2, b.z + 0.5),
  ]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x00ffd0, dashSize: 0.4, gapSize: 0.25 }));
  line.computeLineDistances();
  return line;
}

export function createPacket() {
  return new THREE.Mesh(new THREE.OctahedronGeometry(0.16), amber);
}
