// Small local achievements + session counters. Pure state machine (persisted by the client in settings).
export const ACHIEVEMENTS = [
  { id: 'first-block', title: 'First Block', desc: 'Place your first block.', stat: 'placed', target: 1 },
  { id: 'builder-50', title: 'Builder', desc: 'Place 50 blocks.', stat: 'placed', target: 50 },
  { id: 'architect-500', title: 'Architect', desc: 'Place 500 blocks.', stat: 'placed', target: 500 },
  { id: 'miner-25', title: 'Miner', desc: 'Break 25 blocks.', stat: 'broken', target: 25 },
  { id: 'crystal-5', title: 'Crystal Hunter', desc: 'Collect 5 Neon Crystals.', stat: 'crystals', target: 5 },
  { id: 'social', title: 'Hello, Frontier', desc: 'Send a chat message in multiplayer.', stat: 'chats', target: 1 },
  { id: 'lobby', title: 'Public Face', desc: 'Join the public lobby.', stat: 'lobbyJoins', target: 1 },
  { id: 'lit', title: 'Lamplighter', desc: 'Light a Lumen Lamp.', stat: 'lamps', target: 1 },
  { id: 'champ', title: 'Crystal Champ', desc: 'Win a Crystal Rush.', stat: 'rushWins', target: 1 },
];

const STATS = ['placed', 'broken', 'crystals', 'chats', 'lobbyJoins', 'lamps', 'rushWins'];

export function createAchievementState() {
  return { stats: Object.fromEntries(STATS.map((s) => [s, 0])), unlocked: [] };
}

export function validateAchievementState(raw) {
  const s = createAchievementState();
  if (!raw || typeof raw !== 'object') return s;
  for (const k of STATS) if (Number.isInteger(raw.stats?.[k]) && raw.stats[k] >= 0) s.stats[k] = Math.min(raw.stats[k], 1e9);
  if (Array.isArray(raw.unlocked)) s.unlocked = raw.unlocked.filter((id) => ACHIEVEMENTS.some((a) => a.id === id));
  return s;
}

// Returns { state, unlocked: [achievement...] } without mutating the input.
export function recordStat(state, stat, n = 1) {
  if (!STATS.includes(stat) || !(n > 0)) return { state, unlocked: [] };
  const next = { stats: { ...state.stats, [stat]: (state.stats[stat] || 0) + n }, unlocked: [...state.unlocked] };
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (a.stat === stat && !next.unlocked.includes(a.id) && next.stats[stat] >= a.target) {
      next.unlocked.push(a.id);
      unlocked.push(a);
    }
  }
  return { state: next, unlocked };
}
