// Headless browser smoke test: loads the game, checks for console errors, captures screenshots.
// Usage: node tools/smoke.mjs [url]   (CHROME_PATH env var overrides the browser binary)
import { chromium } from 'playwright-core';
import { startServer } from './serve.mjs';
import { mkdir } from 'node:fs/promises';

const port = 8765;
let server = null;
let base = process.argv[2];
if (!base) {
  server = await startServer(port);
  base = `http://localhost:${port}/`;
}
const outDir = new URL('../docs/', import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
const external = [];
page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });

await page.goto(base, { waitUntil: 'load' });
await page.waitForSelector('#btn-new');
await page.screenshot({ path: outDir + 'screenshot-title.png' });
await page.fill('#new-seed', 'gigatron');
await page.click('#btn-new');
await page.waitForFunction(() => window.__gigatron?.stats.loaded, null, { timeout: 60000 });
// Let chunks stream in, walk a few steps, then fly to a vantage point overlooking the Gigatron beacon.
await page.waitForTimeout(3000);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
const walked = await page.evaluate(() => ({ ...window.__gigatron.game.player.pos }));
await page.evaluate(() => {
  const g = window.__gigatron.game;
  const b = g.gen.beacon;
  g.creative = true;
  g.player.flying = true;
  Object.assign(g.player.pos, { x: b.x + 0.5 + 6, y: b.y + 9, z: b.z + 0.5 + 19 });
  g.player.yaw = Math.atan2(6, 19);
  g.player.pitch = -0.12;
  g.time = 90;
  for (let i = 0; i < 2; i++) g.spawnDrone(g.player.pos.x, g.player.pos.y + 1, g.player.pos.z);
});
await page.waitForTimeout(9000);
const stats = await page.evaluate(() => window.__gigatron.stats);
await page.screenshot({ path: outDir + 'screenshot-gameplay.png' });

// Quest progression: approach the beacon (quest 1) with two drones in the swarm (quest 2).
const quest = await page.evaluate(async () => {
  const g = window.__gigatron.game;
  const b = g.gen.beacon;
  Object.assign(g.player.pos, { x: b.x + 0.5 + 3, y: b.y + 3, z: b.z + 0.5 - 4 });
  await new Promise((r) => setTimeout(r, 2500));
  return window.__gigatron.stats.quest;
});

// Place a small circuit in front of the player and check that the lamp lights.
const circuit = await page.evaluate(async () => {
  const g = window.__gigatron.game;
  const p = g.player.pos;
  const x = Math.floor(p.x) + 2;
  const z = Math.floor(p.z);
  const y = g.gen.heightAt(x, z) + 1;
  g.setBlock(x, y, z, 17);       // node
  g.setBlock(x + 1, y, z, 15);   // wire
  g.setBlock(x + 2, y, z, 20);   // lamp
  await new Promise((r) => setTimeout(r, 800));
  return { lamp: g.world.getBlock(x + 2, y, z), wire: g.world.getBlock(x + 1, y, z) };
});

// Night shot to show the aurora sky and glowing blocks.
await page.evaluate(() => {
  const g = window.__gigatron.game;
  const b = g.gen.beacon;
  g.time = 600 * 0.7;
  Object.assign(g.player.pos, { x: b.x + 0.5 - 10, y: b.y + 7, z: b.z + 0.5 + 20 });
  g.player.yaw = Math.atan2(-10, 20);
  g.player.pitch = 0.05;
});
await page.waitForTimeout(1500);
await page.screenshot({ path: outDir + 'screenshot-night.png' });

// Save/load round trip in real IndexedDB.
const saved = await page.evaluate(async () => {
  const g = window.__gigatron.game;
  await g.save();
  const back = await g.store.load(g.name);
  return { name: back?.name, edits: back ? [...back.edits.values()].reduce((n, m) => n + m.size, 0) : 0 };
});

console.log(JSON.stringify({ walked, stats, quest, circuit, saved, errors, external }, null, 2));
await browser.close();
server?.close();
const ok = errors.length === 0 && external.length === 0 && stats.loaded && stats.meshed > 0 && quest >= 2 && circuit.lamp === 21 && saved.edits >= 3;
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
