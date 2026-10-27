# Changelog

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
