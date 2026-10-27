// Shared test harness: a public lobby (authority + bots) driven by a fake clock and an in-memory
// transport that speaks the real wire format (JSON strings). Not a test file itself.
import { createLobby } from '../src/core/lobby.js';
import { B } from '../src/core/blocks.js';

export function makeLobby({ spark = false, hive = false, wardenRules = {}, hiveOptions = {}, sparkOptions = {}, cap, scorebook = null } = {}) {
  let t = 1_000_000;
  const out = new Map();
  const closed = [];
  const incidents = [];
  const L = createLobby({
    now: () => t, cap, scorebook,
    send: (id, m) => {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(JSON.parse(JSON.stringify(m)));
    },
    close: (id) => closed.push(id),
    incident: (e) => incidents.push(e),
    wardenRules,
    hiveOptions: hive ? hiveOptions : { firstEventMs: 1e12, ...hiveOptions },
    sparkOptions: spark ? sparkOptions : { placeEveryMs: 1e12, maintainEveryMs: 1e12, pulseEveryMs: 1e12, ...sparkOptions },
  });
  const a = L.authority;
  let n = 0;

  // A build site well outside the protected plaza and away from the beacon.
  const bc = L.world.gen.beacon;
  const dx = L.center.x - bc.x, dz = L.center.z - bc.z;
  const len = Math.hypot(dx, dz) || 1;
  function site(dist = 40, side = 0) {
    const x = Math.round(L.center.x + (dx / len) * dist - (dz / len) * side);
    const z = Math.round(L.center.z + (dz / len) * dist + (dx / len) * side);
    return { x, z, y: L.world.surface(x, z) + 1 };
  }

  function join(name, { key, resume } = {}) {
    const id = 'p' + ++n;
    if (!a.connect(id, { key: key || id })) return { id, refused: true, msgs: () => out.get(id) || [] };
    a.receive(id, JSON.stringify({ t: 'hello', v: 2, name, ...(resume ? { resume } : {}) }));
    const c = {
      id,
      get peer() { return a.peers.get(id); },
      raw: (s) => a.receive(id, s),
      send: (obj) => a.receive(id, JSON.stringify(obj)),
      msgs: () => out.get(id) || [],
      of: (type) => (out.get(id) || []).filter((m) => m.t === type),
      chats: () => (out.get(id) || []).filter((m) => m.t === 'chat').map((m) => m.name + ': ' + m.text),
      edit: (x, y, z, blockId) => c.send({ t: 'edit', x, y, z, id: blockId }),
      chat: (text) => c.send({ t: 'chat', text }),
      state: (x, y, z, fly = false) => c.send({ t: 'state', x, y, z, yaw: 0, pitch: 0, fly }),
      // Test shortcut: place the player directly (movement validation is tested separately).
      teleport: (p) => { a.peers.get(id).pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5, yaw: 0, pitch: 0 }; },
      kicked: () => closed.includes(id),
      leave: () => a.disconnect(id, 'left'),
    };
    return c;
  }

  return {
    L, a, B, out, closed, incidents, site, join,
    get now() { return t; },
    advance(ms) { t += ms; },
    run(ms, step = 50) { for (let e = 0; e < ms; e += step) { t += step; a.tick(t); } },
  };
}
