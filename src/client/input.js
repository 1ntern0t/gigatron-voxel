// Keyboard/mouse (pointer lock) and touch controls.
export class Input {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers;
    this.keys = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.sensitivity = 1;
    this.touch = { x: 0, y: 0, jump: false, down: false };
    this.locked = false;
    this.enabled = false;
    this.isTouch = matchMedia('(pointer: coarse)').matches;
    this.lastTouch = 0;
    this.lastSpace = 0;

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!e.repeat) this.h.onKey?.(e.code, e);
      if (!this.enabled) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.code === 'Space' && !e.repeat) {
        const now = performance.now();
        if (now - this.lastSpace < 280) this.h.onDoubleJump?.();
        this.lastSpace = now;
      }
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || performance.now() - this.lastTouch < 800) return;
      if (!this.locked) {
        this.requestLock();
        return;
      }
      if (e.button === 0) this.h.onPrimary?.();
      if (e.button === 2) this.h.onSecondary?.();
      if (e.button === 1) this.h.onPick?.();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    });
    addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.h.onWheel?.(Math.sign(e.deltaY));
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.h.onLockChange?.(this.locked);
    });

    if (this.isTouch || 'ontouchstart' in window) this.setupTouch();
  }

  requestLock() {
    if (performance.now() - this.lastTouch < 800) return;
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && p.catch) p.catch(() => {});
    } catch {
      // Pointer lock unsupported (e.g. headless); the game still renders.
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setupTouch() {
    const root = document.getElementById('touch');
    root.hidden = !this.isTouch;
    addEventListener('touchstart', () => {
      this.lastTouch = performance.now();
      if (root.hidden) {
        root.hidden = false;
        this.isTouch = true;
        this.h.onTouchDetected?.();
      }
    }, { capture: true, passive: true });
    const stick = document.getElementById('stick');
    const knob = document.getElementById('knob');
    let stickId = null;
    let lookId = null;
    let lookLast = null;
    let origin = null;
    const R = 50;

    stick.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      stickId = t.identifier;
      const r = stick.getBoundingClientRect();
      origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      e.preventDefault();
    }, { passive: false });

    this.canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        if (lookId === null) {
          lookId = t.identifier;
          lookLast = { x: t.clientX, y: t.clientY };
        }
      }
      e.preventDefault();
    }, { passive: false });

    addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId && origin) {
          let dx = t.clientX - origin.x;
          let dy = t.clientY - origin.y;
          const len = Math.hypot(dx, dy);
          if (len > R) {
            dx = (dx / len) * R;
            dy = (dy / len) * R;
          }
          knob.style.transform = `translate(${dx}px, ${dy}px)`;
          this.touch.x = dx / R;
          this.touch.y = -dy / R;
        } else if (t.identifier === lookId && lookLast) {
          this.lookDX += (t.clientX - lookLast.x) * 2.2;
          this.lookDY += (t.clientY - lookLast.y) * 2.2;
          lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: true });

    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) {
          stickId = null;
          this.touch.x = 0;
          this.touch.y = 0;
          knob.style.transform = '';
        }
        if (t.identifier === lookId) {
          lookId = null;
          lookLast = null;
        }
      }
    };
    addEventListener('touchend', end);
    addEventListener('touchcancel', end);

    const hold = (id, prop) => {
      const el = document.getElementById(id);
      el.addEventListener('touchstart', (e) => { this.touch[prop] = true; e.preventDefault(); }, { passive: false });
      el.addEventListener('touchend', () => { this.touch[prop] = false; });
    };
    hold('t-jump', 'jump');
    hold('t-down', 'down');
    const tap = (id, fn) => document.getElementById(id).addEventListener('touchstart', (e) => { fn(); e.preventDefault(); }, { passive: false });
    tap('t-break', () => this.h.onPrimary?.());
    tap('t-place', () => this.h.onSecondary?.());
    tap('t-use', () => this.h.onKey?.('KeyE'));
    tap('t-cmd', () => this.h.onKey?.('KeyQ'));
    tap('t-fly', () => this.h.onDoubleJump?.());
    tap('t-menu', () => this.h.onKey?.('Escape'));
    tap('t-inv', () => this.h.onKey?.('KeyI'));
  }

  movement() {
    const k = this.keys;
    let forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    forward += this.touch.y;
    right += this.touch.x;
    return {
      forward: Math.max(-1, Math.min(1, forward)),
      right: Math.max(-1, Math.min(1, right)),
      jump: k.has('Space') || this.touch.jump,
      down: k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.down,
      sprint: k.has('ControlLeft') || k.has('ControlRight'),
    };
  }

  consumeLook() {
    const dx = this.lookDX * 0.0022 * this.sensitivity;
    const dy = this.lookDY * 0.0022 * this.sensitivity;
    this.lookDX = 0;
    this.lookDY = 0;
    return [dx, dy];
  }
}
