# Security Policy

GIGATRON: Swarm Frontier is a static, client-side game. It has no backend, no accounts, no payments
and no analytics. Saves live only in your browser (IndexedDB, falling back to localStorage).

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/1ntern0t/gigatron-voxel/security/advisories/new)
rather than opening a public issue. Include steps to reproduce and the browser you used.
You can expect an acknowledgement within a few days.

## Scope and design notes

- **Content Security Policy**: `index.html` ships a CSP that only allows scripts from the same origin
  and network connections to the PeerJS signaling server (`0.peerjs.com`). All libraries are vendored;
  the page makes no other third-party requests.
- **Multiplayer (experimental)**: peers connect directly over WebRTC. The host is authoritative and
  validates every inbound message (types, coordinate ranges, block ids), rate-limits edits, state and
  chat per peer, refuses restricted blocks, caps rooms at 8 players, and renders chat with
  `textContent` only. Treat rooms like any public P2P session: peers can see your IP address, and you
  should only share room codes with people you trust.
- **Save files**: saves are schema-checked (format, version, coordinate ranges, block ids) when loaded.
- **Donations**: the project has no official donation link yet (see README). Anyone asking for money
  on behalf of this project before a link appears in this repository is not affiliated with it.

## Supported versions

Only the latest `main` branch (deployed to GitHub Pages) is supported.
