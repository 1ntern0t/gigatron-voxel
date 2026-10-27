// First-minute onboarding nudges. Pure: given elapsed play time and what the player has done,
// returns the next hint to show (each at most once).
export const NUDGES = [
  { id: 'look', at: 6, unless: 'moved', text: 'Use W A S D to move and the mouse to look around.' },
  { id: 'break', at: 15, unless: 'broken', text: 'Left-click a block to break it.' },
  { id: 'place', at: 28, unless: 'placed', text: 'Right-click to place the block in your hotbar (1-9 to switch).' },
  { id: 'beacon', at: 42, unless: 'beacon', text: 'See the cyan sky-beam? Gigatron waits there with your first quest.' },
  { id: 'lobby', at: 60, unless: 'multiplayer', text: 'Want company? Esc -> Multiplayer -> Public Lobby.' },
];

export function nextNudge(elapsedSec, done, shown) {
  for (const n of NUDGES) {
    if (shown.has(n.id) || elapsedSec < n.at) continue;
    if (done[n.unless]) {
      shown.add(n.id);
      continue;
    }
    shown.add(n.id);
    return n;
  }
  return null;
}
