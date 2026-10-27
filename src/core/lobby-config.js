// Public lobby constants shared by the game client and the lobby host. Pure module.
export const LOBBY_SEED_TEXT = 'gigatron-public'; // fixed world seed
// Player cap for the public lobby (humans; the three bots are listed separately). Measured with
// tools/lobby-load.mjs: host CPU is not the limit (<4% of one core at 48), upstream bandwidth is
// (it grows ~N^2: about 1.8 Mbit/s at 24, 3.2 at 32, 7 at 48). 24 fits a typical home upload with
// headroom. Raise it with --cap on a host with more upload. See README "Multiplayer".
export const LOBBY_CAP = 24;
export const ROOM_CAP = 8; // browser-hosted private rooms (the host's own browser relays everything)
export const LOBBY_PROBE_TIMEOUT_MS = 8000;
