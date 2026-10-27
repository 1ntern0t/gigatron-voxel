// HIVE [BOT]: swarm guide. Greets new players by name with a tip, answers /help /score /event, and runs
// the repeating shared event "Crystal Rush": crystals spawn in a ring around the plaza, players race to
// mine them, and whoever collects the most wins the cosmetic title "Crystal Champ" for the session.
import { B } from '../blocks.js';
import { QUESTS } from '../quests.js';

export const TIPS = [
  'Left-click breaks, right-click places. Number keys pick a hotbar slot.',
  'Power Node -> Power Wire -> Lumen Lamp lights a lamp. See SPARK\'s plaza for examples.',
  'Every ~10 minutes HIVE starts a Crystal Rush around the plaza - first to grab the most wins a title.',
  'Press T to chat. /score shows the scoreboard, /top the all-time best, /rules the rules, /event the next event.',
  'The plaza and the Gigatron Beacon are protected; build anywhere else and it stays.',
  'Follow the cyan sky-beam to the Gigatron Beacon for the quest line.',
];

export class Hive {
  constructor({ store, center, rng = Math.random, eventEveryMs = 10 * 60000, firstEventMs = 2 * 60000, rushMs = 3 * 60000, ringRadius = 16, crystals = 8 } = {}) {
    this.store = store;
    this.center = center;
    this.rng = rng;
    this.eventEveryMs = eventEveryMs;
    this.firstEventMs = firstEventMs;
    this.rushMs = rushMs;
    this.ringRadius = ringRadius;
    this.crystalCount = crystals;
    this.greetQueue = [];
    this.greeted = 0;
    this.tipIndex = 0;
    this.rush = null;
    this.rushesRun = 0;
    this.nextEventAt = null;
    this.angle = Math.PI;
    this.lastMove = 0;
    this.champions = [];
  }

  attach(a) {
    this.a = a;
    this.peer = a.addLocal('bot-hive', { name: 'HIVE', bot: true, privileged: 'bot', color: 0x6dff9e, pos: this.groundPos(this.center.x - 6, this.center.z) });
    this.peer.title = 'guide';
  }

  groundPos(x, z) {
    return { x, y: this.store.surface(Math.floor(x), Math.floor(z)) + 1, z, yaw: 0, pitch: 0 };
  }

  say(text) {
    this.a.broadcast({ t: 'chat', p: this.peer.id, name: 'HIVE', bot: true, text });
  }

  onJoin(peer) {
    if (peer.bot) return;
    this.greetQueue.push({ id: peer.id, at: this.a.now() + 1500 });
  }

  greet(peer) {
    const tip = TIPS[this.tipIndex++ % TIPS.length];
    const quest = QUESTS[(this.greeted++) % QUESTS.length];
    this.say('Welcome, ' + peer.name + '! ' + tip);
    this.a.tell(peer, 'Quest hint: ' + quest.title + ' - ' + quest.goal + this.eventHint(), 'HIVE');
  }

  eventHint() {
    if (this.rush) return ' A Crystal Rush is running right now!';
    if (this.nextEventAt === null) return '';
    const m = Math.max(1, Math.round((this.nextEventAt - this.a.now()) / 60000));
    return ' Next Crystal Rush in about ' + m + ' min.';
  }

  scoreboard(limit = 5) {
    const rows = [...this.a.peers.values()].filter((p) => p.hello && !p.bot)
      .map((p) => ({ name: p.name, score: this.a.score(p), crystals: p.stats.crystals, placed: p.stats.placed }))
      .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    if (!rows.length) return 'Scoreboard: nobody yet.';
    return 'Scoreboard: ' + rows.slice(0, limit).map((r, i) => (i + 1) + '. ' + r.name + ' ' + r.score + ' pts (' + r.crystals + ' crystals, ' + r.placed + ' blocks)').join('  ');
  }

  onCommand(peer, cmd) {
    if (cmd === 'help') {
      this.a.tell(peer, TIPS.join(' '), 'HIVE');
      return true;
    }
    if (cmd === 'top' && this.a.o.scorebook) {
      this.a.checkpointScores();
      const rows = this.a.o.scorebook.top(5);
      this.a.tell(peer, rows.length ? 'All-time top: ' + rows.map((r, i) => (i + 1) + '. ' + r.name + ' ' + r.score + ' pts').join('  ') : 'All-time top: nobody yet.', 'HIVE');
      return true;
    }
    if (cmd === 'score' || cmd === 'scores' || cmd === 'top') {
      this.a.tell(peer, this.scoreboard(8), 'HIVE');
      return true;
    }
    if (cmd === 'event') {
      this.a.tell(peer, this.rush ? 'Crystal Rush running: ' + this.rush.left + ' crystals left around the plaza.' : 'No event running.' + this.eventHint(), 'HIVE');
      return true;
    }
    return undefined;
  }

  ringPositions() {
    const out = [];
    const base = this.rng() * Math.PI * 2;
    for (let i = 0; i < this.crystalCount; i++) {
      const ang = base + (i / this.crystalCount) * Math.PI * 2;
      const x = Math.round(this.center.x + Math.cos(ang) * this.ringRadius);
      const z = Math.round(this.center.z + Math.sin(ang) * this.ringRadius);
      const y = this.store.surface(x, z) + 1;
      if (y > 0 && this.store.getBlock(x, y, z) === B.AIR) out.push({ x, y, z });
    }
    return out;
  }

  startRush(now) {
    const cells = this.ringPositions();
    const crystals = new Map();
    for (const c of cells) if (this.a.serverEdit('HIVE', c.x, c.y, c.z, B.CRYSTAL)) crystals.set(c.x + ',' + c.y + ',' + c.z, c);
    this.rush = { startedAt: now, endsAt: now + this.rushMs, crystals, left: crystals.size, scores: new Map() };
    this.rushesRun++;
    this.say('CRYSTAL RUSH! ' + crystals.size + ' Neon Crystals just appeared in a ring ' + this.ringRadius + ' blocks around the plaza. Mine the most to win the title Crystal Champ!');
    this.a.broadcast({ t: 'event', kind: 'rush-start', text: 'Crystal Rush! ' + crystals.size + ' crystals around the plaza.' });
  }

  afterEdit(peer, e, prev) {
    if (!this.rush || e.id !== B.AIR || prev !== B.CRYSTAL || peer.bot) return;
    const k = e.x + ',' + e.y + ',' + e.z;
    if (!this.rush.crystals.has(k)) return;
    this.rush.crystals.delete(k);
    this.rush.left--;
    peer.stats.crystals++;
    this.rush.scores.set(peer.id, (this.rush.scores.get(peer.id) || 0) + 1);
    this.a.rosterDirty = true;
    this.say(peer.name + ' grabbed a crystal! ' + (this.rush.left ? this.rush.left + ' left.' : 'That was the last one.'));
    if (this.rush.left <= 0) this.endRush(this.a.now());
  }

  endRush(now) {
    const rush = this.rush;
    this.rush = null;
    for (const c of rush.crystals.values()) if (this.store.getBlock(c.x, c.y, c.z) === B.CRYSTAL) this.a.serverEdit('HIVE', c.x, c.y, c.z, B.AIR);
    let best = 0;
    for (const n of rush.scores.values()) best = Math.max(best, n);
    const winners = [...rush.scores].filter(([, n]) => n === best && n > 0).map(([id]) => this.a.peers.get(id)).filter(Boolean);
    for (const p of this.a.peers.values()) if (!p.bot && p.title === 'Crystal Champ') p.title = '';
    for (const w of winners) w.title = 'Crystal Champ';
    this.champions = winners.map((w) => w.name);
    this.a.rosterDirty = true;
    this.say(winners.length ? 'Crystal Rush over! Crystal Champ: ' + winners.map((w) => w.name).join(', ') + ' (' + best + ' crystals).' : 'Crystal Rush over - nobody grabbed a crystal this time.');
    this.say(this.scoreboard());
    this.a.broadcast({ t: 'event', kind: 'rush-end', text: winners.length ? 'Crystal Champ: ' + winners.map((w) => w.name).join(', ') : 'Crystal Rush over.' });
    this.nextEventAt = now + this.eventEveryMs;
  }

  tick(now) {
    if (this.nextEventAt === null) this.nextEventAt = now + this.firstEventMs;
    while (this.greetQueue.length && this.greetQueue[0].at <= now) {
      const g = this.greetQueue.shift();
      const peer = this.a.peers.get(g.id);
      if (peer) this.greet(peer);
    }
    if (this.rush && now >= this.rush.endsAt) this.endRush(now);
    else if (!this.rush && now >= this.nextEventAt) {
      if (this.a.humans > 0) this.startRush(now);
      else this.nextEventAt = now + 60000; // nobody online: check again in a minute
    }
    if (now - this.lastMove >= 200) {
      const dt = this.lastMove ? (now - this.lastMove) / 1000 : 0.2;
      this.lastMove = now;
      this.angle -= (2.5 * dt) / 7;
      const p = this.groundPos(this.center.x + Math.cos(this.angle) * 7, this.center.z + Math.sin(this.angle) * 7);
      p.yaw = this.angle;
      this.a.localState(this.peer.id, p);
    }
  }
}
