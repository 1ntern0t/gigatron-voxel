// End-to-end multiplayer check: two headless browser contexts, host + join via the public PeerJS
// signaling server (0.peerjs.com). Requires internet access. Usage: node tools/mp-test.mjs [url]
import { chromium } from 'playwright-core';
import { startServer } from './serve.mjs';

const port = 8766;
let server = null;
let base = process.argv[2];
if (!base) {
  server = await startServer(port);
  base = `http://localhost:${port}/`;
}
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', ...(process.env.MP_MDNS ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns'])],
});
const errors = [];
async function open(label) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  return page;
}
const host = await open('host');
await host.goto(base + '?autostart=1&seed=mp-test');
await host.waitForFunction(() => window.__gigatron?.stats.loaded, null, { timeout: 60000 });
const code = await host.evaluate(async () => {
  await window.__gigatron.game.hostRoom();
  return document.getElementById('mp-code').value;
});
console.log('room code:', code || '(none)', '| host status:', await host.textContent('#mp-status'));

const guest = await open('guest');
await guest.goto(base);
await guest.waitForSelector('#btn-new');
await guest.evaluate((c) => { document.getElementById('mp-code').value = c; document.getElementById('mp-name').value = 'Guest'; return window.__gigatron.game.joinRoom(); }, code);
let joined = false;
try {
  await guest.waitForFunction(() => window.__gigatron.stats.running && window.__gigatron.stats.net === 'client', null, { timeout: 30000 });
  await guest.waitForFunction(() => window.__gigatron.stats.loaded, null, { timeout: 60000 });
  joined = true;
} catch {
  console.log('guest status:', await guest.textContent('#mp-status'));
}
const result = { code, joined };
if (joined) {
  await host.waitForTimeout(1500);
  result.hostRemotes = await host.evaluate(() => window.__gigatron.stats.remotes);
  result.guestRemotes = await guest.evaluate(() => window.__gigatron.stats.remotes);
  result.sameSeed = await host.evaluate(() => window.__gigatron.game.seed) === await guest.evaluate(() => window.__gigatron.game.seed);
  // Host edit -> guest
  const spot = await host.evaluate(() => {
    const g = window.__gigatron.game;
    const x = Math.floor(g.player.pos.x) + 3, z = Math.floor(g.player.pos.z);
    const y = g.gen.heightAt(x, z) + 1;
    g.setBlock(x, y, z, 10);
    return { x, y, z };
  });
  await guest.waitForTimeout(1500);
  result.hostEditSeenByGuest = await guest.evaluate((s) => window.__gigatron.game.world.getBlock(s.x, s.y, s.z), spot) === 10;
  // Guest edit -> host (validated by host, then relayed)
  await guest.evaluate((s) => window.__gigatron.game.setBlock(s.x, s.y + 1, s.z, 12), spot);
  await host.waitForTimeout(1500);
  result.guestEditSeenByHost = await host.evaluate((s) => window.__gigatron.game.world.getBlock(s.x, s.y + 1, s.z), spot) === 12;
  // Guest tries a forbidden block (beacon) -> host must reject
  await guest.evaluate((s) => window.__gigatron.game.net.sendEdit(s.x, s.y + 2, s.z, 29), spot);
  await host.waitForTimeout(1000);
  result.forbiddenRejected = await host.evaluate((s) => window.__gigatron.game.world.getBlock(s.x, s.y + 2, s.z), spot) !== 29;
  // Chat
  await guest.evaluate(() => window.__gigatron.game.net.sendChat('hello from guest'));
  await host.waitForTimeout(1000);
  result.chatSeen = (await host.textContent('#chatlog').catch(() => '')).includes('hello from guest');
}
result.errors = errors;
console.log(JSON.stringify(result, null, 2));
await browser.close();
server?.close();
const ok = joined && result.hostRemotes === 1 && result.guestRemotes === 1 && result.hostEditSeenByGuest && result.guestEditSeenByHost && result.forbiddenRejected && errors.length === 0;
console.log(ok ? 'MP OK' : 'MP FAILED');
process.exit(ok ? 0 : 1);
