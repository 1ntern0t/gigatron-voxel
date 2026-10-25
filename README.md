# GIGATRON: Swarm Frontier

A free, original voxel sandbox that runs in your browser. Explore a procedurally generated cyber
frontier, build energy circuits, befriend a swarm of drones, and find **Gigatron**, the chrome-and-black
guardian robot with a cyan core.

**Play:** https://1ntern0t.github.io/gigatron-voxel/

![Gigatron at the beacon](docs/screenshot-gameplay.png)

> Inspired by the voxel sandbox genre; not affiliated with any other game. All textures, models and
> sounds are generated procedurally in code. No third-party game assets are used.

Free forever: no ads, no purchases, no accounts, no wallets, no tracking.

## Features

### Working (tested by unit tests and/or a headless-browser run)

- **Infinite chunked terrain** (16×16×96 chunks) generated from a shareable seed, with four biomes:
  Neon Crystal Plains, Data-Stream Rivers, Circuit Canyons and Floating Sky Islands. Ores, crystal
  spires and data-trees are included.
- **Building:** break and place blocks, use a 9-slot hotbar, a 36-slot inventory, and middle-click to pick a block.
  There is a survival-lite mode where breaking a block gives you that block, and a creative mode with infinite blocks and flight.
- **Lighting:** sky light and block light flood-fill, smooth per-vertex lighting with ambient occlusion,
  and emissive blocks (crystals, lamps, cores, live wires) that light up the area around them.
- **Day/night cycle** (10 minutes) with an aurora, stars, sun/moon, data streaks and distance fog.
- **Meshing in Web Workers:** a culled-face mesher with a padded volume makes chunk borders seamless.
  World generation and meshing run in a worker pool. Your own edits are re-meshed on the main thread straight away.
  The default render distance is 8 chunks.
- **Energy grid** (simulated at 5 Hz):
  - Power Node (always on) and Switch
  - Power Wire, which conducts in all 6 directions
  - Lumen Lamp and Energy Door
  - Inverter Gate, for NOT logic and clocks
- **Swarm drones:**
  - Deploy a Drone Pod, or bond with a wild drone (press E; costs 1 Neon Crystal).
  - Followers fly in formation and fetch dropped items for you.
  - Assign a drone to a **Swarm Hub** (press Q next to it) and it mines crystal within 8 blocks.
  - Hubs within 24 blocks of an older hub link into **chains** and forward cargo down the line.
- **Gigatron Beacon:** a spire with a sky-beam and a voxel Gigatron statue, 36–64 blocks from spawn.
  Gigatron gives lore and a line of **5 quests** (find the beacon, build a swarm, light a lamp,
  harvest crystal, build a hub chain), each with rewards.
- **Saving:** autosave every 30 s and when you leave the page, to IndexedDB (falling back to localStorage).
  You can have multiple worlds, copy a seed share link (`?seed=...`) and export a world file.
- **Desktop and mobile controls**, plus an in-game help screen and an in-game Support page.
- **Synthesized sound effects** using WebAudio (no audio files).

### Experimental

- **Peer-to-peer multiplayer** (WebRTC through PeerJS), joined by a 6-character room code. See
  [Multiplayer](#multiplayer-experimental). The session logic is unit-tested against a fake PeerJS,
  and signaling through `0.peerjs.com` was confirmed in a headless browser. A real browser-to-browser
  data channel has **not** been verified end to end yet, because the build machine's sandbox has no
  WebRTC networking.

## Controls

| Desktop | Action |
| --- | --- |
| Click | Capture mouse (pointer lock) |
| W A S D | Move |
| Space | Jump (double-tap toggles flight in creative) |
| Shift | Descend while flying |
| Ctrl | Sprint |
| Left click | Break block |
| Right click | Place block / toggle switch / deploy drone pod |
| 1–9, mouse wheel | Select hotbar slot |
| Middle click | Pick block |
| E | Interact: switches, hubs (collect), wild drones (bond), Gigatron (quests) |
| Q | Swarm command: next to a hub, assign a drone; anywhere else, recall all drones |
| I / H / T / F3 | Inventory / help / chat (multiplayer) / debug overlay |
| Esc | Menu (save, settings, share seed, export) |

**Mobile/touch:** use the left stick to move and drag anywhere else to look. On-screen buttons cover
break, place, use (E), swarm (Q), jump, descend, fly, menu and inventory.

## Multiplayer (experimental)

- **How it works:** one player hosts (Menu → Multiplayer → Host) and gets a room code. Friends enter
  the code to join. The host's world seed and edits are sent to each player, and after that block edits, positions and chat are synced.
- **Topology:** a star around the host, which is authoritative and runs the energy grid. Clients join in creative mode,
  and their copy of the world is not saved locally. Rooms hold up to 8 players.
- **Signaling dependency:** peers find each other through the free public **PeerJS cloud server**
  (`0.peerjs.com`), which also supplies STUN/TURN. That service is run by the PeerJS project, not by
  this game, and may be rate-limited or unavailable. If it can't be reached, multiplayer shows an
  error and **single-player keeps working fully offline**. To run your own signaling server, see
  [peerjs-server](https://github.com/peers/peerjs-server) and change the `Peer` options in
  `src/client/net.js` (and the CSP `connect-src` in `index.html`).
- **Privacy:** WebRTC is peer-to-peer, so **players in a room can see each other's IP addresses**.
  Only share room codes with people you trust.
- **Safety:** the host validates and rate-limits every message, rejects restricted blocks (bedrock,
  the beacon), and renders chat as plain text. There's no moderation beyond that, so if someone misbehaves, leave the room.
- **Known limits:** some strict NATs or firewalls block P2P even with TURN. If the host leaves, the session ends. Drones
  and quests are tracked per player.

## Running locally

```bash
npm install          # only needed for the headless smoke test (playwright-core)
npm run serve        # http://localhost:8080/
```

Any static file server works. Because the game uses ES modules and workers, open it over `http://`, not
`file://`. URL parameters: `?seed=<text or number>` and `?autostart=1`.

## Tests

```bash
npm test             # Node unit tests: world gen, meshing/lighting, circuits, save/load, quests,
                     # swarm logic, protocol validation, multiplayer session logic (fake PeerJS)
npm run smoke        # headless Chrome: loads the game, plays briefly, checks for console errors,
                     # verifies a circuit lights a lamp, quest progress, IndexedDB save, screenshots
npm run test:mp      # two headless browsers host/join through 0.peerjs.com (needs internet + WebRTC)
```

Set `CHROME_PATH` to point the smoke tests at your Chrome or Chromium binary.

## Project layout

```
index.html, styles.css    UI shell (all screens), strict CSP
src/main.js               game loop, UI, gameplay rules
src/worker.js             worker: chunk generation + meshing
src/core/                 pure, testable logic (no DOM)
  worldgen.js noise.js rng.js blocks.js mesher.js circuit.js swarm.js quests.js save.js protocol.js
src/client/               browser-side: rendering, input, audio, storage, networking
vendor/three/             Three.js r186 (MIT), vendored
vendor/peerjs/            PeerJS 1.5.5 (MIT), vendored
test/                     node:test unit tests
tools/                    static server, headless smoke + multiplayer tests
```

## Support the project

GIGATRON: Swarm Frontier is and will stay **free to play**. Nothing is locked behind payment.

If you'd like to help, donations are entirely optional:

- **Donation link: TODO, not set up yet.** An official link will be added here (and on the in-game
  Support page) by the maintainer. Until then, **please don't send money to anyone claiming to collect
  for this project.**
- You can also star the repo, share the game, report bugs, or contribute art, quests and code.

## Credits and licenses

- Game code © 2026 [1ntern0t](https://github.com/1ntern0t) ([@1nternot](https://x.com/1nternot) on X),
  released under the [MIT License](LICENSE).
- [Three.js](https://threejs.org/), © three.js authors, MIT License (`vendor/three/LICENSE`).
- [PeerJS](https://peerjs.com/), © Michelle Bu and Eric Zhang, MIT License (`vendor/peerjs/LICENSE`).
- Signaling and TURN for multiplayer are provided by the public PeerJS cloud service.
- All textures, models and sounds are procedurally generated by this project's own code.

Inspired by the voxel sandbox genre; not affiliated with any other game.
