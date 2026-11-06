import { Loupe } from '../ui/loupe';
import {
  type Aim,
  loupeClear,
  loupeSpot,
  MAGNIFY_DEFAULTS,
  type MagnifyOptions,
  magnifySize,
} from './magnify';
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

/** `pan`: one pointer moved past the threshold. Two or more pointers pinch and never pan. */
export interface PanGesture extends GesturePoint {
  phase: GesturePhase;
  /** Movement since the previous report, game space. Every `dx` of one pan sums to its total travel from the down point. */
  dx: number;
  dy: number;
  /** Pointers in the pan: always 1 (a second pointer cancels the pan and starts a pinch). */
  pointers: 1;
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

/**
 * An `onGesture` listener: called once, synchronously, each time the recogniser decides something,
 * before any tick reports it. `g` is the report that the tick fields will carry (a `TapGesture`,
 * `PanGesture`, `DragGesture` or `PinchGesture`, narrowed by `kind`). Discrete kinds (`tap`,
 * `doubleTap`, `longPress`) come with phase `'end'`.
 */
export type GestureListener = (kind: GestureKind, phase: GesturePhase, g: GesturePoint) => void;

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
  /**
   * Loupe and snap for small touch targets (see `magnify.ts`): while one touch pointer is down
   * each tick reports `aim`, and below `below` CSS px of pitch a loupe shows the aim point.
   */
  magnify?: MagnifyOptions;
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
  /** Cumulative travel since the down point (CSS px, summed over every move). */
  travel: number;
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
  /** The last inside centre of the two pointers (game space), where the pinch is reported. */
  centreLast: GesturePoint | null;
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
 *   Travel is cumulative from the down point, so a slow drag crosses it too, and the threshold
 *   is checked before the long-press timer on every move: a pointer whose travel crosses it
 *   never long-presses, however long the frame took. A long-press that already fired stays.
 * - A second pointer cancels the pan and drag (and any tap or long-press) and starts a pinch;
 *   while two or more pointers are down, pan and drag report nothing (pinch wins). Lifting
 *   either pointer ends the pinch; nothing more is reported until every pointer is up.
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
  /** This tick's aim while one touch pointer is down (with the `magnify` option), or `null`. */
  aim: Aim | null = null;
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
  private magnify: MagnifyOptions | null;
  private loupe: Loupe | null = null;
  /** The aim at the moment the finger lifted, reported (with `ended`) on the next tick. */
  private endedAim: Aim | null = null;
  /** `onGesture` listeners, called at recognition time. */
  private readonly listeners: GestureListener[] = [];

  constructor(opts: GestureOptions = {}) {
    this.panThreshold = opts.panThreshold ?? DEFAULTS.panThreshold;
    this.longPressMs = opts.longPressMs ?? DEFAULTS.longPressMs;
    this.doubleTapMs = opts.doubleTapMs ?? DEFAULTS.doubleTapMs;
    this.doubleTapDistance = opts.doubleTapDistance ?? DEFAULTS.doubleTapDistance;
    this.blocked = opts.blocked ?? (() => false);
    this.now = opts.now ?? defaultNow;
    this.magnify = opts.magnify ?? null;
  }

  /** Turn magnify on (or off with `null`) after construction. */
  setMagnify(opts: MagnifyOptions | null): void {
    this.magnify = opts;
    this.aim = null;
    this.loupe?.destroy();
    this.loupe = null;
  }

  /** The loupe element, once one has been shown (for styling and tests). */
  get loupeElement(): HTMLElement | null {
    return this.loupe?.el ?? null;
  }

  /** Install the client → game-space mapping. `null` = identity (relative to the target when attached). */
  setPointerTransform(fn: PointerTransform | null): void {
    this.transform = fn;
  }

  // ---------------------------------------------------------------- observer

  /**
   * Observe the gesture stream: `listener` is called synchronously each time a gesture is
   * recognised (a tap on lift, a long-press when its time is up, a pan's `start`, every `move`,
   * `end` or `cancel`), not once per tick. It is an observer for tests, replays and logging; the
   * per-tick fields (`tap`, `drag`, ...) and action bindings stay the way a game reads gestures.
   * Returns the unsubscribe function.
   */
  onGesture(listener: GestureListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(kind: GestureKind, phase: GesturePhase, g: GesturePoint): void {
    const ls = this.listeners;
    for (let i = 0; i < ls.length; i++) ls[i]?.(kind, phase, g);
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
      if (this.pan) this.emit('pan', 'cancel', this.pan);
      if (this.drag) this.emit('drag', 'cancel', this.drag);
      if (this.pinch) this.emit('pinch', 'cancel', this.pinch);
      this.running.clear();
      this.updateAim();
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
    this.updateAim();
  }

  /**
   * This tick's aim (the `magnify` option): one touch pointer down, not blocked, `when()`. The
   * aim point is the finger, raised by `lift` while it drags; `snap` picks the target; the
   * loupe shows while the pitch is below `below` and the aim is over the targets.
   */
  private updateAim(): void {
    const m = this.magnify;
    const s = this.session;
    const c = s && !s.void && !s.multi ? (s.contacts.values().next().value as Contact) : null;
    // The aim the finger lifted at comes with the drag's `end` (moves before it get their own
    // ticks first, still aiming there).
    let ended = this.endedAim;
    if (ended && this.drags.length > 0) ended = { ...ended, ended: false };
    else this.endedAim = null;
    const aim = !m || this.blocked() ? null : c ? this.aimOf(m, c, s?.moving === true) : ended;
    this.aim = aim;
    if (!m?.source || !aim?.loupe || aim.ended) {
      this.loupe?.hide();
      return;
    }
    const size = magnifySize(m);
    if (this.loupe && this.loupe.size !== size) {
      this.loupe.destroy();
      this.loupe = null;
    }
    this.loupe ??= new Loupe(m.source, {
      size,
      zoom: m.zoom ?? MAGNIFY_DEFAULTS.zoom,
      className: m.className,
      parent: m.parent,
    });
    let ring: { x: number; y: number; r: number } | null = null;
    const t = aim.target;
    if (t) {
      const to = m.toClient ?? ((tx: number, ty: number) => ({ x: tx, y: ty }));
      const a = to(t.x, t.y);
      const b = to(t.x + t.r, t.y);
      ring = { x: a.x, y: a.y, r: Math.abs(b.x - a.x) };
    }
    this.loupe.show({ focus: aim.client, at: aim.at, ring, leader: m.leader ? ring : null });
  }

  /** The aim of touch contact `c` (`null` for mouse and pen, or while `when()` is false). */
  private aimOf(m: MagnifyOptions, c: Contact, lifted: boolean): Aim | null {
    if (c.device !== 'touch' || (m.when && !m.when())) return null;
    const lift = lifted ? (m.lift ?? MAGNIFY_DEFAULTS.lift) : 0;
    const finger = { x: c.lastX, y: c.lastY };
    const client = { x: c.lastX, y: c.lastY - lift };
    const p = this.transform ? this.transform(client.x, client.y) : { x: client.x, y: client.y };
    const inside = p !== null;
    const x = p?.x ?? this.lastInside.x;
    const y = p?.y ?? this.lastInside.y;
    const target = inside && m.snap ? m.snap(x, y) : null;
    const over = inside && (m.over ? m.over(x, y) : target !== null);
    const size = magnifySize(m);
    const loupe = over && m.pitch() < (m.below ?? MAGNIFY_DEFAULTS.below);
    const win = (m.source?.ownerDocument ?? globalThis.document)?.defaultView;
    const view = win
      ? { width: win.innerWidth, height: win.innerHeight }
      : { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY };
    const room = loupe && m.clear ? m.clear(target, { x, y }) : null;
    const at = room
      ? loupeClear(finger, client, size, view, room.keep, room.avoid, room.spare)
      : loupeSpot(finger, client, size, view);
    return { x, y, inside, client, finger, lifted, target, loupe, at, ended: false };
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
        centreLast: null,
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
      travel: 0,
    };
    s.contacts.set(id, contact);
    if (s.void || s.contacts.size !== 2) {
      // A third pointer is ignored; it still has to lift before the session ends.
      return;
    }
    // Second pointer: the press becomes a pinch; a running pan and drag are cancelled, and
    // neither reports again until every pointer is up.
    s.multi = true;
    this.endOnePointer(s, s.contacts.values().next().value as Contact, 'cancel');
    const [a, b] = [...s.contacts.values()] as [Contact, Contact];
    s.pinchStartDist = Math.max(1, dist(a.lastX, a.lastY, b.lastX, b.lastY));
    s.pinchLastDist = s.pinchStartDist;
    const centre = this.map((a.lastX + b.lastX) / 2, (a.lastY + b.lastY) / 2);
    s.centreLast = centre;
    s.pinching = true;
    this.pushPinch({ phase: 'start', ...centre, scale: 1, delta: 1 });
  }

  pointerMove(id: number, clientX: number, clientY: number, time = this.now()): void {
    const s = this.session;
    const c = s?.contacts.get(id);
    if (!s || !c || (clientX === c.lastX && clientY === c.lastY)) return;
    c.travel += dist(c.lastX, c.lastY, clientX, clientY);
    c.lastX = clientX;
    c.lastY = clientY;
    if (s.void) return;
    if (s.multi) {
      this.moveTwo(s);
      return;
    }
    if (s.longPressed) return;
    if (!s.moving) {
      // The threshold first: travel that crosses it is a pan, however late this move arrives
      // (a long frame), and the pending long-press is dropped. Only a still pointer may long-press.
      if (c.travel <= this.panThreshold) {
        this.checkLongPress(time);
        return;
      }
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
    if (this.magnify && !s.void && !s.multi && !this.blocked()) {
      const aim = this.aimOf(this.magnify, c, s.moving);
      this.endedAim = aim ? { ...aim, ended: true } : null;
    }
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
          this.longPressOf(s, c);
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
    this.longPressOf(s, c);
  }

  private longPressOf(s: Session, c: Contact): void {
    s.longPressed = true;
    const g: TapGesture = { ...c.origin, device: c.device };
    push(this.longPresses, g);
    this.emit('longPress', 'end', g);
  }

  private emitTap(c: Contact, time: number): void {
    const prev = this.lastTap;
    const double =
      prev !== null &&
      c.downAt - prev.at <= this.doubleTapMs &&
      dist(prev.x, prev.y, c.startX, c.startY) <= this.doubleTapDistance;
    const tap: TapGesture = { ...c.origin, device: c.device };
    push(this.taps, { tap, double });
    this.lastTap = double ? null : { x: c.startX, y: c.startY, at: time };
    this.emit('tap', 'end', tap);
    if (double) this.emit('doubleTap', 'end', tap);
  }

  private pushMove(s: Session, c: Contact, p: GesturePoint, phase: 'start' | 'move'): void {
    const last = s.last ?? c.origin;
    const dx = p.inside && last.inside ? p.x - last.x : 0;
    const dy = p.inside && last.inside ? p.y - last.y : 0;
    const at = p.inside ? p : { ...last, inside: false };
    s.last = p.inside ? p : last;
    s.at = at;
    this.pushPan(c, phase, at, dx, dy);
  }

  /** Queues one pan and one drag report and tells the listeners. */
  private pushPan(c: Contact, phase: GesturePhase, at: GesturePoint, dx: number, dy: number): void {
    const pan: PanEvent = { phase, ...at, dx, dy, pointers: 1, device: c.device };
    const drag: DragEvent = { phase, ...at, origin: c.origin, dx, dy, device: c.device };
    this.pans.push(pan);
    this.drags.push(drag);
    this.emit('pan', phase, pan);
    this.emit('drag', phase, drag);
  }

  private pushPinch(e: PinchEvent): void {
    push(this.pinches, e);
    this.emit('pinch', e.phase, e);
  }

  /** Ends (or cancels) a one-pointer pan and drag, if one is running in `s`. */
  private endOnePointer(s: Session, c: Contact, phase: 'end' | 'cancel'): void {
    if (!s.moving) return;
    s.moving = false;
    this.pushPan(c, phase, s.at ?? c.origin, 0, 0);
  }

  /** Two pointers: only the pinch moves. Their centre moving is not a pan (pinch wins). */
  private moveTwo(s: Session): void {
    const [a, b] = [...s.contacts.values()] as [Contact, Contact];
    const d = Math.max(1, dist(a.lastX, a.lastY, b.lastX, b.lastY));
    const centre = this.map((a.lastX + b.lastX) / 2, (a.lastY + b.lastY) / 2);
    if (centre.inside) s.centreLast = centre;
    if (d === s.pinchLastDist) return;
    const delta = d / s.pinchLastDist;
    s.pinchLastDist = d;
    const at = centre.inside ? centre : { ...(s.centreLast ?? centre), inside: false };
    this.pushPinch({ phase: 'move', ...at, scale: d / s.pinchStartDist, delta });
  }

  private endTwo(s: Session, phase: 'end' | 'cancel'): void {
    if (!s.pinching) return;
    s.pinching = false;
    const e: PinchEvent = {
      phase,
      ...(s.centreLast ?? this.lastInside),
      scale: s.pinchLastDist / s.pinchStartDist,
      delta: 1,
    };
    this.pinches.push(e);
    this.emit('pinch', phase, e);
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
    this.aim = null;
    this.endedAim = null;
    this.loupe?.hide();
  }

  /** Detach and remove the loupe element. */
  destroy(): void {
    this.detach();
    this.loupe?.destroy();
    this.loupe = null;
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
