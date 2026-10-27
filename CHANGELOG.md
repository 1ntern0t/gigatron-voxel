# Changelog

## Unreleased - multiplayer (2026-10-27)

### Added
- **Public Lobby**: one persistent survival world served by `tools/lobby-host.mjs` over WebSocket.
  - It has a fixed seed, a protected spawn plaza and Beacon, and saves the world atomically every 15 s
    and on shutdown.
  - It exposes `/health` and `/status`.
  - The title screen and the Multiplayer panel show the live status from a real probe (`ONLINE n/24
    players, 3 bots` or `OFFLINE (reason)`). The count is never faked.
  - The game finds the lobby through `lobby.json` or `?lobby=`. `lobby.json` ships empty, so the site
    honestly shows "No public lobby is configured" until the owner points it at a reachable host.
- **Server bots** labelled `[BOT]`:
  - **WARDEN** (security) detects grief, mass breaking, protected-area edits, spam, cage towers, chat
    spam and floods, speed and flight. It escalates from warn to throttle, mute, kick and session ban,
    and can roll back edits. Incidents are logged without IPs.
  - **SPARK** builds and maintains a lit circuit plaza, only inside its plot.
  - **HIVE** greets players, gives tips and quest hints, runs a Crystal Rush about every 10 minutes for
    the *Crystal Champ* title, and posts the scoreboard. It answers `/score`, `/top`, `/event` and `/help`.
- **Saved lobby scores without accounts**: a random resume token is kept in the browser, and the
  server stores only its hash. Scores survive reconnects and server restarts.
- **Session scoreboard**, a roster HUD (`n/CAP players, k bots`), player colors and name tags,
  **achievements** with toasts (9), and a **first-minute onboarding** nudge.
- **24/7 keeper**: `tools/lobby-ensure.sh` (idempotent start), `lobby-supervise.sh` and `lobby-watchdog.sh`.
  - The supervisor restarts the host on crash and adopts an orphaned host.
  - The watchdog runs a deep health check (tick loop, all 3 bots, a real WebSocket probe), kills a
    hung host and restarts the supervisor.
  - Logs are rotated. `tools/lobby-health.mjs [--deep]` checks health from the command line.
- **Load test** (`npm run test:load`) and a measured player cap of 24 (see README).
- Tests:
  - `authority`, `warden` (one per rule), `bots`, `achievements-onboarding`, `scorebook`,
    `lobby-server` (real WebSockets, limits, static allow-list, restart persistence) and `keeper`.
  - `tools/mp-test.mjs` now drives two real browsers through the lobby (22 checks).

### Changed
- The authoritative host logic moved into `src/core/authority.js`, shared by browser-hosted private
  rooms and the lobby. Protocol v2 changes:
  - JSON text frames are size-checked before parsing.
  - The client and host message validators are now separate.
  - Snapshots are batched at 10 Hz.
  - Edits are logged with rollback.
- Client chat no longer carries a name. The host stamps the sender's name, so names cannot be spoofed.
- `package-lock.json` was regenerated. The old lock was stale and listed packages that are no longer
  dependencies. `ws` is the only runtime dependency, and it is used by the lobby host only.

### Fixed
- The deny toast could fail to appear early in a session.
- The browser host's own edits were rejected as "no change".
- SPARK could rebuild its plaza one level higher after a restart.

### Not verified
- Private P2P rooms over real WebRTC. The build machine blocks WebRTC, so the browser test reports
  them as "unavailable".
- Reaching the lobby from the internet. That depends on the owner choosing a tunnel or proxy (see README).

## Unreleased (2026-10-27)

### Fixed
- **"First Light" quest could stall.** The starter kit includes nodes, wires and lamps, so many players
  light a lamp before that quest is active. The quest only listened for a lamp *turning on*, so a lamp
  that was already lit never counted. The 1 s quest check now also credits any lamp that is lit.
- **Block targeting looking straight along an axis.** The voxel raycast computed `0 * Infinity = NaN`
  when the view direction had an exact zero component and the eye sat on a block boundary, so no block
  was targeted. The raycast now lives in `src/core/raycast.js` and treats non-moving axes as never crossed.
- **Worker failures no longer stall chunks forever.** A failed generation job used to leave an empty
  placeholder that was never requested again, and a failed mesh job left the chunk marked as meshing.
  Generation is now retried, and meshing is retried up to 3 times.
- **Chat text strips Unicode bidi overrides** (U+202A–202E, U+2066–2069, LRM/RLM), which could make
  a chat line render backwards.
- `npm run smoke` no longer overwrites the committed `docs/screenshot-*.png`; it writes to
  `artifacts/` unless you pass `--update-screenshots`.

### Performance
- Sky-light seeding skips sky cells that cannot spread light, which gives the same result. It cut
  `computeLight` from about 2.0 ms to 0.7 ms per chunk (Node 20, warm, 25 chunks x 5 runs), and the
  whole light + mesh step from about 3.0 ms to 1.6 ms. That step runs on the main thread for every
  block you place or break, so edits respond faster. `test/light-equivalence.test.js` checks the output
  byte for byte against the original algorithm.
