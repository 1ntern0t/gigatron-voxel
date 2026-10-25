// Tiny synthesized sound effects (Web Audio oscillators; no audio files).
let ctx = null;
let enabled = true;

export function setAudioEnabled(v) {
  enabled = v;
}

function ac() {
  if (!enabled) return null;
  if (!ctx) {
    const C = self.AudioContext || self.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function blip(freq, dur, type = 'square', vol = 0.05, slide = 0) {
  const a = ac();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}

export const sfx = {
  break: () => blip(220, 0.12, 'square', 0.04, -120),
  place: () => blip(520, 0.07, 'triangle', 0.05, 200),
  toggle: () => blip(880, 0.05, 'square', 0.03),
  pickup: () => blip(990, 0.08, 'sine', 0.05, 400),
  quest: () => { blip(660, 0.15, 'triangle', 0.06); setTimeout(() => blip(990, 0.25, 'triangle', 0.06), 120); },
  tame: () => { blip(440, 0.1, 'sine', 0.06, 300); setTimeout(() => blip(880, 0.15, 'sine', 0.05), 90); },
};
