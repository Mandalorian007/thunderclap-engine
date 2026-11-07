/**
 * Pointer sources for the router (`pointer-router.ts`): the `PointerSource` seam, the screen
 * source (mouse, pen, touch from DOM pointer events) and the pad cursor (a virtual pointer moved
 * by a gamepad stick). XR controllers and hands are a later `PointerSource` (see the README).
 */
import type { Gestures } from './gestures';
import {
  createPointerDispatcher,
  POINTER_PRIORITY,
  type PointerConsumer,
  type PointerDispatcher,
  type PointerRecord,
} from './pointer-dispatch';
import { createRay, type Ray, type RayCamera, screenRay } from './rays';
import type { GamepadLike, Hand, PointerTransform } from './types';

/** What made a routed pointer. */
export type PointerDevice = 'mouse' | 'touch' | 'pen' | 'gamepad' | 'xr';

/** XR button state of one controller or hand (pressed or not; the source applies thresholds). */
export interface XrButtons {
  trigger: boolean;
  squeeze: boolean;
  pinch: boolean;
}

/**
 * One pointer at one tick, as a source reports it. The source owns the object and reuses it.
 */
export interface PointerSample {
  /** Unique within its source and stable while the pointer lives (a pointer id, 0, a hand index). */
  key: number;
  device: PointerDevice;
  /** The hand of an XR pointer; `null` for everything else. */
  hand: Hand | null;
  /** World-space ray, `dir` unit length. */
  readonly ray: Ray;
  /** The screen point the ray goes through (camera screen units), or `NaN` for XR pointers. */
  x: number;
  y: number;
  /** Primary button held: mouse 0, a touch or pen contact, the pad cursor's press, XR trigger or pinch. */
  select: boolean;
  /** Secondary button held: mouse 2, the pad cursor's second button, XR squeeze. */
  secondary: boolean;
  /** XR button state; `null` for pointers that are not XR. */
  xr: XrButtons | null;
  /**
   * A replay made this pointer (`Input.replayPointer`; ws/input-11): `PointerRouter.mute` never
   * drops it. Absent or false for real pointers.
   */
  synthetic?: boolean;
}

/**
 * Something that points. The router polls every source once per tick, before hit testing.
 *
 * `poll` returns this tick's live pointers. The source owns the array and the samples and reuses
 * them (no allocation per tick); the router reads them before the next `poll`. A pointer whose
 * `key` is missing from a poll has ended. `camera` is the router's active camera (or `null`):
 * screen sources build their rays through it, world-space sources (XR) ignore it.
 *
 * Optional hooks: `attach`/`detach` when the router attaches to (or leaves) a pointer target.
 */
export interface PointerSource {
  poll(camera: RayCamera | null): readonly PointerSample[];
  /** `dispatcher` is the one the linked `Input` built (ws/input-4); absent when attached alone. */
  attach?(target: HTMLElement, dispatcher?: PointerDispatcher): void;
  detach?(): void;
}

export function createSample(key: number, device: PointerDevice): PointerSample {
  return {
    key,
    device,
    hand: null,
    ray: createRay(),
    x: Number.NaN,
    y: Number.NaN,
    select: false,
    secondary: false,
    xr: null,
    synthetic: false,
  };
}

// ------------------------------------------------------------------------- screen

interface Contact {
  id: number;
  device: 'mouse' | 'touch' | 'pen';
  /** Client CSS px (or target-relative without a transform). */
  cx: number;
  cy: number;
  select: boolean;
  secondary: boolean;
  /** The select button went down since the last poll (a press shorter than a tick still counts). */
  tapped: boolean;
  /** The pointer ended; it is reported once more (its last position), then dropped. */
  gone: boolean;
  /** Ended by a cancel or a hover leaving: dropped without the last report. */
  cancelled: boolean;
  /** Made by a replay (`PointerRecord.synthetic`); see `PointerSample.synthetic`. */
  synthetic: boolean;
  sample: PointerSample;
}

/**
 * Mouse, pen and touch as router pointers. Mouse and pen hover (a pointer while over the
 * target); touch is a pointer only while the finger is down, plus one more tick after it lifts so
 * a tap's tick still sees what it was on. Positions go through the pointer transform into the
 * camera's screen units. With linked `Gestures` that have `magnify`, a single touch points at the
 * gesture's aim (the snapped target's centre, else the lifted aim point) instead of the finger.
 *
 * Feed methods (`pointerDown`, `pointerMove`, `pointerUp`, `pointerLeave`, `pointerCancel`,
 * `cancelAll`) take client coordinates and are public for tests and replays. `synthetic` on
 * `pointerDown`/`pointerMove` marks a replayed pointer (see `PointerSample.synthetic`).
 */
export class ScreenPointers implements PointerSource {
  private transform: PointerTransform | null = null;
  private gestures: Gestures | null = null;
  private readonly contacts: Contact[] = [];
  private readonly out: PointerSample[] = [];
  private detachFn: (() => void) | null = null;
  /**
   * Hides a pointer from `poll` while it reads true: installed by `attach` with a dispatcher as
   * "claimed and not `hoverWhileClaimed`", so an orbit drag or a touch-zone thumb produces no
   * hits until it is released. Public so tests can stand one in.
   */
  claim: ((id: number) => boolean) | null = null;

  setPointerTransform(fn: PointerTransform | null): void {
    this.transform = fn;
    this.ownDispatcher?.setTransform(fn);
  }

  setGestures(g: Gestures | null): void {
    this.gestures = g;
  }

  // ---------------------------------------------------------------- feed

  pointerDown(
    id: number,
    x: number,
    y: number,
    device: Contact['device'] = 'mouse',
    button = 0,
    synthetic = false,
  ): void {
    const c = this.contact(id, device, true, synthetic);
    if (!c) return;
    c.cx = x;
    c.cy = y;
    if (button === 2) c.secondary = true;
    else if (button === 0) {
      c.select = true;
      c.tapped = true;
    }
  }

  pointerMove(
    id: number,
    x: number,
    y: number,
    device: Contact['device'] = 'mouse',
    synthetic = false,
  ): void {
    // Touch is a pointer only while down; mouse and pen hover.
    const c = this.contact(id, device, device !== 'touch', synthetic);
    if (!c) return;
    c.cx = x;
    c.cy = y;
  }

  pointerUp(id: number, x: number, y: number, button = 0): void {
    const c = this.find(id);
    if (!c) return;
    c.cx = x;
    c.cy = y;
    if (button === 2) c.secondary = false;
    else if (button === 0) c.select = false;
    if (c.device === 'touch') c.gone = true;
  }

  /** A hovering mouse or pen left the target. */
  pointerLeave(id: number): void {
    const c = this.find(id);
    if (c && c.device !== 'touch' && !c.select && !c.secondary) c.cancelled = true;
  }

  pointerCancel(id: number): void {
    const c = this.find(id);
    if (c) c.cancelled = true;
  }

  cancelAll(): void {
    for (const c of this.contacts) c.cancelled = true;
  }

  // ---------------------------------------------------------------- poll

  poll(camera: RayCamera | null): readonly PointerSample[] {
    const out = this.out;
    out.length = 0;
    const aim = this.gestures?.aim ?? null;
    let touches = 0;
    for (const c of this.contacts) if (c.device === 'touch' && !c.cancelled) touches++;
    for (let i = 0; i < this.contacts.length; i++) {
      const c = this.contacts[i]!;
      if (c.cancelled) {
        this.contacts.splice(i--, 1);
        continue;
      }
      const s = c.sample;
      let sx: number;
      let sy: number;
      if (aim && c.device === 'touch' && touches === 1) {
        // The magnify aim: where the finger is pointing, not where it covers.
        sx = aim.target ? aim.target.x : aim.x;
        sy = aim.target ? aim.target.y : aim.y;
        if (!aim.inside && !aim.target) sx = Number.NaN;
      } else if (this.transform) {
        const p = this.transform(c.cx, c.cy);
        sx = p ? p.x : Number.NaN;
        sy = p ? p.y : Number.NaN;
      } else {
        sx = c.cx;
        sy = c.cy;
      }
      s.select = c.select || c.tapped;
      s.secondary = c.secondary;
      s.synthetic = c.synthetic;
      c.tapped = false;
      if (c.gone) this.contacts.splice(i--, 1);
      if (this.claim?.(c.id)) continue;
      if (!camera || Number.isNaN(sx) || !screenRay(camera, sx, sy, s.ray)) continue;
      s.x = sx;
      s.y = sy;
      out.push(s);
    }
    return out;
  }

  // ---------------------------------------------------------------- DOM

  /**
   * Listen to pointer events on `target` (the router calls this from its `attach`). Positions are
   * client px with a transform, target-relative px without one.
   */
  attach(target: HTMLElement, dispatcher?: PointerDispatcher): void {
    this.detach();
    const shared = dispatcher ?? null;
    const d = shared ?? createPointerDispatcher(target, { transform: this.transform });
    if (!shared) this.ownDispatcher = d;
    // Sees claimed pointers too (their contacts must end cleanly); `poll` hides them.
    const remove = d.add(this.consumer, POINTER_PRIORITY.screen, true);
    this.claim = (id) => !d.hoverWhileClaimed && d.claimed(id);
    this.detachFn = () => {
      remove();
      if (!shared) d.destroy();
      this.ownDispatcher = null;
      this.claim = null;
    };
  }

  private ownDispatcher: PointerDispatcher | null = null;

  private readonly consumer: PointerConsumer = {
    pointerDown: (p: PointerRecord) =>
      this.pointerDown(p.id, p.x, p.y, p.device, p.button, p.synthetic),
    pointerMove: (p: PointerRecord) => this.pointerMove(p.id, p.x, p.y, p.device, p.synthetic),
    pointerUp: (p: PointerRecord) => this.pointerUp(p.id, p.x, p.y, p.button),
    pointerLeave: (p: PointerRecord) => this.pointerLeave(p.id),
    pointerCancel: (p: PointerRecord) => this.pointerCancel(p.id),
    cancelAll: () => this.cancelAll(),
  };

  detach(): void {
    this.detachFn?.();
    this.detachFn = null;
    this.cancelAll();
  }

  private find(id: number): Contact | null {
    for (const c of this.contacts) if (c.id === id && !c.cancelled && !c.gone) return c;
    return null;
  }

  private contact(
    id: number,
    device: Contact['device'],
    create: boolean,
    synthetic: boolean,
  ): Contact | null {
    const found = this.find(id);
    if (found) found.synthetic = synthetic;
    if (found || !create) return found;
    const c: Contact = {
      id,
      device,
      cx: 0,
      cy: 0,
      select: false,
      secondary: false,
      tapped: false,
      gone: false,
      cancelled: false,
      synthetic,
      sample: createSample(id, device),
    };
    this.contacts.push(c);
    return c;
  }
}

// ------------------------------------------------------------------------- pad cursor

export interface PadCursorOptions {
  /** Gamepad source. Default: `navigator.getGamepads()` (guarded). */
  getGamepads?: () => readonly (GamepadLike | null)[];
  /** Pad index; omitted = any pad (the first deflected stick wins). */
  pad?: number;
  /** Stick axes [x, y]. Default [0, 1] (the left stick). */
  axes?: readonly [number, number];
  /** Stick deflection ignored below this. Default 0.2. */
  deadzone?: number;
  /**
   * Travel per tick at full deflection, as a fraction of the screen's shorter side. Default
   * 0.012 (about 0.7 of it per second at 60 ticks).
   */
  speed?: number;
  /** Standard-mapping button that is the cursor's `select`. Default 0 (A / Cross). */
  selectButton?: number;
  /** Button that is the cursor's `secondary`. Default 2 (X / Square). */
  secondaryButton?: number;
}

function defaultGamepads(): readonly (GamepadLike | null)[] {
  try {
    return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    return [];
  }
}

/**
 * A virtual pointer a gamepad stick moves over the camera's screen, so a pad aims like a mouse.
 * It appears (at the screen centre) the first time its stick passes the deadzone or its select
 * button is pressed, then stays until `hide()`. `x`, `y` are camera screen units.
 */
export class PadCursor implements PointerSource {
  x = Number.NaN;
  y = Number.NaN;
  /** True while the cursor is shown (it reports a pointer). */
  active = false;

  private readonly getGamepads: () => readonly (GamepadLike | null)[];
  private readonly opts: Required<Omit<PadCursorOptions, 'getGamepads' | 'pad'>> & {
    pad: number | undefined;
  };
  private readonly sample = createSample(0, 'gamepad');
  private readonly out: PointerSample[] = [];

  constructor(opts: PadCursorOptions = {}) {
    this.getGamepads = opts.getGamepads ?? defaultGamepads;
    this.opts = {
      pad: opts.pad,
      axes: opts.axes ?? [0, 1],
      deadzone: opts.deadzone ?? 0.2,
      speed: opts.speed ?? 0.012,
      selectButton: opts.selectButton ?? 0,
      secondaryButton: opts.secondaryButton ?? 2,
    };
  }

  /** Put the cursor at a screen point and show it. */
  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.active = true;
  }

  /** Hide the cursor (for example when the mouse moves); the stick shows it again. */
  hide(): void {
    this.active = false;
  }

  poll(camera: RayCamera | null): readonly PointerSample[] {
    const out = this.out;
    out.length = 0;
    const o = this.opts;
    let ax = 0;
    let ay = 0;
    let sel = false;
    let sec = false;
    const pads = this.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      if (o.pad !== undefined && i !== o.pad) continue;
      const p = pads[i];
      if (!p || p.connected === false) continue;
      const x = p.axes[o.axes[0]] ?? 0;
      const y = p.axes[o.axes[1]] ?? 0;
      if (ax === 0 && ay === 0 && Math.hypot(x, y) > o.deadzone) {
        ax = x;
        ay = y;
      }
      if (p.buttons[o.selectButton]?.pressed) sel = true;
      if (p.buttons[o.secondaryButton]?.pressed) sec = true;
    }
    if (!camera) return out;
    const sc = camera.screen;
    if ((ax !== 0 || ay !== 0 || sel) && !this.active) {
      this.active = true;
      if (Number.isNaN(this.x)) {
        this.x = sc.x + sc.width / 2;
        this.y = sc.y + sc.height / 2;
      }
    }
    if (!this.active) return out;
    const step = o.speed * Math.min(sc.width, sc.height);
    this.x = Math.min(sc.x + sc.width, Math.max(sc.x, this.x + ax * step));
    this.y = Math.min(sc.y + sc.height, Math.max(sc.y, this.y + ay * step));
    const s = this.sample;
    s.select = sel;
    s.secondary = sec;
    if (!screenRay(camera, this.x, this.y, s.ray)) return out;
    s.x = this.x;
    s.y = this.y;
    out.push(s);
    return out;
  }
}
