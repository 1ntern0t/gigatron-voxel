# Security Policy

GIGATRON: Swarm Frontier is a free, client-side browser game: no accounts, no payments, no ads, no
analytics or tracking. Single-player saves live only in your browser (IndexedDB, falling back to
localStorage). The optional **Public Lobby** is a small server (`tools/lobby-host.mjs`) that the
owner runs; this document covers it too.

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/1ntern0t/gigatron-voxel/security/advisories/new)
rather than opening a public issue. Include steps to reproduce and the browser you used.
You can expect an acknowledgement within a few days.

## Threat model

### Assets
- Players' browsers (the page must not be breakable or exploitable by other players or a hostile host).
- The shared lobby world and other players' builds (griefing).
- Lobby availability (denial of service against a home machine).
- The host machine (the lobby must not expose files or run attacker input).
- Players' privacy (no tracking; no IP addresses shown to other players or written to logs).

### Adversaries
- A hostile **player**: modified client, scripts, many tabs/connections, spam, griefing, impersonation.
- A hostile **host** of a private room (P2P): sends malformed or oversized messages to clients.
- An **internet scanner** hitting the lobby's HTTP/WebSocket port.

### Controls
- **Authoritative server.** Clients only send intents (`hello`, `state`, `edit`, `chat`, `quest`,
  `probe`). Every message is size-checked *before* parsing (2 KB; the WebSocket `maxPayload` closes
  bigger frames with 1009), then strictly shape-checked (`src/core/protocol.js`). Unknown or malformed
  messages are dropped and counted; repeat offenders are disconnected.
- **Edits** are checked for reach (distance from the player's server-side position), protected regions
  (spawn plaza, Gigatron Beacon), unbreakable/forbidden blocks and survival inventory, and rate-limited
  by token buckets (messages, edits, chat). WARDEN escalates (warn → throttle → mute → kick → session
  ban) and can roll back a griefer's edits (`src/core/bots/warden.js`; every rule has a test in
  `test/warden.test.js`).
- **Movement:** a per-player speed budget and hover/flight detection; impossible moves are corrected
  and repeated violations kicked. Lobby mode is survival (no creative flight).
- **Identity:** no accounts. Names are sanitized, made unique, `[BOT]` is stripped and bot/staff names
  (WARDEN, SPARK, HIVE, admin, ...) are reserved, so nobody can impersonate a bot. Chat strips control
  and bidi-override characters and is rendered with `textContent` only.
- **Saved scores:** a random 128-bit resume token per browser (localStorage). The server stores only a
  SHA-256 hash, refuses a token already in use by a connected player, expires entries after 30 days
  and caps the table at 5000. A stolen token can at worst claim that one score; it grants nothing else.
- **Connection limits:** per-IP concurrent connection cap (default 4) and attempt rate limit (HTTP 429),
  ping/pong liveness, slow consumers (>4 MB buffered) are dropped, player cap (default 24).
- **Privacy:** IPs are only used in memory as a *salted hash* (salt regenerated each start) for limits
  and bans; incident logs contain names, rules and coordinates, never IPs. Players in the lobby cannot
  see each other's IPs (unlike private P2P rooms).
- **Host machine:** binds to `127.0.0.1` by default. With `--static` it serves only an allow-list of
  game files (`index.html`, `styles.css`, `src/**.js`, `vendor/**`, ...) - never the data or log
  directories, `package.json`, `.git` or `node_modules` (tested). The world file is parsed as data and
  schema-checked; no user input is executed. The host runs as an unprivileged user and needs no secrets.
- **Clients vs. hostile hosts:** everything a host sends is validated by `validateHostMessage` before
  use (sizes, coordinates, block ids, list lengths).
- **Content Security Policy:** scripts from the same origin only; network access only to the same
  origin, `0.peerjs.com` (private rooms) and WebSocket endpoints (`wss:`, localhost).

### Known gaps / residual risk
- **No accounts** means bans are per session and per hashed IP: a determined griefer can come back
  from a new IP. WARDEN's rollback limits the damage; the owner can restart with a fresh world if needed.
- **`--trust-proxy`** trusts `CF-Connecting-IP`/`X-Forwarded-For`. Only use it behind a proxy or tunnel
  that sets those headers, otherwise clients can spoof their IP for rate limiting.
- **DDoS:** a home connection cannot absorb a volumetric attack. A tunnel/proxy (e.g. Cloudflare) helps.
- **Private P2P rooms** expose IP addresses between peers and depend on the public PeerJS server.
- **Movement checks** are heuristics; a careful cheater can still move a little faster than normal.

## Supported versions

Only the latest `main` branch (deployed to GitHub Pages) is supported.
