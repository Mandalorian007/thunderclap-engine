import type { GestureKind, PointerTransform } from './types';

/** Device of the pointer that made a gesture. */
export type GestureDevice = 'mouse' | 'touch' | 'pen';

/** Phases of a continuous gesture (pan, drag, pinch). */
export type GesturePhase = 'start' | 'move' | 'end' | 'cancel';

/** A point in game space (through the `PointerTransform`). */
export interface GesturePoint {
  /** Game space. When the transform returns `null` (letterbox bars) this holds the last inside position. */
  x: number;
  y: number;
  /** False when the transform returned `null` for this point. */
  inside: boolean;
}

/** `tap`, `doubleTap` and `longPress`: one point, reported on one tick. */
export interface TapGesture extends GesturePoint {
  device: GestureDevice;
}

/** `pan`: one pointer moved past the threshold, or two pointers whose centre moved past it. */
export interface PanGesture extends GesturePoint {
  phase: GesturePhase;
  /** Movement since the previous report, game space. Every `dx` of one pan sums to its total travel from the down point. */
  dx: number;
  dy: number;
  /** Pointers in the pan: 1, or 2 for a two-finger pan. */
  pointers: number;
  device: GestureDevice;
}

/** `drag`: one pointer moved past the threshold. Like a one-pointer pan, with the origin. */
export interface DragGesture extends GesturePoint {
  phase: GesturePhase;
  /** Where the pointer went down, game space. */
  origin: GesturePoint;
  dx: number;
  dy: number;
  device: GestureDevice;
}

/** `pinch`: two pointers. `x`/`y` is their centre. */
export interface PinchGesture extends GesturePoint {
  phase: GesturePhase;
  /** Distance between the pointers now / at the start (1 = unchanged). */
  scale: number;
  /** Change since the previous report (multiply a zoom by it). */
  delta: number;
}

export interface GestureOptions {
  /**
   * CSS px a pointer may move and still be a tap or long-press. Past it the press is a pan and a
   * drag. Default 10.
   */
  panThreshold?: number;
  /** Ms a pointer must stay down (and within `panThreshold`) for a long-press. Default 450. */
  longPressMs?: number;
  /** Most ms from the end of one tap to the start of the next for a double tap. Default 300. */
  doubleTapMs?: number;
  /** Most CSS px between the two taps of a double tap. Default 24. */
  doubleTapDistance?: number;
  /** While true no gesture is reported (see `Gestures`). An `Input` that links this replaces it with its own. */
  blocked?: () => boolean;
  /** Clock in ms. Default `performance.now()`. Tests pass a fake one. */
  now?: () => number;
}

export interface GestureAttachOptions {
  /** Element that receives pointer events (the canvas, or the element wrapping it). */
  pointerTarget: HTMLElement;
  /** Set `touch-action: none` on the target so touch drags don't scroll or zoom. Default true. */
  disableTouchScroll?: boolean;
}

/** What the queues hold for continuous gestures. */
type PanEvent = PanGesture;
type DragEvent = DragGesture;
type PinchEvent = PinchGesture;

interface Contact {
  id: number;
  device: GestureDevice;
  downAt: number;
  /** Client (CSS px). */
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Game space at the down point. */
  origin: GesturePoint;
}

/** One press: from the first pointer down until every pointer is up. */
interface Session {
  contacts: Map<number, Contact>;
  /** First pointer moved past the threshold: a pan and a drag are running. */
  moving: boolean;
  /** A second pointer went down: no tap, long-press or drag for the rest of the session. */
  multi: boolean;
  /** Ignore everything until every pointer is up (blocked, cancelled, a pointer lifted from a pinch). */
  void: boolean;
  longPressed: boolean;
  /** Two-pointer state (CSS px). */
  pinchStartDist: number;
  pinchLastDist: number;
  pinching: boolean;
  /** Centre of the two pointers at the second down, and the last reported centre (game space). */
  centreStartX: number;
  centreStartY: number;
  centreLast: GesturePoint | null;
  twoPanning: boolean;
  /** Last inside game-space position of the one-pointer pan and drag (for `dx`, `dy`). */
  last: GesturePoint | null;
  /** Last reported point of the one-pointer pan and drag (may be outside). */
  at: GesturePoint | null;
}

const DEFAULTS = {
  panThreshold: 10,
  longPressMs: 450,
  doubleTapMs: 300,
  doubleTapDistance: 24,
};

/** Most taps (of one kind) queued for later ticks. */
const MAX_QUEUED = 8;

const CONTINUOUS = ['pan', 'drag', 'pinch'] as const;
type ContinuousKind = (typeof CONTINUOUS)[number];

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Touch and pointer gestures: tap, double tap, long-press, pan, drag and pinch. Feed it pointer
 * events (via `attach` or the public feed methods), call `update()` once per simulation tick,
 * then read this tick's gestures. Thresholds are CSS px; positions are game space through the
 * same `PointerTransform` as `Input`.
 *
 * ```ts
 * const gestures = new Gestures();
 * input.setGestures(gestures);   // shares blocked(), the transform, attach and update()
 * // each tick, after input.update():
 * if (gestures.tap) select(gestures.tap.x, gestures.tap.y);
 * if (gestures.drag?.phase === 'move') moveBy(gestures.drag.dx, gestures.drag.dy);
 * ```
 *
 * Or bind them as actions: `{ select: [{ gesture: 'tap' }], info: [{ gesture: 'longPress' }] }`.
 *
 * Rules:
 * - A tap is a down and up that stays within `panThreshold` and ends before `longPressMs`. A
 *   double tap also reports a tap for each of its two taps.
 * - A long-press fires once, after `longPressMs` within the threshold; no tap follows it.
 * - Moving past the threshold starts a pan and a drag (one pointer) for the rest of the press.
 * - A second pointer cancels the drag (and any tap or long-press) and starts a pinch and a
 *   two-pointer pan. Lifting either ends them; nothing more is reported until every pointer is up.
 * - Discrete gestures that arrive faster than ticks are queued, one per kind per tick. Moves in
 *   one tick are merged; `start` and `end` each get their own tick. While a pan, drag or pinch
 *   runs, every tick reports it (a `move` with no change when nothing moved).
 * - While `blocked()` nothing is reported, the press in progress is dropped, and a pan, drag or
 *   pinch that had started gets one `cancel`, so the game can put things back.
 */
export class Gestures {
  /** This tick's gestures, or `null`. */
  tap: TapGesture | null = null;
  doubleTap: TapGesture | null = null;
  longPress: TapGesture | null = null;
  pan: PanGesture | null = null;
  drag: DragGesture | null = null;
  pinch: PinchGesture | null = null;
  blocked: () => boolean;

  readonly panThreshold: number;
  readonly longPressMs: number;
  readonly doubleTapMs: number;
  readonly doubleTapDistance: number;

  private readonly now: () => number;
  private transform: PointerTransform | null = null;
  private session: Session | null = null;
  /** Last tap, for double taps: client position and end time. */
  private lastTap: { x: number; y: number; at: number } | null = null;
  private lastInside: GesturePoint = { x: 0, y: 0, inside: false };

  /** Taps; `double` marks the second tap of a double tap (reported on the same tick). */
  private readonly taps: { tap: TapGesture; double: boolean }[] = [];
  private readonly longPresses: TapGesture[] = [];
  private readonly pans: PanEvent[] = [];
  private readonly drags: DragEvent[] = [];
  private readonly pinches: PinchEvent[] = [];
  /** Continuous gestures reported as started and not yet ended, with their last report. */
  private readonly running = new Map<ContinuousKind, PanEvent | DragEvent | PinchEvent>();
  /** The session whose long-press has been reported, while its pointer stays down. */
  private longPressSession: Session | null = null;
  private detachFn: (() => void) | null = null;

  constructor(opts: GestureOptions = {}) {
    this.panThreshold = opts.panThreshold ?? DEFAULTS.panThreshold;
    this.longPressMs = opts.longPressMs ?? DEFAULTS.longPressMs;
    this.doubleTapMs = opts.doubleTapMs ?? DEFAULTS.doubleTapMs;
    this.doubleTapDistance = opts.doubleTapDistance ?? DEFAULTS.doubleTapDistance;
    this.blocked = opts.blocked ?? (() => false);
    this.now = opts.now ?? defaultNow;
  }

  /** Install the client → game-space mapping. `null` = identity (relative to the target when attached). */
  setPointerTransform(fn: PointerTransform | null): void {
    this.transform = fn;
  }

  // ---------------------------------------------------------------- queries

  /**
   * True while `kind` drives an action binding: on the tick a tap or double tap is reported;
   * from a long-press until its pointer lifts; on a pan, drag or pinch's `start` and `move` ticks.
   */
  active(kind: GestureKind): boolean {
    switch (kind) {
      case 'tap':
        return this.tap !== null;
      case 'doubleTap':
        return this.doubleTap !== null;
      case 'longPress':
        return this.longPress !== null || this.longPressSession !== null;
      default:
        return this.running.has(kind);
    }
  }

  /** True when `kind` was reported fresh this tick: a new tap, double tap, long-press or `start`. */
  fired(kind: GestureKind): boolean {
    switch (kind) {
      case 'tap':
      case 'doubleTap':
      case 'longPress':
        return this[kind] !== null;
      default:
        return this[kind]?.phase === 'start';
    }
  }

  // ---------------------------------------------------------------- tick

  /** Advance one tick: fire due long-presses and publish one report per kind. */
  update(): void {
    const t = this.now();
    if (this.blocked()) {
      this.clearQueues();
      if (this.session) this.session.void = true;
      this.longPressSession = null;
      this.tap = null;
      this.doubleTap = null;
      this.longPress = null;
      // A pan, drag or pinch that had started is cancelled once; nothing else is reported.
      this.lastTap = null;
      this.pan = this.cancelled('pan');
      this.drag = this.cancelled('drag');
      this.pinch = this.cancelled('pinch');
      this.running.clear();
      return;
    }
    this.checkLongPress(t);
    const tap = this.taps.shift();
    this.tap = tap?.tap ?? null;
    this.doubleTap = tap?.double ? tap.tap : null;
    this.longPress = this.longPresses.shift() ?? null;
    if (this.longPress && this.session?.longPressed && !this.session.void) {
      this.longPressSession = this.session;
    }
    this.pan = this.publish('pan', this.pans, mergePan, idlePan);
    this.drag = this.publish('drag', this.drags, mergePan, idlePan);
    this.pinch = this.publish('pinch', this.pinches, mergePinch, idlePinch);
  }

  /** The `cancel` report for a running `kind` (blocked), or `null`. */
  private cancelled<K extends ContinuousKind>(kind: K): Gestures[K] {
    const last = this.running.get(kind) as Gestures[K] | undefined;
    if (!last) return null as Gestures[K];
    return (
      kind === 'pinch'
        ? { ...last, phase: 'cancel', delta: 1 }
        : { ...last, phase: 'cancel', dx: 0, dy: 0 }
    ) as Gestures[K];
  }

  /**
   * This tick's report for `kind`: the next queued event (consecutive moves merged), or, while
   * the gesture runs with nothing new, the last report as a `move` with no change.
   */
  private publish<E extends PanEvent | DragEvent | PinchEvent>(
    kind: ContinuousKind,
    queue: E[],
    merge: (a: E, b: E) => E,
    idle: (last: E) => E,
  ): E | null {
    let e = queue.shift();
    if (!e) {
      const last = this.running.get(kind) as E | undefined;
      return last ? idle(last) : null;
    }
    if (e.phase === 'move') {
      while (queue[0]?.phase === 'move') e = merge(e, queue.shift() as E);
    }
    if (e.phase === 'end' || e.phase === 'cancel') this.running.delete(kind);
    else this.running.set(kind, e);
    return e;
  }

  private clearQueues(): void {
    this.taps.length = 0;
    this.longPresses.length = 0;
    this.pans.length = 0;
    this.drags.length = 0;
    this.pinches.length = 0;
  }

  // ---------------------------------------------------------------- low-level feed
  // Public so tests, replays and automated playtests can drive gestures without a DOM. Positions
  // are client coordinates (CSS px), run through the transform. `time` defaults to the clock.

  pointerDown(
    id: number,
    clientX: number,
    clientY: number,
    device: GestureDevice = 'touch',
    time = this.now(),
  ): void {
    if (!this.session) {
      if (this.blocked()) return;
      this.session = {
        contacts: new Map(),
        moving: false,
        multi: false,
        void: false,
        longPressed: false,
        pinchStartDist: 0,
        pinchLastDist: 0,
        pinching: false,
        centreStartX: 0,
        centreStartY: 0,
        centreLast: null,
        twoPanning: false,
        last: null,
        at: null,
      };
    }
    const s = this.session;
    if (s.contacts.has(id)) return;
    const contact: Contact = {
      id,
      device,
      downAt: time,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      origin: this.map(clientX, clientY),
    };
    s.contacts.set(id, contact);
    if (s.void || s.contacts.size !== 2) {
      // A third pointer is ignored; it still has to lift before the session ends.
      return;
    }
    // Second pointer: the press becomes a pinch and two-pointer pan.
    s.multi = true;
    this.endOnePointer(s, s.contacts.values().next().value as Contact, 'cancel');
    const [a, b] = [...s.contacts.values()] as [Contact, Contact];
    s.pinchStartDist = Math.max(1, dist(a.lastX, a.lastY, b.lastX, b.lastY));
    s.pinchLastDist = s.pinchStartDist;
    s.centreStartX = (a.lastX + b.lastX) / 2;
    s.centreStartY = (a.lastY + b.lastY) / 2;
    const centre = this.map(s.centreStartX, s.centreStartY);
    s.centreLast = centre;
    s.pinching = true;
    push(this.pinches, { phase: 'start', ...centre, scale: 1, delta: 1 });
  }

  pointerMove(id: number, clientX: number, clientY: number, time = this.now()): void {
    const s = this.session;
    const c = s?.contacts.get(id);
    if (!s || !c || (clientX === c.lastX && clientY === c.lastY)) return;
    c.lastX = clientX;
    c.lastY = clientY;
    if (s.void) return;
    if (s.multi) {
      this.moveTwo(s);
      return;
    }
    if (!s.moving) {
      this.checkLongPress(time);
      if (s.longPressed) return;
      if (dist(c.startX, c.startY, clientX, clientY) <= this.panThreshold) return;
      s.moving = true;
      s.last = c.origin;
      const p = this.map(clientX, clientY);
      this.pushMove(s, c, p, 'start');
      return;
    }
    this.pushMove(s, c, this.map(clientX, clientY), 'move');
  }

  pointerUp(id: number, clientX?: number, clientY?: number, time = this.now()): void {
    const s = this.session;
    const c = s?.contacts.get(id);
    if (!s || !c) return;
    if (clientX !== undefined && clientY !== undefined)
      this.pointerMove(id, clientX, clientY, time);
    s.contacts.delete(id);
    if (this.longPressSession === s) this.longPressSession = null;
    if (!s.void) {
      if (s.multi) {
        this.endTwo(s, 'end');
        s.void = true;
      } else if (s.moving) {
        this.endOnePointer(s, c, 'end');
      } else if (!s.longPressed) {
        if (time - c.downAt >= this.longPressMs) {
          // Held long enough but no tick saw it (a stalled frame): still a long-press, not a tap.
          s.longPressed = true;
          push(this.longPresses, { ...c.origin, device: c.device });
        } else {
          this.emitTap(c, time);
        }
      }
    }
    if (s.contacts.size === 0) this.session = null;
  }

  /** The browser took the pointer (system gesture, palm rejection): drop the press. */
  pointerCancel(id: number): void {
    const s = this.session;
    if (!s?.contacts.has(id)) return;
    this.cancelSession(s);
    s.contacts.delete(id);
    if (s.contacts.size === 0) this.session = null;
  }

  /** Drop every pointer (focus loss, tab hidden). A started pan, drag or pinch is cancelled. */
  cancelAll(): void {
    const s = this.session;
    if (s) this.cancelSession(s);
    this.session = null;
    this.longPressSession = null;
  }

  private cancelSession(s: Session): void {
    if (!s.void) {
      if (s.multi) this.endTwo(s, 'cancel');
      else this.endOnePointer(s, s.contacts.values().next().value as Contact, 'cancel');
    }
    s.void = true;
    if (this.longPressSession === s) this.longPressSession = null;
  }

  // ---------------------------------------------------------------- recognisers

  private checkLongPress(t: number): void {
    const s = this.session;
    if (!s || s.void || s.multi || s.moving || s.longPressed) return;
    const c = s.contacts.values().next().value as Contact | undefined;
    if (!c || t - c.downAt < this.longPressMs) return;
    s.longPressed = true;
    push(this.longPresses, { ...c.origin, device: c.device });
  }

  private emitTap(c: Contact, time: number): void {
    const prev = this.lastTap;
    const double =
      prev !== null &&
      c.downAt - prev.at <= this.doubleTapMs &&
      dist(prev.x, prev.y, c.startX, c.startY) <= this.doubleTapDistance;
    push(this.taps, { tap: { ...c.origin, device: c.device }, double });
    this.lastTap = double ? null : { x: c.startX, y: c.startY, at: time };
  }

  private pushMove(s: Session, c: Contact, p: GesturePoint, phase: 'start' | 'move'): void {
    const last = s.last ?? c.origin;
    const dx = p.inside && last.inside ? p.x - last.x : 0;
    const dy = p.inside && last.inside ? p.y - last.y : 0;
    const at = p.inside ? p : { ...last, inside: false };
    s.last = p.inside ? p : last;
    s.at = at;
    this.pans.push({ phase, ...at, dx, dy, pointers: 1, device: c.device });
    this.drags.push({ phase, ...at, origin: c.origin, dx, dy, device: c.device });
  }

  /** Ends (or cancels) a one-pointer pan and drag, if one is running in `s`. */
  private endOnePointer(s: Session, c: Contact, phase: 'end' | 'cancel'): void {
    if (!s.moving) return;
    s.moving = false;
    const at = s.at ?? c.origin;
    this.pans.push({ phase, ...at, dx: 0, dy: 0, pointers: 1, device: c.device });
    this.drags.push({ phase, ...at, origin: c.origin, dx: 0, dy: 0, device: c.device });
  }

  private moveTwo(s: Session): void {
    const [a, b] = [...s.contacts.values()] as [Contact, Contact];
    const d = Math.max(1, dist(a.lastX, a.lastY, b.lastX, b.lastY));
    const cx = (a.lastX + b.lastX) / 2;
    const cy = (a.lastY + b.lastY) / 2;
    const centre = this.map(cx, cy);
    if (d !== s.pinchLastDist) {
      const delta = d / s.pinchLastDist;
      s.pinchLastDist = d;
      push(this.pinches, { phase: 'move', ...centre, scale: d / s.pinchStartDist, delta });
    }
    const last = s.centreLast ?? centre;
    let phase: 'start' | 'move' = 'move';
    if (!s.twoPanning) {
      if (dist(s.centreStartX, s.centreStartY, cx, cy) <= this.panThreshold) return;
      s.twoPanning = true;
      phase = 'start';
    }
    const dx = centre.inside && last.inside ? centre.x - last.x : 0;
    const dy = centre.inside && last.inside ? centre.y - last.y : 0;
    if (centre.inside) s.centreLast = centre;
    const at = centre.inside ? centre : { ...last, inside: false };
    this.pans.push({ phase, ...at, dx, dy, pointers: 2, device: a.device });
  }

  private endTwo(s: Session, phase: 'end' | 'cancel'): void {
    const centre = s.centreLast ?? this.lastInside;
    if (s.pinching) {
      s.pinching = false;
      this.pinches.push({
        phase,
        ...centre,
        scale: s.pinchLastDist / s.pinchStartDist,
        delta: 1,
      });
    }
    if (s.twoPanning) {
      s.twoPanning = false;
      const c = s.contacts.values().next().value as Contact | undefined;
      this.pans.push({ phase, ...centre, dx: 0, dy: 0, pointers: 2, device: c?.device ?? 'touch' });
    }
  }

  private map(clientX: number, clientY: number): GesturePoint {
    const p = this.transform ? this.transform(clientX, clientY) : { x: clientX, y: clientY };
    if (p) {
      this.lastInside = { x: p.x, y: p.y, inside: true };
      return { x: p.x, y: p.y, inside: true };
    }
    return { x: this.lastInside.x, y: this.lastInside.y, inside: false };
  }

  // ---------------------------------------------------------------- DOM

  /**
   * Listen to pointer events on the target. Mouse: the primary button only. Touch and pen: up
   * to two contacts. The target captures each pointer, so a drag off its edge keeps reporting.
   * `Input.setGestures` calls this from `Input.attach`; call it yourself only when the gestures
   * are used without an `Input`.
   */
  attach(opts: GestureAttachOptions): void {
    this.detach();
    const target = opts.pointerTarget;
    const doc = target.ownerDocument;
    const win = doc.defaultView ?? window;
    const prevTouchAction = target.style.touchAction;
    if (opts.disableTouchScroll !== false) target.style.touchAction = 'none';

    const local = (e: PointerEvent): [number, number] => {
      if (this.transform) return [e.clientX, e.clientY];
      const r = target.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const device = (e: PointerEvent): GestureDevice =>
      e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse';

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const [x, y] = local(e);
      this.pointerDown(e.pointerId, x, y, device(e));
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events have no active pointer.
      }
    };
    const onMove = (e: PointerEvent) => {
      const [x, y] = local(e);
      this.pointerMove(e.pointerId, x, y);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const [x, y] = local(e);
      this.pointerUp(e.pointerId, x, y);
    };
    const onCancel = (e: PointerEvent) => this.pointerCancel(e.pointerId);
    const onBlur = () => this.cancelAll();
    const onVisibility = () => {
      if (doc.visibilityState === 'hidden') this.cancelAll();
    };

    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibility);
    this.detachFn = () => {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onCancel);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
      target.style.touchAction = prevTouchAction;
    };
  }

  detach(): void {
    this.detachFn?.();
    this.detachFn = null;
    this.cancelAll();
  }
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

function push<T>(queue: T[], e: T): void {
  if (queue.length < MAX_QUEUED) queue.push(e);
}

function idlePan<E extends PanEvent | DragEvent>(last: E): E {
  return { ...last, phase: 'move', dx: 0, dy: 0 };
}

function idlePinch(last: PinchEvent): PinchEvent {
  return { ...last, phase: 'move', delta: 1 };
}

function mergePan<E extends PanEvent | DragEvent>(a: E, b: E): E {
  return { ...b, dx: a.dx + b.dx, dy: a.dy + b.dy };
}

function mergePinch(a: PinchEvent, b: PinchEvent): PinchEvent {
  return { ...b, delta: a.delta * b.delta };
}
