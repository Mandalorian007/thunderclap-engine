/**
 * Touch zones (ws/input-4): screen regions that turn thumbs into a stick, buttons or swipes and
 * feed actions through an `Input`. A pointer that goes down inside a zone is claimed through the
 * input's pointer dispatcher, so gestures and the router never see it (two thumbs never pinch);
 * each zone tracks at most one pointer. Zone rects are in CSS px of the pointer target, computed
 * from its size when a pointer lands, so they follow resizes.
 *
 * ```ts
 * const zones = createTouchZones(input, {
 *   zones: {
 *     move: { kind: 'stick', rect: (w, h) => ({ x: 0, y: h / 2, w: w / 2, h: h / 2 }) },
 *     act: { kind: 'buttons', rect: (w, h) => ({ x: w / 2, y: h / 2, w: w / 2, h: h / 2 }),
 *            buttons: { jump: (w, h) => ({ x: w - 120, y: h - 120, w: 100, h: 100 }) } },
 *   },
 *   bindings: {
 *     moveLeft: { zone: 'move', axis: 'x', dir: -1 },
 *     moveRight: { zone: 'move', axis: 'x', dir: 1 },
 *     jump: { zone: 'act', button: 'jump' },
 *   },
 * });
 * // every tick, after input.update():
 * zones.zones.move.vector; // [x, y] -1..1
 * input.axis('moveLeft', 'moveRight'); // the same x through the actions
 * ```
 *
 * Recordings capture zone thumbs through the input's existing pointer feed (the primary pointer
 * only; see the README), so no new record kind is needed.
 */
import type { ActionSource, Input } from './input';
import {
  POINTER_PRIORITY,
  type PointerConsumer,
  type PointerDispatcher,
  type PointerRecord,
  type PointerRecordDevice,
} from './pointer-dispatch';

/** A zone or button rect in CSS px of the pointer target, origin top-left. */
export interface ZoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `(targetWidth, targetHeight) => rect`, called when a pointer lands. */
export type ZoneRectFn = (w: number, h: number) => ZoneRect;

export type TouchZoneKind = 'stick' | 'buttons' | 'swipe';

export interface StickZoneOptions {
  kind: 'stick';
  rect: ZoneRectFn;
  /** Vector magnitude below which the stick reads 0 (rescaled above it). Default 0.12. */
  deadZone?: number;
  /** CSS px of travel for a full deflection. Default 64. */
  radius?: number;
  /** Where the stick's origin is: the down point (default) or the zone's centre. */
  anchor?: 'down' | 'center';
}

export interface ButtonsZoneOptions {
  kind: 'buttons';
  rect: ZoneRectFn;
  /** Sub-rects by name; a pointer landing in one presses it (and holds it until it lifts). */
  buttons: Record<string, ZoneRectFn>;
}

export interface SwipeZoneOptions {
  kind: 'swipe';
  rect: ZoneRectFn;
  /** CSS px of travel that makes a swipe. Default 24. */
  threshold?: number;
}

export type TouchZoneOptions = StickZoneOptions | ButtonsZoneOptions | SwipeZoneOptions;

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/** A `stick` zone's reading. */
export interface StickZone {
  readonly kind: 'stick';
  /** True while a pointer is down in the zone. */
  readonly active: boolean;
  /** The deflection, -1..1 each (y down). One array, updated in place. */
  readonly vector: readonly [number, number];
  /** Shorthands for `vector[0]` / `vector[1]`. */
  readonly x: number;
  readonly y: number;
  /** The stick's origin in target px (NaN while inactive). */
  readonly originX: number;
  readonly originY: number;
}

/** A `buttons` zone's reading. */
export interface ButtonsZone {
  readonly kind: 'buttons';
  readonly active: boolean;
  /** True on the tick a pointer landed on the button. */
  pressed(name: string): boolean;
  /** True while a pointer that landed on the button is down. */
  held(name: string): boolean;
  /** The button held now, or `null`. */
  readonly down: string | null;
}

/** A `swipe` zone's reading. */
export interface SwipeZone {
  readonly kind: 'swipe';
  readonly active: boolean;
  /** The direction swiped this tick, once per gesture, else `null`. */
  readonly swipe: SwipeDirection | null;
}

export type TouchZoneReading<O extends TouchZoneOptions> = O extends StickZoneOptions
  ? StickZone
  : O extends ButtonsZoneOptions
    ? ButtonsZone
    : SwipeZone;

/** How an action reads a zone. */
export type TouchZoneBinding =
  /** A stick axis in one direction: 0..1 of the deflection along it. */
  | { zone: string; axis: 'x' | 'y'; dir: 1 | -1 }
  /** A button: 1 while held, with a fresh press each landing. */
  | { zone: string; button: string }
  /** A swipe: 1 on the tick it is recognised. */
  | { zone: string; swipe: SwipeDirection };

export interface TouchZonesOptions<Z extends Record<string, TouchZoneOptions>> {
  zones: Z;
  /** Actions fed through `input` from the zones. */
  bindings?: Record<string, TouchZoneBinding | readonly TouchZoneBinding[]>;
  /** Pointer devices the zones take. Default `['touch']`. */
  devices?: readonly PointerRecordDevice[];
}

export interface TouchZones<Z extends Record<string, TouchZoneOptions>> {
  readonly zones: { readonly [K in keyof Z]: TouchZoneReading<Z[K]> };
  /** False stops the zones taking pointers (held ones are dropped). */
  enabled: boolean;
  /**
   * Advance the per-tick edges (`pressed`, `swipe`). The linked `input.update()` calls this
   * through its action source; do not call it yourself while the zones are linked.
   */
  update(): void;
  /** Join the input's dispatcher (done on creation and on every `input.attach`). */
  attach(): void;
  /** Leave the dispatcher and drop every pointer. */
  detach(): void;
  /** Detach and unlink from the input (actions and attach events). */
  destroy(): void;
}

const DEFAULT_DEAD_ZONE = 0.12;
const DEFAULT_RADIUS = 64;
const DEFAULT_SWIPE_PX = 24;

interface ZoneState {
  readonly name: string;
  readonly opts: TouchZoneOptions;
  pointer: number;
  /** Target rect at the down, so moves use the same frame. */
  left: number;
  top: number;
  width: number;
  height: number;
  rect: ZoneRect;
  // stick
  readonly vector: [number, number];
  originX: number;
  originY: number;
  // buttons
  down: string | null;
  pendingPress: string | null;
  pressedNow: string | null;
  // swipe
  downX: number;
  downY: number;
  swiped: boolean;
  pendingSwipe: SwipeDirection | null;
  swipeNow: SwipeDirection | null;
}

const inRect = (r: ZoneRect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export function createTouchZones<Z extends Record<string, TouchZoneOptions>>(
  input: Input<string>,
  opts: TouchZonesOptions<Z>,
): TouchZones<Z> {
  const devices = opts.devices ?? ['touch'];
  const states: ZoneState[] = [];
  const byName = new Map<string, ZoneState>();
  const readings = {} as { [K in keyof Z]: TouchZoneReading<Z[K]> };
  for (const name of Object.keys(opts.zones)) {
    const z = opts.zones[name]!;
    const st: ZoneState = {
      name,
      opts: z,
      pointer: -1,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      vector: [0, 0],
      originX: Number.NaN,
      originY: Number.NaN,
      down: null,
      pendingPress: null,
      pressedNow: null,
      downX: 0,
      downY: 0,
      swiped: false,
      pendingSwipe: null,
      swipeNow: null,
    };
    states.push(st);
    byName.set(name, st);
    (readings as Record<string, unknown>)[name] = makeReading(st);
  }

  const bindings = new Map<string, readonly TouchZoneBinding[]>();
  if (opts.bindings) {
    for (const action of Object.keys(opts.bindings)) {
      const b = opts.bindings[action]!;
      bindings.set(
        action,
        Array.isArray(b) ? (b as readonly TouchZoneBinding[]) : [b as TouchZoneBinding],
      );
    }
  }

  let dispatcher: PointerDispatcher | null = null;
  let enabled = true;

  const drop = (st: ZoneState): void => {
    if (st.pointer >= 0) dispatcher?.release(st.pointer);
    st.pointer = -1;
    st.vector[0] = 0;
    st.vector[1] = 0;
    st.originX = Number.NaN;
    st.originY = Number.NaN;
    st.down = null;
    st.swiped = false;
  };
  const holder = (id: number): ZoneState | null => {
    for (let i = 0; i < states.length; i++) if (states[i]!.pointer === id) return states[i]!;
    return null;
  };

  const consumer: PointerConsumer = {
    pointerDown: (p: PointerRecord) => {
      if (!enabled || !dispatcher || devices.indexOf(p.device) < 0) return;
      const b = dispatcher.target.getBoundingClientRect();
      const x = p.clientX - b.left;
      const y = p.clientY - b.top;
      for (let i = 0; i < states.length; i++) {
        const st = states[i]!;
        if (st.pointer >= 0) continue;
        const r = st.opts.rect(b.width, b.height);
        if (!inRect(r, x, y)) continue;
        if (!dispatcher.claim(p.id, consumer)) return;
        st.pointer = p.id;
        st.left = b.left;
        st.top = b.top;
        st.width = b.width;
        st.height = b.height;
        st.rect = r;
        const o = st.opts;
        if (o.kind === 'stick') {
          if (o.anchor === 'center') {
            st.originX = r.x + r.w / 2;
            st.originY = r.y + r.h / 2;
          } else {
            st.originX = x;
            st.originY = y;
          }
          stickMove(st, o, x, y);
        } else if (o.kind === 'buttons') {
          for (const name of Object.keys(o.buttons)) {
            if (inRect(o.buttons[name]!(b.width, b.height), x, y)) {
              st.down = name;
              st.pendingPress = name;
              break;
            }
          }
        } else {
          st.downX = x;
          st.downY = y;
          st.swiped = false;
        }
        return;
      }
    },
    pointerMove: (p: PointerRecord) => {
      const st = holder(p.id);
      if (!st) return;
      const x = p.clientX - st.left;
      const y = p.clientY - st.top;
      const o = st.opts;
      if (o.kind === 'stick') stickMove(st, o, x, y);
      else if (o.kind === 'swipe' && !st.swiped) {
        const dx = x - st.downX;
        const dy = y - st.downY;
        const threshold = o.threshold ?? DEFAULT_SWIPE_PX;
        if (dx * dx + dy * dy >= threshold * threshold) {
          st.swiped = true;
          st.pendingSwipe =
            Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
        }
      }
    },
    pointerUp: (p: PointerRecord) => {
      const st = holder(p.id);
      if (st) drop(st);
    },
    pointerCancel: (p: PointerRecord) => {
      const st = holder(p.id);
      if (st) drop(st);
    },
    cancelAll: () => {
      for (let i = 0; i < states.length; i++) drop(states[i]!);
    },
  };

  const update = (): void => {
    for (let i = 0; i < states.length; i++) {
      const st = states[i]!;
      st.pressedNow = st.pendingPress;
      st.pendingPress = null;
      st.swipeNow = st.pendingSwipe;
      st.pendingSwipe = null;
    }
  };

  const bindingValue = (b: TouchZoneBinding): number => {
    const st = byName.get(b.zone);
    if (!st) return 0;
    if ('axis' in b) {
      const v = st.vector[b.axis === 'x' ? 0 : 1] * b.dir;
      return Math.max(0, v);
    }
    if ('button' in b) return st.down === b.button ? 1 : 0;
    return st.swipeNow === b.swipe ? 1 : 0;
  };

  const source: ActionSource = {
    update,
    value: (action) => {
      const list = bindings.get(action);
      if (!list) return 0;
      let v = 0;
      for (let i = 0; i < list.length; i++) {
        const x = bindingValue(list[i]!);
        if (x > v) v = x;
      }
      return v;
    },
    fresh: (action) => {
      const list = bindings.get(action);
      if (!list) return false;
      for (let i = 0; i < list.length; i++) {
        const b = list[i]!;
        if ('button' in b && byName.get(b.zone)?.pressedNow === b.button) return true;
      }
      return false;
    },
  };

  let removeConsumer: (() => void) | null = null;
  const detach = (): void => {
    consumer.cancelAll!();
    removeConsumer?.();
    removeConsumer = null;
    dispatcher = null;
  };
  const attach = (): void => {
    detach();
    const d = input.dispatcher;
    if (!d) return;
    dispatcher = d;
    removeConsumer = d.add(consumer, POINTER_PRIORITY.zones);
  };

  const removeSource = input.addActionSource(source);
  const offAttach = input.on('attach', attach);
  const offDetach = input.on('detach', detach);
  attach();

  return {
    zones: readings,
    get enabled() {
      return enabled;
    },
    set enabled(v: boolean) {
      enabled = v;
      if (!v) consumer.cancelAll!();
    },
    update,
    attach,
    detach,
    destroy() {
      detach();
      removeSource();
      offAttach();
      offDetach();
    },
  };
}

function stickMove(st: ZoneState, o: StickZoneOptions, x: number, y: number): void {
  const radius = o.radius ?? DEFAULT_RADIUS;
  const dead = o.deadZone ?? DEFAULT_DEAD_ZONE;
  let vx = (x - st.originX) / radius;
  let vy = (y - st.originY) / radius;
  const m = Math.sqrt(vx * vx + vy * vy);
  if (m <= dead) {
    vx = 0;
    vy = 0;
  } else {
    const scaled = Math.min(1, (m - dead) / (1 - dead));
    vx = (vx / m) * scaled;
    vy = (vy / m) * scaled;
  }
  st.vector[0] = vx;
  st.vector[1] = vy;
}

function makeReading(st: ZoneState): StickZone | ButtonsZone | SwipeZone {
  const kind = st.opts.kind;
  if (kind === 'stick') {
    return {
      kind,
      get active() {
        return st.pointer >= 0;
      },
      vector: st.vector,
      get x() {
        return st.vector[0];
      },
      get y() {
        return st.vector[1];
      },
      get originX() {
        return st.originX;
      },
      get originY() {
        return st.originY;
      },
    };
  }
  if (kind === 'buttons') {
    return {
      kind,
      get active() {
        return st.pointer >= 0;
      },
      pressed: (name) => st.pressedNow === name,
      held: (name) => st.down === name,
      get down() {
        return st.down;
      },
    };
  }
  return {
    kind,
    get active() {
      return st.pointer >= 0;
    },
    get swipe() {
      return st.swipeNow;
    },
  };
}
