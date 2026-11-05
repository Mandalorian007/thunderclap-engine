import { Emitter } from '../core/events';
import type { GamepadLike } from './types';

/** Where the move stick lives on a touch screen. */
export type MoveZone = 'left' | 'right' | 'none';

export interface LookTouchOptions {
  /**
   * The half of the attached element where a touch becomes the move stick (`'none'`: every touch
   * looks). Default `'left'`.
   */
  moveZone?: MoveZone;
  /** Stick deadzone as a fraction of `radius` (0..1). Default 0.12. */
  deadzone?: number;
  /** CSS px from the stick's origin to full deflection; the stick clamps there. Default 56. */
  radius?: number;
  /** Radians per CSS px a look touch drags. Default: `LookOptions.sensitivity`. */
  sensitivity?: number;
}

/** Key codes (`KeyboardEvent.code`) that move. No defaults: the game names them. */
export interface LookKeys {
  forward?: readonly string[];
  back?: readonly string[];
  left?: readonly string[];
  right?: readonly string[];
}

export interface LookOptions {
  /** Radians per CSS px of pointer-locked mouse movement. Default 0.0025. */
  sensitivity?: number;
  /** Radians per second at full right-stick deflection. Default 3. */
  padSensitivity?: number;
  /** Flip vertical look (mouse, touch and stick). Default false. */
  invertY?: boolean;
  /** The touch layout. */
  touch?: LookTouchOptions;
  /** Stick deadzone (0..1, radial) for both pad sticks. Default 0.15. */
  padDeadzone?: number;
  /** Which pad; omitted = the first connected one. */
  pad?: number;
  /** Gamepad source. Default `navigator.getGamepads()` (guarded). */
  getGamepads?: () => readonly (GamepadLike | null)[];
  /**
   * Keys that move (read through the linked `Input`'s raw key state; `Look` has no key listener
   * of its own). `forward` is `move.y` +1, `right` is `move.x` +1.
   */
  keys?: LookKeys;
  /** While true everything reads zero and the pointer lock is released. `Input.setLook` replaces it. */
  blocked?: () => boolean;
  /** Clock in ms, for the stick's `dt`. Default `performance.now()`. */
  now?: () => number;
}

/** `Look` events. */
export interface LookEvents {
  /** The pointer lock on the attached element was taken (`true`) or lost (`false`). */
  lockChange: boolean;
}

/** The touch move stick, client CSS px (for drawing it). */
export interface LookStick {
  active: boolean;
  /** Where the finger landed. */
  originX: number;
  originY: number;
  /** Where the finger is now, clamped to `radius` from the origin. */
  x: number;
  y: number;
}

/** Longest gap between two ticks the stick integrates over, seconds. */
const MAX_DT = 0.1;

function defaultGamepads(): readonly (GamepadLike | null)[] {
  try {
    return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    return [];
  }
}

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * First- and third-person look and move. Each tick it reports `look` (yaw and pitch deltas in
 * radians) and `move` (x, y in -1..1) from whichever device the player uses: pointer-locked mouse,
 * a two-zone touch layout (a virtual move stick in one half, look drags anywhere else), the pad's
 * sticks and the move keys. Link it with `input.setLook(look)` so it shares `blocked()`, attaches
 * with `Input.attach` and advances in `Input.update()`.
 *
 * Signs: `look.dx` > 0 turns right, `look.dy` > 0 looks up (`invertY` flips it); `move.x` > 0 is
 * right, `move.y` > 0 is forward. No allocation per tick.
 */
export class Look {
  /** This tick's look delta, radians. */
  readonly look = { dx: 0, dy: 0 };
  /** This tick's move, each axis -1..1, length at most 1. */
  readonly move = { x: 0, y: 0 };
  /** The touch move stick (client CSS px). */
  readonly stick: LookStick = { active: false, originX: 0, originY: 0, x: 0, y: 0 };
  /** True while the attached element holds the pointer lock. */
  locked = false;
  blocked: () => boolean;
  /** Raw key state the move keys are read from; `Input.setLook` installs its own. */
  keyHeld: ((code: string) => boolean) | null = null;

  sensitivity: number;
  padSensitivity: number;
  invertY: boolean;
  moveZone: MoveZone;
  deadzone: number;
  radius: number;
  touchSensitivity: number | undefined;
  padDeadzone: number;
  keys: LookKeys;

  private readonly pad: number | undefined;
  private readonly getGamepads: () => readonly (GamepadLike | null)[];
  private readonly now: () => number;
  private readonly events = new Emitter<LookEvents>();
  private lastTime = Number.NaN;
  private mouseX = 0;
  private mouseY = 0;
  private touchX = 0;
  private touchY = 0;
  private moveId: number | null = null;
  private lookId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;
  private target: HTMLElement | null = null;
  private detachFn: (() => void) | null = null;

  constructor(opts: LookOptions = {}) {
    this.sensitivity = opts.sensitivity ?? 0.0025;
    this.padSensitivity = opts.padSensitivity ?? 3;
    this.invertY = opts.invertY ?? false;
    this.moveZone = opts.touch?.moveZone ?? 'left';
    this.deadzone = opts.touch?.deadzone ?? 0.12;
    this.radius = opts.touch?.radius ?? 56;
    this.touchSensitivity = opts.touch?.sensitivity;
    this.padDeadzone = opts.padDeadzone ?? 0.15;
    this.pad = opts.pad;
    this.keys = opts.keys ?? {};
    this.getGamepads = opts.getGamepads ?? defaultGamepads;
    this.blocked = opts.blocked ?? (() => false);
    this.now = opts.now ?? defaultNow;
  }

  /** Subscribe to `lockChange`. Returns the unsubscriber. */
  on<K extends keyof LookEvents>(type: K, fn: (payload: LookEvents[K]) => void): () => void {
    return this.events.on(type, fn);
  }

  /** Shorthand for `on('lockChange', fn)`. */
  onLockChange(fn: (locked: boolean) => void): () => void {
    return this.events.on('lockChange', fn);
  }

  // ---------------------------------------------------------------- tick

  /** Advance one tick. `Input.update()` calls this when linked; don't call it twice. */
  update(): void {
    const t = this.now();
    const dt = Number.isNaN(this.lastTime)
      ? 0
      : Math.min(MAX_DT, Math.max(0, (t - this.lastTime) / 1000));
    this.lastTime = t;
    const look = this.look;
    const move = this.move;

    if (this.blocked()) {
      look.dx = look.dy = move.x = move.y = 0;
      this.mouseX = this.mouseY = this.touchX = this.touchY = 0;
      this.voidTouches();
      this.release();
      return;
    }

    // Screen y grows downwards; look up is dy > 0. `0 - v` keeps a still pointer at +0.
    const touchSens = this.touchSensitivity ?? this.sensitivity;
    let dx = this.mouseX * this.sensitivity + this.touchX * touchSens;
    const down = this.mouseY * this.sensitivity + this.touchY * touchSens;
    let dy = this.invertY ? down : 0 - down;
    this.mouseX = this.mouseY = this.touchX = this.touchY = 0;

    let mx = 0;
    let my = 0;
    const s = this.stick;
    if (s.active && this.radius > 0) {
      const ox = (s.x - s.originX) / this.radius;
      const oy = (s.originY - s.y) / this.radius;
      mx = deadzoneScale(ox, oy, this.deadzone, 0);
      my = deadzoneScale(ox, oy, this.deadzone, 1);
    }

    const p = this.padState();
    if (p) {
      const a = p.axes;
      const lx = a[0] ?? 0;
      const ly = -(a[1] ?? 0);
      mx += deadzoneScale(lx, ly, this.padDeadzone, 0);
      my += deadzoneScale(lx, ly, this.padDeadzone, 1);
      const rx = a[2] ?? 0;
      const ry = -(a[3] ?? 0);
      const k = this.padSensitivity * dt;
      dx += deadzoneScale(rx, ry, this.padDeadzone, 0) * k;
      // Stick up looks up (dy > 0) unless inverted.
      dy += deadzoneScale(rx, ry, this.padDeadzone, 1) * k * (this.invertY ? -1 : 1);
    }

    const held = this.keyHeld;
    if (held) {
      const k = this.keys;
      mx += anyHeld(held, k.right) - anyHeld(held, k.left);
      my += anyHeld(held, k.forward) - anyHeld(held, k.back);
    }

    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    look.dx = dx;
    look.dy = dy;
    move.x = mx;
    move.y = my;
  }

  private padState(): GamepadLike | null {
    let pads: readonly (GamepadLike | null)[];
    try {
      pads = this.getGamepads();
    } catch {
      return null;
    }
    if (this.pad !== undefined) {
      const p = pads[this.pad];
      return p && p.connected !== false ? p : null;
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected !== false) return p;
    }
    return null;
  }

  // ---------------------------------------------------------------- feed (tests, replays)

  /** Pointer-locked mouse movement, CSS px (`movementX/Y`). The DOM listener feeds it only while locked. */
  mouseMove(dx: number, dy: number): void {
    if (this.blocked()) return;
    this.mouseX += dx;
    this.mouseY += dy;
  }

  /** A touch went down at client (x, y); `inMoveZone` says whether it landed in the move zone. */
  touchDown(id: number, x: number, y: number, inMoveZone: boolean): void {
    // A touch that lands while blocked is ignored until it lifts.
    if (this.blocked()) return;
    if (inMoveZone && this.moveId === null) {
      this.moveId = id;
      const s = this.stick;
      s.active = true;
      s.originX = s.x = x;
      s.originY = s.y = y;
    } else if (this.lookId === null) {
      this.lookId = id;
      this.lookLastX = x;
      this.lookLastY = y;
    }
  }

  touchMove(id: number, x: number, y: number): void {
    if (id === this.moveId) {
      const s = this.stick;
      let ox = x - s.originX;
      let oy = y - s.originY;
      const d = Math.hypot(ox, oy);
      if (d > this.radius && d > 0) {
        ox *= this.radius / d;
        oy *= this.radius / d;
      }
      s.x = s.originX + ox;
      s.y = s.originY + oy;
    } else if (id === this.lookId) {
      this.touchX += x - this.lookLastX;
      this.touchY += y - this.lookLastY;
      this.lookLastX = x;
      this.lookLastY = y;
    }
  }

  touchUp(id: number): void {
    if (id === this.moveId) {
      this.moveId = null;
      this.stick.active = false;
    } else if (id === this.lookId) {
      this.lookId = null;
    }
  }

  /** Drop every touch (blur, hidden tab, blocked). Fingers still down are ignored until lifted. */
  cancelAll(): void {
    this.voidTouches();
    this.mouseX = this.mouseY = this.touchX = this.touchY = 0;
  }

  private voidTouches(): void {
    this.moveId = null;
    this.lookId = null;
    this.stick.active = false;
  }

  // ---------------------------------------------------------------- pointer lock

  /**
   * Ask for the pointer lock on the attached element. Browsers grant it only inside a user
   * gesture, so call this from a click or tap. Resolves with whether the lock is held; never
   * rejects. False when detached, blocked or unsupported.
   */
  async request(): Promise<boolean> {
    const el = this.target;
    if (!el || this.blocked()) return false;
    const doc = el.ownerDocument;
    if (doc.pointerLockElement === el) return true;
    if (typeof el.requestPointerLock !== 'function') return false;
    let settle: (() => void) | null = null;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const done = () => settle?.();
    doc.addEventListener('pointerlockchange', done);
    doc.addEventListener('pointerlockerror', done);
    const timer = setTimeout(done, 1000);
    try {
      const r = el.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).then(done, done);
      }
      await settled;
    } catch {
      // Unsupported or refused synchronously.
    } finally {
      clearTimeout(timer);
      doc.removeEventListener('pointerlockchange', done);
      doc.removeEventListener('pointerlockerror', done);
    }
    this.syncLock();
    return this.locked;
  }

  /** Give the pointer lock back, if the attached element holds it. */
  release(): void {
    const el = this.target;
    if (!el) return;
    const doc = el.ownerDocument;
    if (doc.pointerLockElement === el && typeof doc.exitPointerLock === 'function') {
      doc.exitPointerLock();
    }
  }

  private syncLock(): void {
    const el = this.target;
    const now = el !== null && el.ownerDocument.pointerLockElement === el;
    if (now === this.locked) return;
    this.locked = now;
    this.events.emit('lockChange', now);
  }

  // ---------------------------------------------------------------- DOM

  /**
   * Listen on the element: touch pointers (zones), pointer-locked mouse movement and the lock's
   * change and error events. `Input.setLook` calls this from `Input.attach`.
   */
  attach(target: HTMLElement): void {
    this.detach();
    this.target = target;
    const doc = target.ownerDocument;
    const win = doc.defaultView ?? window;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      let inZone = false;
      if (this.moveZone !== 'none') {
        const r = target.getBoundingClientRect();
        const left = e.clientX < r.left + r.width / 2;
        inZone = this.moveZone === 'left' ? left : !left;
      }
      this.touchDown(e.pointerId, e.clientX, e.clientY, inZone);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') this.touchMove(e.pointerId, e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') this.touchUp(e.pointerId);
    };
    const onMouse = (e: MouseEvent) => {
      if (doc.pointerLockElement === target) this.mouseMove(e.movementX, e.movementY);
    };
    const onLock = () => this.syncLock();
    const onBlur = () => this.cancelAll();
    const onVisibility = () => {
      if (doc.visibilityState === 'hidden') this.cancelAll();
    };

    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
    doc.addEventListener('mousemove', onMouse);
    doc.addEventListener('pointerlockchange', onLock);
    doc.addEventListener('pointerlockerror', onLock);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibility);
    this.syncLock();

    this.detachFn = () => {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      doc.removeEventListener('mousemove', onMouse);
      doc.removeEventListener('pointerlockchange', onLock);
      doc.removeEventListener('pointerlockerror', onLock);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
    };
  }

  /** Stop listening, release the lock and drop every touch. */
  detach(): void {
    this.release();
    this.detachFn?.();
    this.detachFn = null;
    this.cancelAll();
    if (this.locked) {
      this.locked = false;
      this.events.emit('lockChange', false);
    }
    this.target = null;
  }
}

/** 1 if any of the codes is held. */
function anyHeld(held: (code: string) => boolean, codes: readonly string[] | undefined): number {
  if (!codes) return 0;
  for (let i = 0; i < codes.length; i++) if (held(codes[i]!)) return 1;
  return 0;
}

/**
 * A stick (x, y) through a radial deadzone, rescaled so the edge of the deadzone is 0 and full
 * deflection 1; returns component `axis` (0 = x, 1 = y). Allocation-free.
 */
function deadzoneScale(x: number, y: number, dz: number, axis: 0 | 1): number {
  const m = Math.hypot(x, y);
  if (m <= dz || m === 0) return 0;
  const clamped = Math.min(1, m);
  const k = (dz >= 1 ? 0 : (clamped - dz) / (1 - dz)) / m;
  return (axis === 0 ? x : y) * k;
}
