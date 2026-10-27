// WARDEN [BOT]: the lobby's security bot. Watches every validated edit, chat line and movement
// report, and escalates: warn -> throttle/mute (+ rollback of grief) -> kick -> session ban.
// Clearly labelled as a bot in the roster and chat; it never pretends to be a human.
import { B } from '../blocks.js';

export const WARDEN_RULES = Object.freeze({
  breakWindowMs: 10000, breakWarn: 40, breakGrief: 60, // mass breaking
  othersWindowMs: 30000, othersLimit: 6, ownerFreshMs: 30 * 60000, // breaking other players' builds
  protectWindowMs: 30000, protectWarn: 6, protectKick: 30, // hammering protected areas
  spamWindowMs: 5000, spamLimit: 25, rateHitsLimit: 20, // placement spam ("TNT-like" floods)
  cageWindowMs: 20000, cageLimit: 6, // boxing in / building towers over other players or their builds
  chatDupWindowMs: 20000, chatDupLimit: 3, floodWindowMs: 10000, floodLimit: 5, // chat spam
  violationWindowMs: 30000, violationWarn: 3, violationKick: 10, // speed / flight hacks
  muteMs: 60000, longMuteMs: 300000, throttleMs: 60000, rollbackWindowMs: 60000,
  offenseMemoryMs: 5 * 60000, remindEveryMs: 15 * 60000,
});

const RULES_TEXT = 'Lobby rules: be kind; build anywhere outside the protected spawn plaza and Gigatron Beacon; no griefing, cages, spam or hacks. Grief is rolled back automatically. Repeat offenders are kicked, then banned for the session.';

function prune(list, now, windowMs) {
  while (list.length && now - list[0] > windowMs) list.shift();
  return list;
}

export class Warden {
  constructor({ rules = {}, center = null, store = null, log = () => {} } = {}) {
    this.rules = { ...WARDEN_RULES, ...rules };
    this.center = center;
    this.store = store;
    this.logFn = log;
    this.records = new Map();
    this.kicksByKey = new Map();
    this.incidents = [];
    this.lastRemind = 0;
    this.angle = 0;
    this.lastMove = 0;
  }

  attach(a) {
    this.a = a;
    const pos = this.center ? this.groundPos(this.center.x + 6, this.center.z) : null;
    this.peer = a.addLocal('bot-warden', { name: 'WARDEN', bot: true, privileged: 'bot', color: 0xff4d6d, pos });
    this.peer.title = 'security';
  }

  groundPos(x, z) {
    const y = this.store ? this.store.surface(Math.floor(x), Math.floor(z)) + 1 : 40;
    return { x, y, z, yaw: 0, pitch: 0 };
  }

  rec(peer) {
    let r = this.records.get(peer.id);
    if (!r) {
      r = { breaks: [], others: [], protect: [], places: [], rateHits: [], cage: [], chats: [], floods: [], violations: [], offenses: {}, warned: {} };
      this.records.set(peer.id, r);
    }
    return r;
  }

  incident(peer, rule, action, detail = {}) {
    const entry = { t: this.a.now(), peer: peer.id, name: peer.name, key: peer.key, rule, action, ...detail };
    this.incidents.push(entry);
    if (this.incidents.length > 500) this.incidents.shift();
    this.logFn(entry);
    return entry;
  }

  say(text) {
    this.a.broadcast({ t: 'chat', p: this.peer.id, name: 'WARDEN', bot: true, text });
  }

  warnOnce(peer, rule, text, now, windowMs) {
    const r = this.rec(peer);
    if (r.warned[rule] && now - r.warned[rule] < windowMs) return false;
    r.warned[rule] = now;
    this.a.tell(peer, text, 'WARDEN');
    this.incident(peer, rule, 'warn');
    return true;
  }

  // Escalation ladder for a rule: 1st offense = level 1, repeat within offenseMemoryMs = level 2, then kick.
  offense(peer, rule, now) {
    const r = this.rec(peer);
    const o = r.offenses[rule];
    const level = o && now - o.t < this.rules.offenseMemoryMs ? o.level + 1 : 1;
    r.offenses[rule] = { level, t: now };
    return level;
  }

  kick(peer, rule, reason) {
    const kicks = (this.kicksByKey.get(peer.key) || 0) + 1;
    this.kicksByKey.set(peer.key, kicks);
    if (kicks >= 2) {
      this.incident(peer, rule, 'ban', { reason });
      this.say(peer.name + ' was removed for the rest of this session (' + reason + ').');
      this.a.ban(peer.id, reason);
    } else {
      this.incident(peer, rule, 'kick', { reason });
      this.say(peer.name + ' was kicked (' + reason + ').');
      this.a.kick(peer.id, 'Kicked by WARDEN [BOT]: ' + reason);
    }
  }

  griefResponse(peer, rule, reason, now) {
    const n = this.a.rollback(peer.id, now - this.rules.rollbackWindowMs, 'WARDEN');
    const level = this.offense(peer, rule, now);
    this.incident(peer, rule, 'rollback', { restored: n, level });
    if (level >= 2) return this.kick(peer, rule, reason);
    peer.throttleUntil = now + this.rules.throttleMs;
    this.a.tell(peer, 'Rolled back ' + n + ' of your edits (' + reason + '). You are rate-limited for a minute. Next time you will be kicked.', 'WARDEN');
    this.say('Rolled back ' + n + ' edits by ' + peer.name + ' (' + reason + ').');
    this.incident(peer, rule, 'throttle', { ms: this.rules.throttleMs });
  }

  // ----- hooks -----
  onLeave(peer) {
    this.records.delete(peer.id);
  }

  afterEdit(peer, e, prev, now) {
    if (peer.bot || peer.privileged === 'host') return;
    const R = this.rules;
    const r = this.rec(peer);
    if (e.id === B.AIR) {
      prune(r.breaks, now, R.breakWindowMs).push(now);
      if (r.breaks.length >= R.breakGrief) {
        r.breaks.length = 0;
        return this.griefResponse(peer, 'mass-break', 'mass block breaking', now);
      }
      if (r.breaks.length >= R.breakWarn) this.warnOnce(peer, 'mass-break', 'You are breaking blocks very fast. Mass breaking is rolled back.', now, R.breakWindowMs);
      const owner = e.ownerBefore;
      if (owner && owner.by !== peer.id && !String(owner.by).startsWith('bot-') && now - owner.t < R.ownerFreshMs && this.a.peers.get(owner.by)?.bot !== true) {
        prune(r.others, now, R.othersWindowMs).push(now);
        if (r.others.length >= R.othersLimit) {
          r.others.length = 0;
          return this.griefResponse(peer, 'grief-others', "breaking other players' builds", now);
        }
        if (r.others.length === 2) this.warnOnce(peer, 'grief-others', 'That build belongs to ' + owner.name + '. Please build your own.', now, R.othersWindowMs);
      }
      return;
    }
    prune(r.places, now, R.spamWindowMs).push(now);
    if (r.places.length >= R.spamLimit) {
      r.places.length = 0;
      return this.spamResponse(peer, now);
    }
    // Caging / towering over another player or over someone else's build.
    let cage = false;
    for (const q of this.a.peers.values()) {
      if (q === peer || q.bot || !q.hello || !q.pos) continue;
      if (Math.hypot(e.x + 0.5 - q.pos.x, e.z + 0.5 - q.pos.z) <= 2 && e.y >= Math.floor(q.pos.y) + 2 && e.y <= q.pos.y + 12) cage = true;
    }
    if (cage) {
      prune(r.cage, now, R.cageWindowMs).push(now);
      if (r.cage.length >= R.cageLimit) {
        r.cage.length = 0;
        return this.griefResponse(peer, 'cage-tower', 'building over other players', now);
      }
    }
  }

  spamResponse(peer, now) {
    const level = this.offense(peer, 'place-spam', now);
    if (level >= 3) return this.kick(peer, 'place-spam', 'block spam');
    peer.throttleUntil = now + this.rules.throttleMs;
    this.a.tell(peer, 'Block spam detected - you are rate-limited for a minute.', 'WARDEN');
    this.incident(peer, 'place-spam', 'throttle', { level });
  }

  onDeny(peer, reason, e, now) {
    if (peer.bot || peer.privileged === 'host') return;
    const R = this.rules;
    const r = this.rec(peer);
    if (reason.startsWith('protected:')) {
      prune(r.protect, now, R.protectWindowMs).push(now);
      if (r.protect.length >= R.protectKick) {
        r.protect.length = 0;
        return this.kick(peer, 'protected-area', 'repeated edits in a protected area');
      }
      if (r.protect.length >= R.protectWarn) this.warnOnce(peer, 'protected-area', 'The spawn plaza and the Gigatron Beacon are protected. Build a little further out!', now, R.protectWindowMs);
    } else if (reason === 'rate' || reason === 'throttled') {
      prune(r.rateHits, now, 10000).push(now);
      if (r.rateHits.length >= R.rateHitsLimit) {
        r.rateHits.length = 0;
        this.spamResponse(peer, now);
      }
    }
  }

  onChatFlood(peer, now) {
    const r = this.rec(peer);
    prune(r.floods, now, this.rules.floodWindowMs).push(now);
    if (r.floods.length >= this.rules.floodLimit) {
      r.floods.length = 0;
      this.mute(peer, 'chat-flood', 'chat flooding', now);
    }
  }

  onChat(peer, text, now) {
    if (peer.bot) return undefined;
    const r = this.rec(peer);
    const norm = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    prune(r.chats, now, this.rules.chatDupWindowMs);
    r.chats.push(now);
    r.chatTexts = (r.chatTexts || []).filter((c) => now - c.t <= this.rules.chatDupWindowMs);
    r.chatTexts.push({ t: now, norm });
    if (norm && r.chatTexts.filter((c) => c.norm === norm).length >= this.rules.chatDupLimit) {
      r.chatTexts = [];
      this.mute(peer, 'chat-spam', 'repeating the same message', now);
      return false;
    }
    return undefined;
  }

  mute(peer, rule, reason, now) {
    const level = this.offense(peer, 'mute', now);
    if (level >= 3) return this.kick(peer, rule, reason);
    const ms = level === 1 ? this.rules.muteMs : this.rules.longMuteMs;
    peer.mutedUntil = now + ms;
    this.a.tell(peer, 'Muted for ' + Math.round(ms / 1000) + ' s (' + reason + ').', 'WARDEN');
    this.incident(peer, rule, 'mute', { ms, level });
  }

  onViolation(peer, kind, info) {
    if (peer.bot) return;
    const now = this.a.now();
    const R = this.rules;
    const r = this.rec(peer);
    prune(r.violations, now, R.violationWindowMs).push(now);
    this.incident(peer, kind, 'reset-position', info);
    if (r.violations.length >= R.violationKick) {
      r.violations.length = 0;
      return this.kick(peer, kind, kind === 'flight' ? 'flying in survival' : 'moving impossibly fast');
    }
    if (r.violations.length >= R.violationWarn) this.warnOnce(peer, kind, kind === 'flight' ? 'Flight is not allowed in the public lobby.' : 'Movement looked impossible - you were moved back. Speed hacks get kicked.', now, R.violationWindowMs);
  }

  onCommand(peer, cmd) {
    if (cmd === 'rules') {
      this.a.tell(peer, RULES_TEXT, 'WARDEN');
      return true;
    }
    return undefined;
  }

  tick(now) {
    if (now - this.lastRemind >= this.rules.remindEveryMs) {
      if (this.lastRemind) this.say('Reminder: griefing is rolled back automatically. Type /rules for the rules, /help for tips.');
      this.lastRemind = now;
    }
    if (this.center && now - this.lastMove >= 200) {
      // Slow patrol around the plaza edge (3 m/s, walking on the ground like a player).
      const dt = this.lastMove ? (now - this.lastMove) / 1000 : 0.2;
      this.lastMove = now;
      this.angle += (3 * dt) / 9;
      const x = this.center.x + Math.cos(this.angle) * 9;
      const z = this.center.z + Math.sin(this.angle) * 9;
      const p = this.groundPos(x, z);
      p.yaw = -this.angle;
      this.a.localState(this.peer.id, p);
    }
  }
}

export { RULES_TEXT };
