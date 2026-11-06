import { Emitter } from '../core/events';
import type { GyroSource } from './gyro';
import { type StickOptions, shapeStick } from './input';
import {
  createPointerDispatcher,
  eventTime,
  POINTER_PRIORITY,
  type PointerConsumer,
  type PointerDispatcher,
  type PointerRecord,
} from './pointer-dispatch';
import type { GamepadLike, PointerTransform } from './types';

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

/** Which pad control zooms. */
export type LookZoomPad = 'rightStickY' | 'shoulders' | 'none';

/**
 * How the mouse (and pen) look (ws/input-3). `'locked'`: pointer-locked `movementX/Y` after
 * `request()`. `'orbit'`: a button-down drag on the attached element turns the view at the same
 * `sensitivity`, no lock is ever requested, and the drag never reaches the linked `Gestures`.
 */
export type LookMode = 'locked' | 'orbit';

export interface LookZoomOptions {
  /** The mouse wheel zooms (one notch, 100 px or `stepPx`, is 1). Default true. */
  wheel?: boolean;
  /**
   * A second finger beside a look drag pinches: the change in finger distance over `stepPx` is
   * the zoom. Default true.
   */
  pinch?: boolean;
  /**
   * `'rightStickY'`: the right stick's vertical axis zooms (`PAD_ZOOM_PER_S` units per second at
   * full deflection) and no longer pitches the look. `'shoulders'`: the shoulder buttons (standard
   * mapping 4 and 5) read -1 and +1 per tick while held. Default `'none'`.
   */
  pad?: LookZoomPad;
  /** CSS px per zoom unit for the wheel (`deltaMode` pixels) and the pinch. Default 100. */
  stepPx?: number;
}

export interface LookOptions {
  /** The zoom axis (`Look.zoom`). Default: wheel and pinch on, pad `'none'`. */
  zoom?: LookZoomOptions;
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
  /**
   * A mouse (or pen) `pointerdown` on the attached element while the lock is not held calls
   * `request()`, so the first click into the game locks the pointer and, after the player
   * presses Escape, the next click locks it again. Touches never lock. Blocked, nothing is
   * requested. Default false: the game calls `request()` from its own click handler.
   */
  lockOnFirstClick?: boolean;
  /**
   * `'locked'` (default) or `'orbit'` (see `LookMode`). In orbit mode `lockOnFirstClick` is
   * ignored (with one warning) and `request()` resolves false without asking. `setMode` switches
   * at runtime.
   */
  mode?: LookMode;
  /** Gyro aim (ws/input-5): its delta is added to the look every tick. See `createGyroSource`. */
  gyro?: GyroSource;
  /** The tap `onTap` reports (ws/input-5). */
  tap?: LookTapOptions;
}

/** `Look.onTap` thresholds (ws/input-5). */
export interface LookTapOptions {
  /** Most CSS px a pointer may travel (summed) and still tap. Default 10, the gestures' pan threshold. */
  maxMove?: number;
  /** Longest press, ms on the look's clock, that still taps. Default 450, the gestures' long press. */
  maxMs?: number;
}

/** A `Look.onTap` listener: (x, y) in the router's units (through the pointer transform). */
export type LookTapListener = (x: number, y: number, device: 'mouse' | 'touch' | 'pen') => void;

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

/** Zoom units per second the right stick reports at full deflection (`zoom.pad: 'rightStickY'`). */
export const PAD_ZOOM_PER_S = 4;

/** Standard-mapping shoulder buttons: left zooms out, right zooms in. */
const SHOULDER_OUT = 4;
const SHOULDER_IN = 5;

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
 * right, `move.y` > 0 is forward. `zoom` > 0 is closer (wheel up, fingers apart). No allocation
 * per tick.
 */
export class Look {
  /** This tick's look delta, radians. */
  readonly look = { dx: 0, dy: 0 };
  /** This tick's move, each axis -1..1, length at most 1. */
  readonly move = { x: 0, y: 0 };
  /**
   * This tick's zoom: wheel notches, pinch distance over `stepPx`, or stick units; positive is
   * closer. `Follow` reads it when linked.
   */
  zoom = 0;
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
  zoomWheel: boolean;
  zoomPinch: boolean;
  zoomPad: LookZoomPad;
  zoomStepPx: number;
  /** Gyro aim added to the look each tick (`LookOptions.gyro`), or null. */
  gyro: GyroSource | null;
  /** `onTap` thresholds. */
  tapMaxMove: number;
  tapMaxMs: number;
  /**
   * Client → game-space mapping for `onTap` coordinates; `Input.setLook` and
   * `Input.setPointerTransform` keep it in step with the input's. `null`: the dispatcher's units.
   */
  pointerTransform: PointerTransform | null = null;

  private readonly tapFns: LookTapListener[] = [];
  /** The pointer that may still tap, or null. */
  private tapId: number | null = null;
  private tapDevice: 'mouse' | 'touch' | 'pen' = 'mouse';
  private tapAt = 0;
  private tapLastX = 0;
  private tapLastY = 0;
  private tapTravel = 0;
  private readonly gyroOut = { dx: 0, dy: 0 };
  private readonly stickOut: [number, number] = [0, 0];
  private readonly stickOpts: StickOptions = { deadzone: 0, shape: 'scaledRadial' };
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
  private pinchId: number | null = null;
  private pinchX = 0;
  private pinchY = 0;
  private pinchDist = 0;
  private zoomAcc = 0;
  private target: HTMLElement | null = null;
  private detachFn: (() => void) | null = null;
  private readonly lockOnFirstClick: boolean;
  private modeValue: LookMode;
  private warnedLockOnFirstClick = false;
  /** The orbit drag in progress (client CSS px), or NaN when none. */
  private orbitX = Number.NaN;
  private orbitY = Number.NaN;
  /**
   * True once a linked `Input` feeds the orbit drag through its own pointer feed (so the drag is
   * recorded and replayed); the DOM listener here then leaves mouse and pen alone. Set by
   * `Input.setLook`.
   */
  orbitFromInput = false;

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
    this.zoomWheel = opts.zoom?.wheel ?? true;
    this.zoomPinch = opts.zoom?.pinch ?? true;
    this.zoomPad = opts.zoom?.pad ?? 'none';
    this.zoomStepPx = opts.zoom?.stepPx ?? 100;
    this.getGamepads = opts.getGamepads ?? defaultGamepads;
    this.blocked = opts.blocked ?? (() => false);
    this.now = opts.now ?? defaultNow;
    this.lockOnFirstClick = opts.lockOnFirstClick ?? false;
    this.modeValue = opts.mode ?? 'locked';
    this.gyro = opts.gyro ?? null;
    this.tapMaxMove = opts.tap?.maxMove ?? 10;
    this.tapMaxMs = opts.tap?.maxMs ?? 450;
  }

  /**
   * Call `fn` on a tap (ws/input-5): a primary-button press and release that travels at most
   * `tap.maxMove` px within `tap.maxMs`, on a pointer the look took (an orbit-mode mouse or pen,
   * a look-drag touch) or, in locked mode, on any pointer over the attached element except the
   * move-stick touch. A second finger landing cancels it. (x, y) are in the router's units (the
   * pointer transform's game space). Returns the remover.
   */
  onTap(fn: LookTapListener): () => void {
    this.tapFns.push(fn);
    return () => {
      const i = this.tapFns.indexOf(fn);
      if (i >= 0) this.tapFns.splice(i, 1);
    };
  }

  /** The look mode (`LookOptions.mode`); change it with `setMode`. */
  get mode(): LookMode {
    return this.modeValue;
  }

  /**
   * Switch between pointer-locked and orbit look at runtime. Into orbit the lock is released;
   * into locked a drag in progress ends (the game asks for the lock from its next click).
   */
  setMode(mode: LookMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    if (mode === 'orbit') this.release();
    else this.orbitUp();
  }

  /** True when the look takes mouse and pen pointers for itself (orbit mode), so gestures must not. */
  claimsPointer(device: 'mouse' | 'touch' | 'pen'): boolean {
    return this.modeValue === 'orbit' && device !== 'touch';
  }

  /** True while an orbit drag is in progress. */
  get orbiting(): boolean {
    return !Number.isNaN(this.orbitX);
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
      look.dx = look.dy = move.x = move.y = this.zoom = 0;
      this.mouseX = this.mouseY = this.touchX = this.touchY = this.zoomAcc = 0;
      // The gyro's turn while blocked is dropped, not saved up.
      this.gyro?.take(this.gyroOut);
      this.tapId = null;
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
    let zoom = this.zoomAcc;
    this.zoomAcc = 0;

    const g = this.gyro;
    if (g) {
      const o = g.take(this.gyroOut);
      dx += o.dx;
      dy += o.dy;
    }

    let mx = 0;
    let my = 0;
    const s = this.stick;
    // Sticks go through `shapeStick` (scaled radial, the same numbers as before ws/input-5).
    const so = this.stickOut;
    const opts = this.stickOpts;
    if (s.active && this.radius > 0) {
      const ox = (s.x - s.originX) / this.radius;
      const oy = (s.originY - s.y) / this.radius;
      opts.deadzone = this.deadzone;
      shapeStick(ox, oy, so, opts);
      mx = so[0];
      my = so[1];
    }

    const p = this.padState();
    if (p) {
      const a = p.axes;
      const lx = a[0] ?? 0;
      const ly = -(a[1] ?? 0);
      opts.deadzone = this.padDeadzone;
      shapeStick(lx, ly, so, opts);
      mx += so[0];
      my += so[1];
      const rx = a[2] ?? 0;
      const ry = -(a[3] ?? 0);
      const k = this.padSensitivity * dt;
      shapeStick(rx, ry, so, opts);
      dx += so[0] * k;
      const zp = this.zoomPad;
      if (zp === 'rightStickY') {
        // The stick's vertical axis is the zoom, so the look pitches only from other devices.
        zoom += so[1] * PAD_ZOOM_PER_S * dt;
      } else {
        // Stick up looks up (dy > 0) unless inverted.
        dy += so[1] * k * (this.invertY ? -1 : 1);
      }
      if (zp === 'shoulders') {
        const b = p.buttons;
        zoom += (b[SHOULDER_IN]?.pressed ? 1 : 0) - (b[SHOULDER_OUT]?.pressed ? 1 : 0);
      }
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
    this.zoom = zoom;
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

  /**
   * An orbit drag began at client (x, y) (mouse or pen, primary button). Nothing in locked mode.
   * A linked `Input` feeds these from its own `buttonDown`, `pointerAt` and `buttonUp`.
   */
  orbitDown(x: number, y: number): void {
    if (this.modeValue !== 'orbit' || this.blocked()) return;
    this.orbitX = x;
    this.orbitY = y;
  }

  /** The orbit pointer moved to client (x, y): the delta turns the view at `sensitivity`. */
  orbitMove(x: number, y: number): void {
    if (Number.isNaN(this.orbitX)) return;
    if (!this.blocked()) {
      this.mouseX += x - this.orbitX;
      this.mouseY += y - this.orbitY;
    }
    this.orbitX = x;
    this.orbitY = y;
  }

  /** The orbit drag ended. */
  orbitUp(): void {
    this.orbitX = this.orbitY = Number.NaN;
  }

  /** Zoom units (wheel notches) to add to this tick's `zoom`; positive is closer. */
  wheel(units: number): void {
    if (this.blocked() || !this.zoomWheel) return;
    this.zoomAcc += units;
  }

  /**
   * A touch went down at client (x, y); `inMoveZone` says whether it landed in the move zone. A
   * touch that neither takes the stick nor starts a look drag pinches against the drag in progress
   * when `zoom.pinch` is on.
   */
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
    } else if (this.zoomPinch && this.pinchId === null) {
      this.pinchId = id;
      this.pinchX = x;
      this.pinchY = y;
      this.pinchDist = Math.hypot(x - this.lookLastX, y - this.lookLastY);
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
      if (this.pinchId === null) {
        this.touchX += x - this.lookLastX;
        this.touchY += y - this.lookLastY;
      }
      this.lookLastX = x;
      this.lookLastY = y;
      if (this.pinchId !== null) this.pinchMoved();
    } else if (id === this.pinchId) {
      this.pinchX = x;
      this.pinchY = y;
      this.pinchMoved();
    }
  }

  touchUp(id: number): void {
    if (id === this.moveId) {
      this.moveId = null;
      this.stick.active = false;
    } else if (id === this.lookId) {
      // The pinch finger, if any, carries on as the look drag.
      this.lookId = this.pinchId;
      this.lookLastX = this.pinchX;
      this.lookLastY = this.pinchY;
      this.pinchId = null;
    } else if (id === this.pinchId) {
      this.pinchId = null;
    }
  }

  /** The distance between the look and pinch fingers changed: fingers apart is closer. */
  private pinchMoved(): void {
    const d = Math.hypot(this.pinchX - this.lookLastX, this.pinchY - this.lookLastY);
    if (this.zoomStepPx > 0) this.zoomAcc += (d - this.pinchDist) / this.zoomStepPx;
    this.pinchDist = d;
  }

  /** Drop every touch (blur, hidden tab, blocked). Fingers still down are ignored until lifted. */
  cancelAll(): void {
    this.voidTouches();
    this.tapId = null;
    this.orbitUp();
    this.mouseX = this.mouseY = this.touchX = this.touchY = this.zoomAcc = 0;
  }

  private voidTouches(): void {
    this.moveId = null;
    this.lookId = null;
    this.pinchId = null;
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
    if (!el || this.blocked() || this.modeValue === 'orbit') return false;
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
   * Listen on the element: touch pointers (zones, pinch), the wheel (passive), pointer-locked
   * mouse movement and the lock's change and error events. `Input.setLook` calls this from
   * `Input.attach`.
   */
  attach(target: HTMLElement, dispatcher?: PointerDispatcher): void {
    this.detach();
    this.target = target;
    const doc = target.ownerDocument;
    const shared = dispatcher ?? null;
    const d = shared ?? createPointerDispatcher(target);
    this.dispatcher = d;
    const removeConsumer = d.add(this.consumer, POINTER_PRIORITY.look);

    const onMouse = (e: MouseEvent) => {
      if (doc.pointerLockElement === target) this.mouseMove(e.movementX, e.movementY);
    };
    const onWheel = (e: WheelEvent) => {
      // Wheel up (deltaY < 0) is closer. deltaMode 0 = px (stepPx a notch), 1 = lines (3 a
      // notch), 2 = pages (1 a notch).
      const units =
        e.deltaMode === 1
          ? e.deltaY / 3
          : e.deltaMode === 2
            ? e.deltaY
            : e.deltaY / this.zoomStepPx;
      this.wheel(0 - units);
    };
    const onLock = () => this.syncLock();

    target.addEventListener('wheel', onWheel, { passive: true });
    doc.addEventListener('mousemove', onMouse);
    doc.addEventListener('pointerlockchange', onLock);
    doc.addEventListener('pointerlockerror', onLock);
    this.syncLock();

    this.detachFn = () => {
      removeConsumer();
      if (!shared) d.destroy();
      this.dispatcher = null;
      target.removeEventListener('wheel', onWheel);
      doc.removeEventListener('mousemove', onMouse);
      doc.removeEventListener('pointerlockchange', onLock);
      doc.removeEventListener('pointerlockerror', onLock);
    };
  }

  /** The dispatcher the look consumes from while attached (shared or private). */
  private dispatcher: PointerDispatcher | null = null;

  /**
   * The dispatcher consumer: touch pointers feed the zones and pinch; in orbit mode a mouse or
   * pen primary button claims its pointer (so gestures and the router leave it alone) and, unless
   * a linked `Input` feeds the drag, drives the orbit.
   */
  private readonly consumer: PointerConsumer = {
    pointerDown: (p: PointerRecord) => {
      this.tapDown(p);
      if (p.device !== 'touch') {
        if (this.modeValue === 'orbit') {
          if (this.lockOnFirstClick && !this.warnedLockOnFirstClick) {
            this.warnedLockOnFirstClick = true;
            console.warn('[look] lockOnFirstClick is ignored in orbit mode');
          }
          if (p.button === 0) {
            this.dispatcher?.claim(p.id, this.consumer);
            if (!this.orbitFromInput) this.orbitDown(p.clientX, p.clientY);
          }
        } else if (this.lockOnFirstClick && !this.locked) void this.request();
        return;
      }
      let inZone = false;
      if (this.moveZone !== 'none' && this.target) {
        const r = this.target.getBoundingClientRect();
        const left = p.clientX < r.left + r.width / 2;
        inZone = this.moveZone === 'left' ? left : !left;
      }
      this.touchDown(p.id, p.clientX, p.clientY, inZone);
      // The move stick never taps.
      if (p.id === this.moveId && p.id === this.tapId) this.tapId = null;
    },
    pointerMove: (p: PointerRecord) => {
      if (p.id === this.tapId) this.tapMove(p);
      if (p.device === 'touch') this.touchMove(p.id, p.clientX, p.clientY);
      else if (!this.orbitFromInput && p.primary) this.orbitMove(p.clientX, p.clientY);
    },
    pointerUp: (p: PointerRecord) => {
      if (p.id === this.tapId) this.tapUp(p);
      if (p.device === 'touch') this.touchUp(p.id);
      else if (!this.orbitFromInput && p.button <= 0) this.orbitUp();
    },
    pointerCancel: (p: PointerRecord) => {
      if (p.id === this.tapId) this.tapId = null;
      if (p.device === 'touch') this.touchUp(p.id);
      else if (!this.orbitFromInput) this.orbitUp();
    },
    cancelAll: () => this.cancelAll(),
  };

  /** A pointer went down: it may tap if it is the only one and the look takes it (see `onTap`). */
  private tapDown(p: PointerRecord): void {
    if (this.tapId !== null) {
      // A second pointer: neither taps.
      this.tapId = null;
      return;
    }
    if (!p.primary || p.button !== 0 || this.tapFns.length === 0 || this.blocked()) return;
    this.tapId = p.id;
    this.tapDevice = p.device;
    // When the press happened, not when it was handled (ws/input-6).
    this.tapAt = eventTime(p.time, this.now);
    this.tapLastX = p.x;
    this.tapLastY = p.y;
    this.tapTravel = 0;
  }

  private tapMove(p: PointerRecord): void {
    this.tapTravel += Math.hypot(p.x - this.tapLastX, p.y - this.tapLastY);
    this.tapLastX = p.x;
    this.tapLastY = p.y;
    if (this.tapTravel > this.tapMaxMove) this.tapId = null;
  }

  private tapUp(p: PointerRecord): void {
    this.tapMove(p);
    const id = this.tapId;
    this.tapId = null;
    const held = eventTime(p.time, this.now) - this.tapAt;
    if (id === null || held > this.tapMaxMs || this.blocked()) return;
    let x = p.x;
    let y = p.y;
    const t = this.pointerTransform;
    if (t) {
      const m = t(p.x, p.y);
      if (!m) return;
      x = m.x;
      y = m.y;
    }
    const fns = this.tapFns;
    for (let i = 0; i < fns.length; i++) fns[i]!(x, y, this.tapDevice);
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
