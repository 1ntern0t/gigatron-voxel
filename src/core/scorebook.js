// Scorebook: lets returning players keep their lobby score across disconnects and host restarts
// without accounts. The host hands each player a random resume token (kept only in that browser's
// localStorage); the book stores a HASH of it, so a leaked scores file cannot be used to take over a
// score. Titles stay per-session. Entries expire after `ttlMs` unseen and the book is size-capped.
// Pure: the caller injects `hash(token)` and `randomToken()` (Node crypto in tools/lobby-host.mjs).
export const RESUME_TOKEN_RE = /^[a-f0-9]{32}$/;
const DAY = 86400000;

function cleanStats(s) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1e9) : 0);
  return { placed: n(s?.placed), broken: n(s?.broken), crystals: n(s?.crystals), quests: n(s?.quests) };
}

export function createScorebook({ hash, randomToken, now = () => Date.now(), entries = null, ttlMs = 30 * DAY, maxEntries = 5000 } = {}) {
  const book = new Map();
  if (entries && typeof entries === 'object') {
    for (const [k, e] of Object.entries(entries)) {
      if (typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k) || !e || typeof e !== 'object') continue;
      const seen = Number.isFinite(e.seen) ? e.seen : 0;
      book.set(k, { name: typeof e.name === 'string' ? e.name.slice(0, 16) : '', stats: cleanStats(e.stats), seen });
    }
  }
  let dirty = false;
  const api = {
    get size() { return book.size; },
    get dirty() { return dirty; },
    issue() { return randomToken(); },
    // Returns saved stats for a valid, known token (and refreshes it), else null.
    take(token) {
      if (typeof token !== 'string' || !RESUME_TOKEN_RE.test(token)) return null;
      const e = book.get(hash(token));
      if (!e || now() - e.seen > ttlMs) return null;
      e.seen = now();
      dirty = true;
      return { name: e.name, stats: { ...e.stats } };
    },
    put(token, name, stats) {
      if (typeof token !== 'string' || !RESUME_TOKEN_RE.test(token)) return;
      const k = hash(token);
      book.delete(k); // re-insert so Map order is least-recently-seen first
      book.set(k, { name: String(name || '').slice(0, 16), stats: cleanStats(stats), seen: now() });
      dirty = true;
      api.prune();
    },
    prune() {
      const t = now();
      for (const [k, e] of book) if (t - e.seen > ttlMs) book.delete(k);
      while (book.size > maxEntries) book.delete(book.keys().next().value);
    },
    toJSON() {
      api.prune();
      dirty = false;
      return Object.fromEntries(book);
    },
    // All-time top scores (names only; for /status and HIVE's /top).
    top(limit = 10) {
      return [...book.values()].map((e) => ({ name: e.name, score: e.stats.placed + e.stats.crystals * 10 + e.stats.quests * 5 }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
    },
  };
  return api;
}
