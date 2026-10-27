// GIGATRON: Swarm Frontier - game bootstrap and main loop.
import * as THREE from '../vendor/three/three.module.js';
import { CHUNK, HEIGHT, chunkKey, fromLocalIndex, parseChunkKey, localIndex } from './core/constants.js';
import { B, BLOCKS, ITEM_DRONE_POD, itemName, itemTile, isValidItemId } from './core/blocks.js';
import { parseSeed } from './core/rng.js';
import { CircuitSim, isCircuitBlock, toggleSwitch } from './core/circuit.js';
import { createQuestState, applyQuestEvent, currentQuest, isQuestLineComplete, QUESTS } from './core/quests.js';
import { computeHubLinks, longestChain, transferStep, addToStorage, storageTotal, createDrone, updateDrone, HARVEST_RADIUS, MAX_DRONES, MINEABLE, dist3 } from './core/swarm.js';
import { serializeWorld, deserializeWorld, INVENTORY_SIZE } from './core/save.js';
import { createAtlasCanvas, tileIcon } from './client/atlas.js';
import { createVoxelMaterials } from './client/materials.js';
import { createSky, dayState } from './client/sky.js';
import { ChunkWorld } from './client/world.js';
import { Player } from './client/player.js';
import { Input } from './client/input.js';
import { openSaveStore, loadSettings, saveSettings } from './client/storage.js';
import { sfx, setAudioEnabled } from './client/audio.js';
import { Net } from './client/net.js';
import {
  createLights, createDroneMesh, setDroneTamed, animateDrone, createDropMesh, createAvatar,
  createBeaconBeam, createSelectionBox, createLinkLine, createPacket,
} from './client/entities.js';

const $ = (id) => document.getElementById(id);
const STACK = 999;
const PLACE_BLOCKED = new Set([B.AIR, B.FLUID, B.BEDROCK, B.CORE, B.BEACON]);
const NET_FORBIDDEN = new Set([B.BEDROCK, B.CORE, B.BEACON, B.FLUID]);

function starterInventory() {
  const inv = new Array(INVENTORY_SIZE).fill(null);
  const kit = [
    [B.CHROME, 64], [B.GLASS, 32], [B.WIRE, 64], [B.NODE, 8], [B.SWITCH_OFF, 8],
    [B.LAMP_OFF, 8], [B.DOOR, 4], [B.HUB, 4], [ITEM_DRONE_POD, 1],
    [B.NOT, 8], [B.ALLOY, 64], [B.LEAF, 16],
  ];
  kit.forEach(([id, count], i) => (inv[i] = { id, count }));
  return inv;
}

class Game {
  constructor() {
    this.settings = { renderDistance: matchMedia('(pointer: coarse)').matches ? 4 : 8, sensitivity: 1, fov: 75, sound: true, showInfo: true, name: 'Builder', ...loadSettings() };
    this.canvas = $('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !matchMedia('(pointer: coarse)').matches, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 1.5 : 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.08, 1200);
    this.camera.rotation.order = 'YXZ';
    this.atlasCanvas = createAtlasCanvas();
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.magFilter = THREE.NearestFilter;
    this.atlas.minFilter = THREE.NearestFilter;
    this.atlas.generateMipmaps = false;
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.materials = createVoxelMaterials(this.atlas);
    this.sky = createSky();
    this.scene.add(this.sky.mesh);
    this.lights = createLights(this.scene);
    this.selection = createSelectionBox();
    this.scene.add(this.selection);
    this.iconCache = new Map();
    this.net = new Net(this);
    this.net.onStatus = (t, kind) => {
      $('mp-status').textContent = t;
      if (this.running) this.toast(t);
      if (kind === 'warn') console.warn(t);
    };
    this.running = false;
    this.screens = [];
    this.fps = 0;
    this.frames = 0;
    this.fpsT = 0;
    this.debug = false;
    this.input = new Input(this.canvas, {
      onKey: (code, e) => this.onKey(code, e),
      onPrimary: () => this.breakBlock(),
      onSecondary: () => this.useOrPlace(),
      onPick: () => this.pickBlock(),
      onWheel: (d) => this.selectSlot((this.selected + d + 9) % 9),
      onDoubleJump: () => this.toggleFly(),
      onLockChange: (locked) => this.onLockChange(locked),
      onTouchDetected: () => this.updateLockTip(),
    });
    this.applySettings();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.wireUI();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());
    openSaveStore().then(({ store, kind }) => {
      this.store = store;
      $('storage-kind').textContent = 'Saves are stored in this browser (' + kind + ').';
      this.refreshWorldList();
    });
    const params = new URLSearchParams(location.search);
    if (params.get('seed')) $('new-seed').value = params.get('seed').slice(0, 64);
    if (params.get('autostart') === '1') this.newWorld();
    addEventListener('pagehide', () => this.autosave());
    document.addEventListener('visibilitychange', () => document.hidden && this.autosave());
  }

  // ---------- UI ----------
  wireUI() {
    document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => this.openScreen(b.dataset.open)));
    document.querySelectorAll('.panel .close').forEach((b) => b.addEventListener('click', () => this.closeScreen()));
    $('btn-new').addEventListener('click', () => this.newWorld());
    $('btn-resume').addEventListener('click', () => this.closeScreen());
    $('btn-save').addEventListener('click', async () => {
      await this.save();
      this.toast('World saved.');
    });
    $('btn-quit').addEventListener('click', () => this.quitToTitle());
    $('btn-share').addEventListener('click', () => this.shareSeed());
    $('btn-export').addEventListener('click', () => this.exportWorld());
    $('btn-host').addEventListener('click', () => this.hostRoom());
    $('btn-join').addEventListener('click', () => this.joinRoom());
    $('btn-leave').addEventListener('click', () => {
      this.net.leave();
      for (const id of [...this.remotes.keys()]) this.removeRemote(id);
      this.isClient = false;
      $('mp-status').textContent = 'Offline.';
    });
    $('mp-name').value = this.settings.name;
    const bindRange = (id, key, fmt = (v) => v) => {
      const el = $(id);
      el.value = this.settings[key];
      $(id + '-v').textContent = fmt(this.settings[key]);
      el.addEventListener('input', () => {
        this.settings[key] = Number(el.value);
        $(id + '-v').textContent = fmt(this.settings[key]);
        this.applySettings();
      });
    };
    bindRange('set-rd', 'renderDistance');
    bindRange('set-sens', 'sensitivity');
    bindRange('set-fov', 'fov');
    $('set-sound').checked = this.settings.sound;
    $('set-sound').addEventListener('change', (e) => { this.settings.sound = e.target.checked; this.applySettings(); });
    $('set-fps').checked = this.settings.showInfo;
    $('set-fps').addEventListener('change', (e) => { this.settings.showInfo = e.target.checked; this.applySettings(); });
    $('chat-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v) this.net.sendChat(v);
        e.target.value = '';
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    });
  }

  applySettings() {
    saveSettings(this.settings);
    this.input.sensitivity = this.settings.sensitivity;
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    setAudioEnabled(this.settings.sound);
    if (this.world) this.world.renderDistance = this.settings.renderDistance;
    $('info').hidden = !this.settings.showInfo;
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  openScreen(id) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = true;
    this.screens.push(id);
    $(id).hidden = false;
    this.input.enabled = false;
    this.input.exitLock();
    if (id === 'inv') this.renderInventory();
    if (id === 'pause') $('seed-line').textContent = 'World "' + this.name + '" - seed: ' + this.seedText + (this.creative ? ' - creative' : '');
    if (id === 'mp') {
      $('btn-host').disabled = !this.running || this.isClient;
      $('btn-leave').hidden = !this.net.active;
    }
    this.updateLockTip();
  }

  closeScreen() {
    const cur = this.screens.pop();
    if (cur) $(cur).hidden = true;
    const prev = this.screens[this.screens.length - 1];
    if (prev) {
      $(prev).hidden = false;
      if (prev === 'start') this.refreshWorldList();
    } else if (this.running) {
      this.input.enabled = true;
      this.input.requestLock();
      this.canvas.focus();
    } else {
      this.screens = ['start'];
      $('start').hidden = false;
    }
    this.updateLockTip();
  }

  closeAllScreens() {
    for (const s of document.querySelectorAll('.screen')) s.hidden = true;
    this.screens = [];
  }

  onLockChange(locked) {
    if (!locked && this.running && this.screens.length === 0 && !this.chatOpen) this.openScreen('pause');
    this.updateLockTip();
  }

  updateLockTip() {
    $('locktip').hidden = !(this.running && !this.input.locked && !this.input.isTouch && this.screens.length === 0);
  }

  toast(text) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    $('toasts').appendChild(d);
    setTimeout(() => d.remove(), 4000);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  }

  showChat(name, text) {
    const d = document.createElement('div');
    d.textContent = name + ': ' + text;
    $('chatlog').appendChild(d);
    while ($('chatlog').children.length > 8) $('chatlog').firstChild.remove();
    setTimeout(() => d.remove(), 30000);
  }

  openChat() {
    if (!this.net.active) {
      this.toast('Chat is available in multiplayer sessions.');
      return;
    }
    this.chatOpen = true;
    this.input.enabled = false;
    this.input.exitLock();
    $('chatbox').hidden = false;
    setTimeout(() => $('chat-input').focus(), 0);
  }

  closeChat() {
    this.chatOpen = false;
    $('chatbox').hidden = true;
    this.input.enabled = true;
    this.input.requestLock();
    this.canvas.focus();
  }

  icon(id) {
    if (!this.iconCache.has(id)) this.iconCache.set(id, tileIcon(this.atlasCanvas, itemTile(id)));
    return this.iconCache.get(id);
  }

  renderHotbar() {
    const hb = $('hotbar');
    hb.textContent = '';
    for (let i = 0; i < 9; i++) {
      const s = this.inventory[i];
      const el = document.createElement('div');
      el.className = 'slot' + (i === this.selected ? ' sel' : '');
      if (s) {
        el.style.backgroundImage = `url(${this.icon(s.id)})`;
        el.title = itemName(s.id);
        const b = document.createElement('b');
        b.textContent = this.creative ? '' : String(s.count);
        el.appendChild(b);
      }
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.selectSlot(i);
      });
      hb.appendChild(el);
    }
    this.hotbarDirty = false;
  }

  renderInventory() {
    const grid = $('inv-grid');
    grid.textContent = '';
    const make = (id, count, onClick, sel) => {
      const el = document.createElement('div');
      el.className = 'slot' + (sel ? ' sel' : '');
      if (id) {
        el.style.backgroundImage = `url(${this.icon(id)})`;
        el.title = itemName(id) + (BLOCKS[id]?.desc ? ' - ' + BLOCKS[id].desc : '');
        if (count !== null) {
          const b = document.createElement('b');
          b.textContent = String(count);
          el.appendChild(b);
        }
      }
      el.addEventListener('click', onClick);
      grid.appendChild(el);
    };
    if (this.creative) {
      const ids = BLOCKS.filter((b) => b.id !== B.AIR && b.breakable && b.drop === b.id).map((b) => b.id).concat([ITEM_DRONE_POD]);
      for (const id of ids) {
        make(id, null, () => {
          this.inventory[this.selected] = { id, count: STACK };
          this.hotbarDirty = true;
          this.toast(itemName(id) + ' -> slot ' + (this.selected + 1));
        });
      }
    } else {
      for (let i = 0; i < INVENTORY_SIZE; i++) {
        const s = this.inventory[i];
        make(s?.id, s?.count ?? null, () => {
          const t = this.inventory[this.selected];
          this.inventory[this.selected] = this.inventory[i];
          this.inventory[i] = t;
          this.hotbarDirty = true;
          this.renderInventory();
        }, i === this.selected);
      }
    }
  }

  async refreshWorldList() {
    if (!this.store) return;
    const list = await this.store.list();
    const box = $('worlds');
    box.textContent = '';
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No saved worlds yet.';
      box.appendChild(p);
    }
    for (const w of list) {
      const row = document.createElement('div');
      row.className = 'world';
      const label = document.createElement('span');
      label.textContent = w.name + ' (seed ' + w.seedText + ')';
      const play = document.createElement('button');
      play.textContent = 'Play';
      play.addEventListener('click', async () => {
        try {
          this.startWorld(await this.store.load(w.name));
        } catch (err) {
          alert('Could not load world: ' + err.message);
        }
      });
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (confirm('Delete world "' + w.name + '"? This cannot be undone.')) {
          await this.store.remove(w.name);
          this.refreshWorldList();
        }
      });
      row.append(label, play, del);
      box.appendChild(row);
    }
  }

  // ---------- World lifecycle ----------
  newWorld() {
    const seedText = $('new-seed').value.trim() || String(Math.floor(Math.random() * 1e9));
    const name = ($('new-name').value.trim() || 'Frontier').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) || 'Frontier';
    this.startWorld({
      name, seed: parseSeed(seedText), seedText, creative: $('new-creative').checked, time: 30,
      player: null, inventory: starterInventory(), selected: 0, quests: createQuestState(),
      drones: [], hubs: [], tamed: [], edits: new Map(), createdAt: Date.now(),
    });
  }

  startWorld(state, { client = false } = {}) {
    this.teardownWorld();
    this.closeAllScreens();
    this.isClient = client;
    this.name = state.name;
    this.seed = state.seed >>> 0;
    this.seedText = state.seedText ?? String(this.seed);
    this.createdAt = state.createdAt || Date.now();
    this.creative = !!state.creative;
    this.time = state.time || 0;
    this.inventory = state.inventory?.length === INVENTORY_SIZE ? state.inventory : starterInventory();
    this.selected = state.selected || 0;
    this.quests = state.quests || createQuestState();
    this.tamed = new Set(state.tamed || []);
    this.circuit = new CircuitSim();
    this.world = new ChunkWorld({
      scene: this.scene, materials: this.materials, seed: this.seed, edits: state.edits || new Map(),
      renderDistance: this.settings.renderDistance, onChunkData: (c) => this.onChunkData(c),
    });
    this.gen = this.world.gen;
    this.player = new Player(this.world);
    if (state.player && Number.isFinite(state.player.x) && state.player.y > 0) {
      Object.assign(this.player.pos, { x: state.player.x, y: state.player.y, z: state.player.z });
      this.player.yaw = state.player.yaw || 0;
      this.player.pitch = state.player.pitch || 0;
    } else {
      const s = this.gen.findSpawn();
      Object.assign(this.player.pos, s);
      // Face the beacon.
      this.player.yaw = Math.atan2(-(this.gen.beacon.x - s.x), -(this.gen.beacon.z - s.z));
    }
    this.entityGroup = new THREE.Group();
    this.scene.add(this.entityGroup);
    this.beam = createBeaconBeam(this.gen.beacon);
    this.entityGroup.add(this.beam);
    this.drops = new Map();
    this.dropId = 0;
    this.drones = [];
    this.droneId = 0;
    this.wild = new Map();
    for (const d of state.drones || []) this.spawnDrone(d.x, d.y, d.z, d.mode, d.hub);
    this.hubs = new Map();
    this.hubOrder = 0;
    for (const h of state.hubs || []) {
      this.hubs.set(h.key, { ...h, storage: { ...h.storage } });
      this.hubOrder = Math.max(this.hubOrder, h.order);
    }
    this.linkObjects = [];
    this.packets = [];
    this.refreshLinks();
    this.oreClaims = new Set();
    this.remotes = new Map();
    this.timers = { circuit: 0, quest: 0, save: 0, transfer: 0, info: 0, prune: 0 };
    this.loaded = false;
    this.running = true;
    this.hotbarDirty = true;
    $('loading').hidden = false;
    $('loading-text').textContent = 'Generating the frontier...';
    $('hud').hidden = false;
    this.input.enabled = true;
    this.canvas.focus();
    this.input.requestLock();
    this.updateQuestHud();
    this.updateLockTip();
  }

  teardownWorld() {
    if (!this.world) return;
    this.world.dispose();
    this.scene.remove(this.entityGroup);
    this.entityGroup.traverse((o) => o.geometry?.dispose?.());
    this.world = null;
    this.running = false;
  }

  async quitToTitle() {
    await this.save();
    this.net.leave();
    this.teardownWorld();
    $('hud').hidden = true;
    this.closeAllScreens();
    this.openScreen('start');
    this.refreshWorldList();
  }

  getState() {
    return {
      name: this.name, seed: this.seed, seedText: this.seedText, createdAt: this.createdAt, time: this.time, creative: this.creative,
      player: { x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z, yaw: this.player.yaw, pitch: this.player.pitch },
      selected: this.selected, inventory: this.inventory, quests: this.quests,
      drones: this.drones.map((d) => ({ x: d.x, y: d.y, z: d.z, mode: d.mode, hub: d.hub })),
      hubs: [...this.hubs.values()], tamed: [...this.tamed], edits: this.world.edits,
    };
  }

  async save() {
    if (!this.running || !this.store || !this.world) return;
    try {
      await this.store.save(this.getState());
    } catch (err) {
      this.toast('Save failed: ' + err.message);
    }
  }

  autosave() {
    if (this.running && this.loaded && !this.isClient) this.save();
  }

  shareSeed() {
    const url = location.origin + location.pathname + '?seed=' + encodeURIComponent(this.seedText);
    navigator.clipboard?.writeText(url).then(() => this.toast('Share link copied: ' + url), () => this.toast('Seed: ' + this.seedText));
  }

  exportWorld() {
    const blob = new Blob([serializeWorld(this.getState())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.name.replace(/\s+/g, '_') + '.gigatron.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Chunk hooks ----------
  onChunkData(c) {
    const m = this.world.edits.get(chunkKey(c.cx, c.cz));
    if (m) {
      for (const [idx, id] of m) {
        if (!isCircuitBlock(id)) continue;
        const [lx, y, lz] = fromLocalIndex(idx);
        this.circuit.track(c.cx * CHUNK + lx, y, c.cz * CHUNK + lz, id);
      }
    }
    for (const s of this.gen.droneSpawnsForChunk(c.cx, c.cz)) {
      if (this.tamed.has(s.key) || this.wild.has(s.key)) continue;
      const mesh = createDroneMesh(true);
      this.entityGroup.add(mesh);
      this.wild.set(s.key, { ...s, id: 1000 + this.wild.size, home: { x: s.x, y: s.y, z: s.z }, mesh, wild: true });
    }
  }

  // ---------- Blocks ----------
  setBlock(x, y, z, id, { fromNet = false } = {}) {
    let changed = this.world.setBlock(x, y, z, id);
    if (!changed && this.world.getBlockOrNull(x, y, z) === null && y >= 0 && y < HEIGHT) {
      // Chunk not loaded: record the edit so it applies on load.
      const cx = Math.floor(x / CHUNK);
      const cz = Math.floor(z / CHUNK);
      const ck = chunkKey(cx, cz);
      if (!this.world.edits.has(ck)) this.world.edits.set(ck, new Map());
      this.world.edits.get(ck).set(localIndex(x - cx * CHUNK, y, z - cz * CHUNK), id);
      changed = true;
    }
    if (!changed) return false;
    this.circuit.track(x, y, z, id);
    const hk = x + ',' + y + ',' + z;
    if (id !== B.HUB && this.hubs.has(hk)) this.removeHub(hk);
    if (!fromNet) this.net.sendEdit(x, y, z, id);
    return true;
  }

  applyNetEdit(msg) {
    if (!this.world) return false;
    const cur = this.world.getBlockOrNull(msg.x, msg.y, msg.z);
    if (this.net.role === 'host') {
      if (NET_FORBIDDEN.has(msg.id)) return false;
      if (cur !== null && BLOCKS[cur] && !BLOCKS[cur].breakable && cur !== B.FLUID && cur !== B.AIR) return false;
    }
    return this.setBlock(msg.x, msg.y, msg.z, msg.id, { fromNet: true }) || true;
  }

  target() {
    const eye = this.player.eye();
    return this.world.raycast(eye, this.player.lookDir(), 7);
  }

  breakBlock() {
    if (!this.canAct()) return;
    const t = this.target();
    if (!t) return;
    const def = BLOCKS[t.id];
    if (!def.breakable) {
      this.toast(def.name + ' cannot be broken.');
      return;
    }
    this.setBlock(t.x, t.y, t.z, B.AIR);
    sfx.break();
    if (!this.creative) this.spawnDrop(t.x + 0.5, t.y + 0.5, t.z + 0.5, def.drop, 1);
  }

  useOrPlace() {
    if (!this.canAct()) return;
    const t = this.target();
    if (!t) return;
    if (t.id === B.SWITCH_OFF || t.id === B.SWITCH_ON) {
      this.setBlock(t.x, t.y, t.z, toggleSwitch(t.id));
      sfx.toggle();
      return;
    }
    if (t.id === B.DOOR || t.id === B.DOOR_OPEN) {
      this.toast('Energy Doors open while powered - wire a switch to them.');
    }
    const slot = this.inventory[this.selected];
    if (!slot) return;
    const px = t.x + t.nx;
    const py = t.y + t.ny;
    const pz = t.z + t.nz;
    if (py < 0 || py >= HEIGHT) return;
    const existing = this.world.getBlockOrNull(px, py, pz);
    if (existing === null || (existing !== B.AIR && existing !== B.FLUID)) return;
    if (slot.id === ITEM_DRONE_POD) {
      if (this.drones.length >= MAX_DRONES) {
        this.toast('Your swarm is at its maximum of ' + MAX_DRONES + ' drones.');
        return;
      }
      this.spawnDrone(px + 0.5, py + 0.8, pz + 0.5);
      this.consumeSelected();
      sfx.tame();
      this.toast('Drone deployed. Swarm size: ' + this.drones.length);
      return;
    }
    if (PLACE_BLOCKED.has(slot.id)) return;
    if (BLOCKS[slot.id].solid && this.player.overlapsBlock(px, py, pz)) return;
    this.setBlock(px, py, pz, slot.id);
    if (slot.id === B.HUB) this.addHub(px, py, pz);
    this.consumeSelected();
    sfx.place();
  }

  pickBlock() {
    const t = this.target();
    if (!t || !this.creative) return;
    const id = BLOCKS[t.id].drop;
    if (!isValidItemId(id)) return;
    this.inventory[this.selected] = { id, count: STACK };
    this.hotbarDirty = true;
  }

  canAct() {
    return this.running && this.loaded && this.screens.length === 0;
  }

  consumeSelected() {
    if (this.creative) return;
    const s = this.inventory[this.selected];
    if (!s) return;
    s.count--;
    if (s.count <= 0) this.inventory[this.selected] = null;
    this.hotbarDirty = true;
  }

  addItem(id, count, { quest = true } = {}) {
    if (!isValidItemId(id) || count <= 0) return;
    let left = count;
    for (const s of this.inventory) {
      if (s && s.id === id && s.count < STACK) {
        const n = Math.min(left, STACK - s.count);
        s.count += n;
        left -= n;
        if (!left) break;
      }
    }
    for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
      if (!this.inventory[i]) {
        const n = Math.min(left, STACK);
        this.inventory[i] = { id, count: n };
        left -= n;
      }
    }
    this.hotbarDirty = true;
    if (quest) this.questEvent({ type: 'collect', item: id, count });
  }

  selectSlot(i) {
    this.selected = i;
    this.hotbarDirty = true;
    const s = this.inventory[i];
    if (s) $('target').textContent = itemName(s.id);
  }

  toggleFly() {
    if (!this.running) return;
    if (!this.creative) {
      this.toast('Flight is available in creative worlds.');
      return;
    }
    this.player.flying = !this.player.flying;
    this.toast(this.player.flying ? 'Flight on' : 'Flight off');
  }

  // ---------- Entities ----------
  spawnDrop(x, y, z, item, count) {
    const mesh = createDropMesh(this.atlas, item);
    this.entityGroup.add(mesh);
    const id = ++this.dropId;
    this.drops.set(id, { id, x, y, z, vy: 2, item, count, claimedBy: null, mesh, age: 0 });
  }

  pickupDrop(id) {
    const d = this.drops.get(id);
    if (!d) return null;
    this.drops.delete(id);
    this.entityGroup.remove(d.mesh);
    d.mesh.geometry.dispose();
    return { item: d.item, count: d.count };
  }

  spawnDrone(x, y, z, mode = 'follow', hub = null) {
    const d = createDrone(++this.droneId, x, y, z);
    d.mode = mode;
    d.hub = hub;
    d.mesh = createDroneMesh(false);
    this.entityGroup.add(d.mesh);
    this.drones.push(d);
    return d;
  }

  tameNearest() {
    let best = null;
    let bestD = 4;
    const p = { x: this.player.pos.x, y: this.player.pos.y + 1, z: this.player.pos.z };
    for (const w of this.wild.values()) {
      const dd = dist3(w, p);
      if (dd < bestD) {
        bestD = dd;
        best = w;
      }
    }
    if (!best) return false;
    if (this.drones.length >= MAX_DRONES) {
      this.toast('Your swarm is full.');
      return true;
    }
    if (!this.creative) {
      const slot = this.inventory.findIndex((s) => s && s.id === B.CRYSTAL);
      if (slot < 0) {
        this.toast('This drone wants a Neon Crystal before it bonds with you. Mine one from a glowing spire.');
        return true;
      }
      this.inventory[slot].count--;
      if (!this.inventory[slot].count) this.inventory[slot] = null;
      this.hotbarDirty = true;
    }
    this.wild.delete(best.key);
    this.tamed.add(best.key);
    const d = createDrone(++this.droneId, best.x, best.y, best.z);
    d.mesh = best.mesh;
    setDroneTamed(d.mesh);
    this.drones.push(d);
    sfx.tame();
    this.toast('A drone joined your swarm! Swarm size: ' + this.drones.length);
    return true;
  }

  addHub(x, y, z) {
    const key = x + ',' + y + ',' + z;
    this.hubs.set(key, { key, x, y, z, order: ++this.hubOrder, storage: {} });
    this.refreshLinks();
    const parent = this.links.get(key);
    this.toast(parent ? 'Hub linked into a chain (' + longestChain(this.links) + ' long).' : 'Swarm Hub online. Press Q next to it to assign a drone.');
  }

  removeHub(key) {
    const h = this.hubs.get(key);
    if (!h) return;
    for (const id in h.storage) this.spawnDrop(h.x + 0.5, h.y + 0.5, h.z + 0.5, Number(id), h.storage[id]);
    this.hubs.delete(key);
    this.refreshLinks();
  }

  refreshLinks() {
    this.links = computeHubLinks(this.hubs);
    for (const l of this.linkObjects || []) {
      this.entityGroup.remove(l);
      l.geometry.dispose();
    }
    this.linkObjects = [];
    for (const [k, p] of this.links) {
      if (!p) continue;
      const line = createLinkLine(this.hubs.get(k), this.hubs.get(p));
      this.entityGroup.add(line);
      this.linkObjects.push(line);
    }
  }

  nearestHub(range) {
    let best = null;
    let bestD = range;
    for (const h of this.hubs.values()) {
      const dd = dist3({ x: h.x + 0.5, y: h.y, z: h.z + 0.5 }, this.player.pos);
      if (dd < bestD) {
        bestD = dd;
        best = h;
      }
    }
    return best;
  }

  collectHub(h) {
    const total = storageTotal(h.storage);
    if (!total) {
      this.toast('Hub storage is empty' + (this.links.get(h.key) ? ' (it forwards cargo to its parent hub).' : '.'));
      return;
    }
    for (const id in h.storage) this.addItem(Number(id), h.storage[id]);
    h.storage = {};
    sfx.pickup();
    this.toast('Collected ' + total + ' items from the hub.');
  }

  commandSwarm() {
    const hub = this.nearestHub(6);
    if (hub) {
      const followers = this.drones.filter((d) => d.mode === 'follow' && !d.carry);
      if (!followers.length) {
        this.toast('No free following drones to assign.');
        return;
      }
      followers.sort((a, b) => dist3(a, hub) - dist3(b, hub));
      const d = followers[0];
      d.mode = 'work';
      d.hub = hub.key;
      d.task = null;
      d.searchT = 0;
      const n = this.drones.filter((x) => x.hub === hub.key).length;
      this.toast('Drone assigned to hub (' + n + ' working). It harvests Neon Crystal within ' + HARVEST_RADIUS + ' blocks.');
    } else {
      let n = 0;
      for (const d of this.drones) {
        if (d.mode === 'work') {
          d.mode = 'follow';
          d.hub = null;
          d.task = null;
          n++;
        }
      }
      this.toast(n ? 'Recalled ' + n + ' drones to follow you.' : 'Stand next to a Swarm Hub and press Q to assign a drone.');
    }
  }

  findOre(hub) {
    let best = null;
    let bestD = Infinity;
    const r = HARVEST_RADIUS;
    for (let y = Math.max(1, hub.y - r); y <= Math.min(HEIGHT - 1, hub.y + r); y++) {
      for (let z = hub.z - r; z <= hub.z + r; z++) {
        for (let x = hub.x - r; x <= hub.x + r; x++) {
          const id = this.world.getBlockOrNull(x, y, z);
          if (id === null || !MINEABLE.has(id)) continue;
          const k = x + ',' + y + ',' + z;
          if (this.oreClaims.has(k)) continue;
          const dd = (x - hub.x) ** 2 + (y - hub.y) ** 2 + (z - hub.z) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = { x, y, z };
          }
        }
      }
    }
    if (best) this.oreClaims.add(best.x + ',' + best.y + ',' + best.z);
    return best;
  }

  // ---------- Quests ----------
  questEvent(evt) {
    const r = applyQuestEvent(this.quests, evt);
    if (r.state === this.quests) return;
    this.quests = r.state;
    if (r.completed) {
      sfx.quest();
      this.toast('Quest complete: ' + r.completed.title);
      for (const [id, n] of r.completed.reward) this.addItem(id, n, { quest: false });
      this.toast('Reward: ' + r.completed.reward.map(([id, n]) => n + 'x ' + itemName(id)).join(', '));
      if (isQuestLineComplete(this.quests)) this.toast('GIGATRON: "The frontier is yours to shape. Thank you."');
    }
    this.updateQuestHud();
  }

  updateQuestHud() {
    const q = currentQuest(this.quests);
    const el = $('quest');
    el.textContent = '';
    const title = document.createElement('b');
    const body = document.createElement('div');
    if (!q) {
      title.textContent = 'All Gigatron quests complete';
      body.textContent = 'Keep building. The swarm is yours to lead.';
    } else {
      title.textContent = 'Quest ' + (this.quests.index + 1) + '/' + QUESTS.length + ': ' + q.title;
      body.textContent = q.goal + (q.target > 1 ? ' (' + this.quests.progress + '/' + q.target + ')' : '');
    }
    el.append(title, body);
  }

  openGigatron() {
    const q = currentQuest(this.quests);
    const prev = QUESTS[this.quests.index - 1];
    $('dlg-lore').textContent = prev ? prev.lore : QUESTS[0].lore;
    $('dlg-quest').textContent = q ? 'Current task - ' + q.title + ': ' + q.goal : 'You have completed every task I had. Build, explore, and share your seed with friends.';
    this.openScreen('dialog');
  }

  nearBeacon(range) {
    const b = this.gen.beacon;
    const dx = this.player.pos.x - (b.x + 0.5);
    const dz = this.player.pos.z - (b.z + 0.5);
    return Math.hypot(dx, dz) < range && Math.abs(this.player.pos.y - b.y) < 20;
  }

  // ---------- Input ----------
  onKey(code, e) {
    if (code === 'Escape') {
      if (this.chatOpen) return this.closeChat();
      if (this.screens.length) {
        if (this.screens[this.screens.length - 1] !== 'start') this.closeScreen();
      } else if (this.running) this.openScreen('pause');
      return;
    }
    if (!this.running || this.screens.length || this.chatOpen) {
      if (code === 'KeyI' && this.screens[this.screens.length - 1] === 'inv') this.closeScreen();
      return;
    }
    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= 9) this.selectSlot(n - 1);
    } else if (code === 'KeyE') this.interact();
    else if (code === 'KeyQ') this.commandSwarm();
    else if (code === 'KeyI' || code === 'Tab') this.openScreen('inv');
    else if (code === 'KeyH') this.openScreen('help');
    else if (code === 'KeyT') {
      e?.preventDefault?.();
      this.openChat();
    } else if (code === 'F3') {
      e?.preventDefault?.();
      this.debug = !this.debug;
    }
  }

  interact() {
    if (!this.loaded) return;
    if (this.nearBeacon(11)) {
      this.questEvent({ type: 'reach_beacon' });
      this.openGigatron();
      return;
    }
    if (this.tameNearest()) return;
    const t = this.target();
    if (t && (t.id === B.SWITCH_OFF || t.id === B.SWITCH_ON)) {
      this.setBlock(t.x, t.y, t.z, toggleSwitch(t.id));
      sfx.toggle();
      return;
    }
    if (t && t.id === B.HUB && this.hubs.has(t.x + ',' + t.y + ',' + t.z)) {
      this.collectHub(this.hubs.get(t.x + ',' + t.y + ',' + t.z));
      return;
    }
    const h = this.nearestHub(3);
    if (h) return this.collectHub(h);
    this.toast('Nothing to interact with here. (E works on switches, hubs, wild drones and Gigatron.)');
  }

  // ---------- Multiplayer ----------
  async hostRoom() {
    if (!this.running) return;
    this.settings.name = $('mp-name').value;
    saveSettings(this.settings);
    try {
      const code = await this.net.host(this.settings.name);
      $('mp-code').value = code;
      $('btn-leave').hidden = false;
    } catch (err) {
      $('mp-status').textContent = 'Could not host: ' + err.message;
    }
  }

  async joinRoom() {
    this.settings.name = $('mp-name').value;
    saveSettings(this.settings);
    if (this.running && !this.isClient) await this.save();
    try {
      await this.net.join($('mp-code').value, this.settings.name);
      $('btn-leave').hidden = false;
    } catch (err) {
      $('mp-status').textContent = 'Could not join: ' + err.message;
      this.net.leave();
    }
  }

  snapshotForNet() {
    const edits = [];
    for (const [ck, m] of this.world.edits) {
      const [cx, cz] = parseChunkKey(ck);
      for (const [idx, id] of m) {
        const [lx, y, lz] = fromLocalIndex(idx);
        edits.push(cx * CHUNK + lx, y, cz * CHUNK + lz, id);
      }
    }
    return { seed: this.seed, edits, time: this.time };
  }

  joinNetWorld(msg) {
    const edits = new Map();
    for (let i = 0; i < msg.edits.length; i += 4) {
      const x = msg.edits[i];
      const y = msg.edits[i + 1];
      const z = msg.edits[i + 2];
      const cx = Math.floor(x / CHUNK);
      const cz = Math.floor(z / CHUNK);
      const ck = chunkKey(cx, cz);
      if (!edits.has(ck)) edits.set(ck, new Map());
      edits.get(ck).set(localIndex(x - cx * CHUNK, y, z - cz * CHUNK), msg.edits[i + 3]);
    }
    const net = this.net;
    this.startWorld({
      name: 'Room ' + net.code, seed: msg.seed, seedText: String(msg.seed), creative: true, time: msg.time,
      player: null, inventory: null, selected: 0, quests: createQuestState(), drones: [], hubs: [], tamed: [], edits,
    }, { client: true });
  }

  updateRemote(msg) {
    if (!this.world) return;
    let r = this.remotes.get(msg.p);
    if (!r) {
      r = { mesh: createAvatar(msg.name), target: { x: msg.x, y: msg.y, z: msg.z } };
      r.mesh.position.set(msg.x, msg.y, msg.z);
      this.entityGroup.add(r.mesh);
      this.remotes.set(msg.p, r);
    }
    r.target = { x: msg.x, y: msg.y, z: msg.z };
    r.yaw = msg.yaw;
  }

  removeRemote(id) {
    const r = this.remotes?.get(id);
    if (!r) return;
    this.entityGroup.remove(r.mesh);
    this.remotes.delete(id);
  }

  onNetClosed() {
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    this.toast('Session ended. You can keep playing this world locally; use Save to keep it.');
    this.isClient = false;
  }

  // ---------- Main loop ----------
  frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    const now = performance.now();
    this.frames++;
    if (now - this.fpsT > 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsT));
      this.frames = 0;
      this.fpsT = now;
    }
    if (this.running && this.world) this.update(dt, now);
    else {
      // Title-screen backdrop: slowly orbiting sky.
      this.sky.uniforms.uTime.value = now / 1000;
      this.sky.uniforms.uDay.value = 0.15;
      this.camera.position.set(0, 0, 0);
      this.camera.rotation.set(0.25, now / 20000, 0);
      this.sky.mesh.position.set(0, 0, 0);
    }
    this.renderer.render(this.scene, this.camera);
  }

  update(dt, now) {
    const p = this.player;
    this.time += dt;
    const world = this.world;
    world.update(p.pos.x, p.pos.z);

    if (!this.loaded) {
      const cx = Math.floor(p.pos.x / CHUNK);
      const cz = Math.floor(p.pos.z / CHUNK);
      const c = world.getChunk(cx, cz);
      $('loading-text').textContent = 'Generating the frontier... ' + world.stats.generated + ' chunks';
      if (c && c.meshes) {
        this.loaded = true;
        $('loading').hidden = true;
        // Make sure we are not inside terrain.
        while (p.collides(p.pos.x, p.pos.y, p.pos.z) && p.pos.y < HEIGHT) p.pos.y += 1;
        this.toast(this.isClient ? 'Connected. Creative building enabled in shared rooms.' : 'Welcome to the frontier. Follow the cyan beam to find Gigatron.');
      }
    }

    // Look + move.
    const [dx, dy] = this.input.consumeLook();
    if (this.screens.length === 0 && !this.chatOpen) {
      p.yaw -= dx;
      p.pitch = Math.max(-1.55, Math.min(1.55, p.pitch - dy));
    }
    if (this.loaded) {
      const mv = this.screens.length || this.chatOpen ? { forward: 0, right: 0, jump: false, down: false, sprint: false } : this.input.movement();
      if (!p.flying && mv.down) mv.sprint = true;
      if (p.update(dt, mv)) {
        const s = this.gen.findSpawn();
        Object.assign(p.pos, s);
        p.vel.y = 0;
        this.toast('Rebooted at spawn.');
      }
    }
    const eye = p.eye();
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.set(p.pitch, p.yaw, 0);
    this.sky.mesh.position.copy(this.camera.position);

    // Day / night.
    const ds = dayState(this.time);
    const u = this.materials.uniforms;
    u.uTime.value = this.time;
    u.uDaylight.value = 0.16 + 0.84 * ds.day;
    u.uFogColor.value.copy(ds.fog);
    const far = world.renderDistance * CHUNK;
    u.uFogNear.value = far * 0.55;
    u.uFogFar.value = far * 0.95;
    this.sky.uniforms.uTime.value = this.time;
    this.sky.uniforms.uDay.value = ds.day;
    this.sky.uniforms.uSunDir.value.copy(ds.sun);
    this.lights.hemi.intensity = 0.4 + 1.0 * ds.day;
    this.lights.dir.intensity = 0.2 + 1.0 * ds.day;
    this.beam.material.opacity = 0.18 + 0.15 * (1 - ds.day) + 0.04 * Math.sin(this.time * 2);

    if (this.loaded) {
      this.updateEntities(dt, now);
      this.timers.circuit += dt;
      if (this.timers.circuit >= 0.2) {
        this.timers.circuit = 0;
        if (!this.isClient) this.stepCircuits();
      }
      this.timers.quest += dt;
      if (this.timers.quest >= 1) {
        this.timers.quest = 0;
        if (this.nearBeacon(14)) this.questEvent({ type: 'reach_beacon' });
        this.questEvent({ type: 'drones', count: this.drones.length });
        this.questEvent({ type: 'chain', length: longestChain(this.links) });
        // Lamps lit before "First Light" was active never fire a new LAMP_ON change, so poll.
        if (currentQuest(this.quests)?.type === 'lamp' && this.circuit.hasLitLamp((x, y, z) => this.world.getBlockOrNull(x, y, z))) {
          this.questEvent({ type: 'lamp' });
        }
      }
      this.timers.save += dt;
      if (this.timers.save >= 30) {
        this.timers.save = 0;
        this.autosave();
      }
      this.timers.transfer += dt;
      if (this.timers.transfer >= 3) {
        this.timers.transfer = 0;
        for (const t of transferStep(this.hubs, this.links)) this.launchPacket(this.hubs.get(t.from), this.hubs.get(t.to));
      }
    }

    // Selection highlight.
    const t = this.loaded && this.screens.length === 0 ? this.target() : null;
    if (t) {
      this.selection.visible = true;
      this.selection.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
    } else this.selection.visible = false;

    this.net.tick(now, p);
    if (this.hotbarDirty) this.renderHotbar();
    this.timers.info += dt;
    if (this.timers.info >= 0.25) {
      this.timers.info = 0;
      this.updateInfo(ds, t);
    }
  }

  stepCircuits() {
    if (!this.circuit.size) return;
    const changes = this.circuit.step((x, y, z) => this.world.getBlockOrNull(x, y, z));
    for (const c of changes) {
      this.setBlock(c.x, c.y, c.z, c.id);
      if (c.id === B.LAMP_ON) this.questEvent({ type: 'lamp' });
    }
  }

  launchPacket(from, to) {
    if (!from || !to) return;
    const mesh = createPacket();
    this.entityGroup.add(mesh);
    this.packets.push({ mesh, from, to, t: 0 });
  }

  updateEntities(dt, now) {
    const p = this.player;
    const t = this.time;
    // Drops: fall, spin, magnet pickup.
    for (const d of [...this.drops.values()]) {
      d.age += dt;
      if (!this.world.isSolid(Math.floor(d.x), Math.floor(d.y - 0.2), Math.floor(d.z))) {
        d.vy -= 20 * dt;
        d.y += d.vy * dt;
      } else {
        d.vy = 0;
        d.y = Math.floor(d.y - 0.2) + 1.2;
      }
      const dd = Math.hypot(d.x - p.pos.x, d.y - (p.pos.y + 0.8), d.z - p.pos.z);
      if (dd < 1.6) {
        const got = this.pickupDrop(d.id);
        if (got) {
          this.addItem(got.item, got.count);
          sfx.pickup();
        }
        continue;
      }
      if (d.age > 300 || d.y < -10) {
        this.pickupDrop(d.id);
        continue;
      }
      d.mesh.position.set(d.x, d.y + Math.sin(t * 3 + d.id) * 0.08, d.z);
      d.mesh.rotation.y = t * 2 + d.id;
    }
    // Swarm.
    const followers = this.drones.filter((d) => d.mode === 'follow');
    const env = {
      t, player: p.pos, drops: this.drops, hubs: this.hubs, index: 0, count: followers.length,
      findOre: (hub) => this.findOre(hub),
      getBlock: (x, y, z) => this.world.getBlock(x, y, z),
      mineBlock: (x, y, z) => {
        const id = this.world.getBlockOrNull(x, y, z);
        if (!MINEABLE.has(id)) return 0;
        this.setBlock(x, y, z, B.AIR);
        return id;
      },
      releaseOre: (x, y, z) => this.oreClaims.delete(x + ',' + y + ',' + z),
      pickupDrop: (id) => this.pickupDrop(id),
      deliverToPlayer: (item) => {
        this.addItem(item.item, item.count);
        sfx.pickup();
      },
      depositToHub: (key, item) => {
        const h = this.hubs.get(key);
        if (h) addToStorage(h.storage, item.item, item.count);
      },
    };
    for (const d of this.drones) {
      env.index = followers.indexOf(d);
      updateDrone(d, dt, env);
      animateDrone(d.mesh, d, t);
    }
    // Wild drones idle-hover near their spawn; prune far ones.
    for (const w of this.wild.values()) {
      w.x = w.home.x + Math.cos(t * 0.5 + w.id) * 1.5;
      w.z = w.home.z + Math.sin(t * 0.5 + w.id) * 1.5;
      w.y = w.home.y + Math.sin(t * 1.3 + w.id) * 0.3;
      animateDrone(w.mesh, w, t);
    }
    this.timers.prune += dt;
    if (this.timers.prune > 2) {
      this.timers.prune = 0;
      const lim = (this.world.renderDistance + 3) * CHUNK;
      for (const [k, w] of this.wild) {
        if (Math.hypot(w.x - p.pos.x, w.z - p.pos.z) > lim) {
          this.entityGroup.remove(w.mesh);
          this.wild.delete(k);
        }
      }
    }
    // Hub packets.
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const k = this.packets[i];
      k.t += dt;
      const f = Math.min(1, k.t);
      k.mesh.position.set(k.from.x + 0.5 + (k.to.x - k.from.x) * f, k.from.y + 1.2 + (k.to.y - k.from.y) * f + Math.sin(f * Math.PI) * 1.5, k.from.z + 0.5 + (k.to.z - k.from.z) * f);
      k.mesh.rotation.y += dt * 5;
      if (f >= 1) {
        this.entityGroup.remove(k.mesh);
        this.packets.splice(i, 1);
      }
    }
    // Remote avatars.
    for (const r of this.remotes.values()) {
      r.mesh.position.lerp(new THREE.Vector3(r.target.x, r.target.y, r.target.z), Math.min(1, dt * 10));
      r.mesh.rotation.y = r.yaw || 0;
    }
  }

  updateInfo(ds, t) {
    const p = this.player.pos;
    const hh = Math.floor(ds.hours);
    const mm = Math.floor((ds.hours - hh) * 60);
    const lines = [
      'GIGATRON VOXEL  ' + this.fps + ' fps',
      'XYZ ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ' + p.z.toFixed(1),
      'Biome: ' + this.gen.biomeAt(p.x, p.z),
      'Grid time ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + (ds.day < 0.3 ? '  (aurora)' : ''),
      'Swarm: ' + this.drones.length + ' drones (' + this.drones.filter((d) => d.mode === 'work').length + ' working), hubs ' + this.hubs.size,
      'Beacon ' + Math.round(Math.hypot(this.gen.beacon.x - p.x, this.gen.beacon.z - p.z)) + ' m',
      (this.creative ? 'Creative' : 'Survival-lite') + (this.player.flying ? ' / flying' : '') + (this.net.active ? '  |  ' + this.net.role + ' ' + this.net.code + ' (' + this.net.playerCount + ' players)' : ''),
    ];
    if (this.debug) lines.push('chunks ' + this.world.chunks.size + ' meshed ' + this.world.meshedCount + ' circuits ' + this.circuit.size + ' draw ' + this.renderer.info.render.calls + ' tris ' + this.renderer.info.render.triangles);
    $('info').textContent = lines.join('\n');
    const label = t ? BLOCKS[t.id].name : '';
    if ($('target').textContent !== label && t) $('target').textContent = label;
    if (!t) $('target').textContent = '';
    this.updateQuestHud();
  }
}

const game = new Game();
// Read-only debug handle used by the headless smoke test.
window.__gigatron = {
  get stats() {
    return {
      running: game.running, loaded: game.loaded, fps: game.fps,
      chunks: game.world?.chunks.size ?? 0, meshed: game.world?.meshedCount ?? 0,
      drones: game.drones?.length ?? 0, quest: game.quests?.index ?? 0,
      triangles: game.renderer.info.render.triangles, net: game.net.role, room: game.net.code,
      remotes: game.remotes?.size ?? 0,
    };
  },
  game,
};
if (!new URLSearchParams(location.search).get('autostart')) game.openScreen('start');
