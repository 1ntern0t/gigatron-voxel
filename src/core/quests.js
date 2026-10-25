// Gigatron Beacon quest line. Pure state machine.
import { B, ITEM_DRONE_POD } from './blocks.js';

export const QUESTS = [
  {
    id: 'signal',
    title: 'Signal in the Static',
    goal: 'Find the Gigatron Beacon. Follow the cyan sky-beam.',
    type: 'reach_beacon',
    target: 1,
    lore: 'I am GIGATRON, warden of this frontier. Long ago the Grid shattered into floating shards. My swarm keeps the light alive. You heard my signal - good. Let us rebuild together.',
    reward: [[B.CRYSTAL, 4], [B.GLASS, 16]],
  },
  {
    id: 'swarm',
    title: 'Swarm Bond',
    goal: 'Have 2 drones in your swarm. Deploy a Drone Pod, or press E near a wild drone while holding a Neon Crystal.',
    type: 'drones',
    target: 2,
    lore: 'Drones are not tools. They are friends who like to be useful. They will gather what you drop and work the crystal seams for you.',
    reward: [[ITEM_DRONE_POD, 1], [B.HUB, 2]],
  },
  {
    id: 'light',
    title: 'First Light',
    goal: 'Light a Lumen Lamp with an energy circuit: Power Node or Switch -> Power Wire -> Lumen Lamp.',
    type: 'lamp',
    target: 1,
    lore: 'Energy flows where wire leads it. Switches give it a will, inverters give it a mind. Light the dark, frontier-builder.',
    reward: [[B.NOT, 4], [B.DOOR, 2], [B.NODE, 2]],
  },
  {
    id: 'harvest',
    title: 'Shard Harvest',
    goal: 'Collect 16 Neon Crystals. Mine them yourself, or place a Swarm Hub, press Q next to it to assign a drone, and press E on the hub to collect.',
    type: 'collect',
    item: B.CRYSTAL,
    target: 16,
    lore: 'Crystal is memory made solid. Each shard you recover is a fragment of the old Grid remembering itself.',
    reward: [[ITEM_DRONE_POD, 1], [B.HUB, 2]],
  },
  {
    id: 'uplink',
    title: 'Uplink Chain',
    goal: 'Build a chain of 2 linked Swarm Hubs (a newer hub within 24 blocks links to an older one and forwards its cargo).',
    type: 'chain',
    target: 2,
    lore: 'A chain of hubs is a nervous system. You have given the frontier a pulse. The swarm is yours to lead. Thank you, friend.',
    reward: [[B.LAMP_OFF, 8], [B.WIRE, 32]],
  },
];

export function createQuestState() {
  return { index: 0, progress: 0, done: [] };
}

export function currentQuest(state) {
  return QUESTS[state.index] ?? null;
}

export function isQuestLineComplete(state) {
  return state.index >= QUESTS.length;
}

// evt: {type:'reach_beacon'} | {type:'drones', count} | {type:'lamp'} |
//      {type:'collect', item, count} | {type:'chain', length}
export function applyQuestEvent(state, evt) {
  const q = currentQuest(state);
  if (!q || !evt || evt.type !== q.type) return { state, completed: null };
  let progress = state.progress;
  switch (q.type) {
    case 'reach_beacon':
    case 'lamp':
      progress = q.target;
      break;
    case 'drones':
      progress = Math.max(progress, Number(evt.count) || 0);
      break;
    case 'chain':
      progress = Math.max(progress, Number(evt.length) || 0);
      break;
    case 'collect':
      if (evt.item !== q.item) return { state, completed: null };
      progress += Math.max(0, Number(evt.count) || 0);
      break;
    default:
      return { state, completed: null };
  }
  if (progress >= q.target) {
    return {
      state: { index: state.index + 1, progress: 0, done: [...state.done, q.id] },
      completed: q,
    };
  }
  return { state: { ...state, progress }, completed: null };
}

export function validateQuestState(raw) {
  if (!raw || typeof raw !== 'object') return createQuestState();
  const index = Number.isInteger(raw.index) ? Math.max(0, Math.min(QUESTS.length, raw.index)) : 0;
  const progress = Number.isFinite(raw.progress) ? Math.max(0, Math.floor(raw.progress)) : 0;
  const ids = new Set(QUESTS.map((q) => q.id));
  const done = Array.isArray(raw.done) ? raw.done.filter((d) => ids.has(d)) : [];
  return { index, progress, done };
}
