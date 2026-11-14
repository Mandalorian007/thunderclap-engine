/**
 * Intents (ws/intents-quality, D1 P8 and §2.13): actions and pointer rays turned into the game's
 * own verbs. The game declares its intents (`press`, `release`, `tap`, `hold`, `aim`, `cycle`,
 * `select`), each bound to actions, and hands a sink with one handler per intent; every scheme
 * (keys, mouse, touch, pad, an XR controller) reaches the same handlers, aimed by a ray.
 *
 * - Actions (keys, pad buttons, the locked mouse, XR buttons) act at once.
 * - Touches and pens go through a still-press classifier: a finger lifted soon is a `tap`, one
 *   held still is a `hold` that then follows the finger, one that moves is a drag (the look's, not
 *   an intent). A thumb on the move stick holds only through `stickSideHold`.
 * - The aim is a ray (`AimRay`), or `null` for the view's centre (the crosshair). A ray made
 *   through a screen point keeps that point (`screen`) and is made again from the camera every
 *   tick, so a hold's aim follows the view as it turns.
 *
 * Generalized from Forge Wilds' `ActionSink` (play/actions.ts), its finger roles (play/gestures.ts)
 * and its touch scheme (ui/touch.ts); the vocabulary is the game's, the plumbing is here.
 */
import {
  inStickZone,
  type StickSideHoldSpec,
  type StillHoldSpec,
  StillPress,
  stillHold,
  WheelSteps,
} from './gestures-hold';
import type { Input } from './input';
import {
  POINTER_PRIORITY,
  type PointerConsumer,
  type PointerDispatcher,
  type PointerRecord,
} from './pointer-dispatch';
import type { PointerRouter } from './pointer-router';
import { type Ray, type RayCamera, screenRay, type Vec3 } from './rays';
import type { PointerTransform } from './types';

/**
 * A ray an intent aims by: from `origin` along `dir` (unit). `screen`, when set, is the point in
 * camera screen units the ray was made through (a free mouse, a finger); such a ray is made again
 * from the camera each tick. `null` is a ray in the world (an XR controller's), kept as given.
 * Handlers get a reused object: copy it to keep it.
 */
export interface AimRay extends Ray {
  readonly screen: readonly [number, number] | null;
}

/** Where an intent aims: a ray, or `null` for the view's centre (the crosshair). */
export type IntentAim = AimRay | null;

/** Fires on the tick any of its actions is pressed: `handler(aim)`. */
export interface PressIntent<A extends string> {
  readonly kind: 'press';
  readonly actions: readonly A[];
}

/** Fires on the tick any of its actions is released: `handler(aim)`. */
export interface ReleaseIntent<A extends string> {
  readonly kind: 'release';
  readonly actions: readonly A[];
}

/**
 * A tap: `handler(aim)` when one of its actions is pressed (a key or a button press is a tap), and
 * when a touch or pen press lifts still and soon (`touch`, default `stillHold()`; `false`: touches
 * never tap it). A touch's own action press (an `Input` binding a touch also drives) is ignored for
 * an intent that takes touches, so a finger taps once.
 */
export interface TapIntent<A extends string> {
  readonly kind: 'tap';
  readonly actions?: readonly A[];
  readonly touch?: StillHoldSpec | false;
}

/**
 * A hold: `start(aim, pressedAt)` when one of its actions is pressed (at once) or a touch or pen
 * press stays still (`touch`, default `stillHold()`; `false`: touches never hold it), then
 * `aim(aim)` whenever its aim changes (the finger moved, the view turned), then `end()` when the
 * action is released or the finger lifts. At most one touch holds at a time. `stickSide` lets the
 * move stick's thumb hold too (see `stickSideHold`).
 */
export interface HoldIntent<A extends string> {
  readonly kind: 'hold';
  readonly actions?: readonly A[];
  readonly touch?: StillHoldSpec | false;
  readonly stickSide?: StickSideHoldSpec<IntentAim>;
}

/** The view's aim: `handler(aim, aiming)` on every tick it changes. `aiming` is false while a touch scheme has no finger down. */
export interface AimIntent {
  readonly kind: 'aim';
}

/** Steps a selection: `handler(+1)` on `next`, `handler(-1)` on `prev`, and wheel steps when `wheel` is on (down is +1). */
export interface CycleIntent<A extends string> {
  readonly kind: 'cycle';
  readonly next?: readonly A[];
  readonly prev?: readonly A[];
  readonly wheel?: boolean;
}

/** Picks one of several: `handler(n)` when `actions[n]` is pressed (the lowest `n` when several are). */
export interface SelectIntent<A extends string> {
  readonly kind: 'select';
  readonly actions: readonly A[];
}

export type IntentDecl<A extends string> =
  | PressIntent<A>
  | ReleaseIntent<A>
  | TapIntent<A>
  | HoldIntent<A>
  | AimIntent
  | CycleIntent<A>
  | SelectIntent<A>;

/** The game's intents by name. */
export type IntentSpec<A extends string> = Readonly<Record<string, IntentDecl<A>>>;

/** A hold intent's handlers. `pressedAt` is when the press began (ms on the intents' clock), earlier than now for a still hold. */
export interface HoldHandler {
  start(aim: IntentAim, pressedAt: number): void;
  aim?(aim: IntentAim): void;
  end(): void;
}

/** The handler an intent declaration takes. */
export type IntentHandler<D> = D extends { kind: 'hold' }
  ? HoldHandler
  : D extends { kind: 'cycle' }
    ? (delta: number) => void
    : D extends { kind: 'select' }
      ? (n: number) => void
      : D extends { kind: 'aim' }
        ? (aim: IntentAim, aiming: boolean) => void
        : (aim: IntentAim) => void;

/** One handler per declared intent. */
export type IntentSink<S> = { readonly [K in keyof S]: IntentHandler<S[K]> };

/** The slice of `Input` the intents read. */
export type IntentInput<A extends string> = Pick<
  Input<A>,
  'pressed' | 'held' | 'released' | 'pointer' | 'lastDevice' | 'blocked' | 'dispatcher' | 'on'
>;

export interface IntentsOptions<A extends string> {
  /** The actions (and the pointer dispatcher the touches come from, once attached). */
  input: IntentInput<A>;
  /** The camera screen rays are made through, or a getter read each tick. */
  camera: RayCamera | (() => RayCamera);
  /** The pointer router: its primary XR pointer's ray is the aim while it leads. */
  pointers?: Pick<PointerRouter, 'primary'>;
  /** True while the view aims at its centre (the pointer is locked): every aim is `null`. */
  centred?: () => boolean;
  /** Client CSS px → camera screen units (the platform's letterbox). Default: the record's own `x`, `y`. */
  toScreen?: PointerTransform;
  /** Where touches start the move stick (`Look`'s `touch.moveZone`); those touches never tap or hold except through `stickSideHold`. Default `'none'`. */
  stickZone?: 'left' | 'right' | 'none';
  /** The clock (ms), the one pointer event ages are taken on. Default `performance.now`. */
  now?: () => number;
}

/** What `createIntents` returns. Call `update()` once per tick, after `input.update()`. */
export interface Intents {
  /** The view's aim this tick (reused). */
  readonly aim: IntentAim;
  /** False while a touch scheme has no finger to aim with. */
  readonly aiming: boolean;
  /** The hold intent held now (its name), or `null`. */
  readonly holding: string | null;
  update(): void;
  /** Feed methods (tests, replays): client CSS px, `time` on the intents' clock (default now). `inStick` overrides the stick-zone test. */
  touchDown(id: number, clientX: number, clientY: number, time?: number, inStick?: boolean): void;
  touchMove(id: number, clientX: number, clientY: number, time?: number): void;
  touchUp(id: number, clientX?: number, clientY?: number, time?: number): void;
  touchCancel(id: number): void;
  /** Every touch lets go, with no tap; a hold in progress ends. */
  cancelAll(): void;
  /** Take touches from `dispatcher` (done for you from the input's dispatcher). */
  attach(dispatcher: PointerDispatcher): void;
  detach(): void;
  dispose(): void;
}

type Role = 'stick' | 'act';

interface Finger {
  id: number;
  down: boolean;
  role: Role;
  /** A stick thumb that may hold (`stickSideHold`'s `when` said yes where it landed). */
  stickHold: boolean;
  readonly press: StillPress;
  /** The finger's point, camera screen units. */
  sx: number;
  sy: number;
}

interface AimBox {
  readonly origin: Vec3;
  readonly dir: Vec3;
  screen: [number, number] | null;
  readonly point: [number, number];
}

function newAim(): AimBox {
  return { origin: [0, 0, 0], dir: [0, 0, 1], screen: null, point: [0, 0] };
}

/** Last-sent copy of an aim, for change tests. */
interface AimMemo {
  valid: boolean;
  isNull: boolean;
  readonly v: Float64Array;
}

function newMemo(): AimMemo {
  return { valid: false, isNull: true, v: new Float64Array(8) };
}

/** True (and remembers it) when `aim` differs from what `m` last saw. */
function changed(m: AimMemo, aim: AimBox | null): boolean {
  if (aim === null) {
    if (m.valid && m.isNull) return false;
    m.valid = true;
    m.isNull = true;
    return true;
  }
  const v = m.v;
  const sx = aim.screen ? aim.screen[0] : Number.NaN;
  const sy = aim.screen ? aim.screen[1] : Number.NaN;
  const same =
    m.valid &&
    !m.isNull &&
    v[0] === aim.origin[0] &&
    v[1] === aim.origin[1] &&
    v[2] === aim.origin[2] &&
    v[3] === aim.dir[0] &&
    v[4] === aim.dir[1] &&
    v[5] === aim.dir[2] &&
    Object.is(v[6], sx) &&
    Object.is(v[7], sy);
  if (same) return false;
  m.valid = true;
  m.isNull = false;
  v[0] = aim.origin[0];
  v[1] = aim.origin[1];
  v[2] = aim.origin[2];
  v[3] = aim.dir[0];
  v[4] = aim.dir[1];
  v[5] = aim.dir[2];
  v[6] = sx;
  v[7] = sy;
  return true;
}

const FINGERS = 5;
const TAP_QUEUE = 8;
/** `Input` normalizes a wheel line to 16 px, so a three-line notch is 48 px: one step. */
const WHEEL_PX_PER_STEP = 48;

interface Compiled<A extends string> {
  name: string;
  decl: IntentDecl<A>;
  handler: unknown;
  /** Hold: held by an action now. */
  actionHeld: boolean;
  /** Aim: the `aiming` last sent. */
  wasAiming: boolean;
  memo: AimMemo;
  wheel: WheelSteps | null;
}

/**
 * Builds the game's intents over an `Input` (D1 §2.13). `spec` declares them, `sink` acts on
 * them; `options` wires the camera, the router and the touch scheme.
 */
export function createIntents<A extends string, S extends IntentSpec<A>>(
  spec: S,
  sink: IntentSink<S>,
  options: IntentsOptions<A>,
): Intents {
  const { input } = options;
  const now = options.now ?? (() => performance.now());
  const cameraOf =
    typeof options.camera === 'function'
      ? (options.camera as () => RayCamera)
      : () => options.camera as RayCamera;
  const stickZone = options.stickZone ?? 'none';

  const intents: Compiled<A>[] = [];
  let tapSpec: StillHoldSpec | null = null;
  let holdSpec: StillHoldSpec | null = null;
  let stickSpec: StickSideHoldSpec<IntentAim> | null = null;
  for (const name of Object.keys(spec)) {
    const decl = spec[name]!;
    const handler = (sink as Record<string, unknown>)[name];
    if (handler === undefined) throw new Error(`createIntents: no handler for intent '${name}'`);
    if (decl.kind === 'tap' && decl.touch !== false) tapSpec ??= decl.touch ?? stillHold();
    if (decl.kind === 'hold') {
      if (decl.touch !== false) holdSpec ??= decl.touch ?? stillHold();
      if (decl.stickSide) stickSpec ??= decl.stickSide;
    }
    intents.push({
      name,
      decl,
      handler,
      actionHeld: false,
      wasAiming: true,
      memo: newMemo(),
      wheel:
        decl.kind === 'cycle' && decl.wheel
          ? new WheelSteps({ pixelsPerStep: WHEEL_PX_PER_STEP })
          : null,
    });
  }
  // One classifier per finger: the hold time is the hold intents' (else the taps'), the tolerance too.
  const fingerSpec = holdSpec ?? tapSpec ?? stillHold();
  const takesTouch = tapSpec !== null || holdSpec !== null || stickSpec !== null;

  const fingers: Finger[] = [];
  for (let i = 0; i < FINGERS; i++) {
    fingers.push({
      id: -1,
      down: false,
      role: 'act',
      stickHold: false,
      press: new StillPress(fingerSpec),
      sx: 0,
      sy: 0,
    });
  }
  let stick: Finger | null = null;
  /** The finger aimed with: the latest acting finger down. */
  let aimer: Finger | null = null;

  // The touch hold: who holds, and what the next update owes the sink.
  let holder: Finger | null = null;
  let holdFromStick = false;
  let holdLive = false;
  let holdStartDue = false;
  let holdEndDue = false;
  let holdAt = 0;
  /** The holder's last point, kept after it lifts so a late start still aims there. */
  let holdX = 0;
  let holdY = 0;
  const holdAim = newAim();
  const holdMemo = newMemo();

  const tapX = new Float64Array(TAP_QUEUE);
  const tapY = new Float64Array(TAP_QUEUE);
  let taps = 0;
  /** A touch or pen went down or up since the last update: action edges this tick are the touch's. */
  let touchSeen = false;

  const viewAim = newAim();
  let viewIsNull = true;
  let aiming = true;
  const tapAim = newAim();

  const toScreen = (f: Finger, clientX: number, clientY: number, p?: PointerRecord): void => {
    const t = options.toScreen;
    if (t) {
      const q = t(clientX, clientY);
      if (q) {
        f.sx = q.x;
        f.sy = q.y;
      }
    } else if (p) {
      f.sx = p.x;
      f.sy = p.y;
    } else {
      f.sx = clientX;
      f.sy = clientY;
    }
  };

  const rayAt = (out: AimBox, sx: number, sy: number): AimBox => {
    screenRay(cameraOf(), sx, sy, out);
    out.point[0] = sx;
    out.point[1] = sy;
    out.screen = out.point;
    return out;
  };

  const centred = (): boolean => options.centred?.() ?? false;

  const find = (id: number): Finger | null => {
    for (const f of fingers) if (f.down && f.id === id) return f;
    return null;
  };

  // ── Touch events ──

  const becameHold = (f: Finger): void => {
    if (holder !== null) return;
    if (f.role === 'stick') {
      if (!f.stickHold) return;
      // The thumb stops walking and holds: the stick frees for the next thumb.
      if (stick === f) stick = null;
      f.role = 'act';
      holdFromStick = true;
    } else {
      if (holdSpec === null) return;
      holdFromStick = false;
    }
    holder = f;
    holdAt = f.press.t0;
    holdX = f.sx;
    holdY = f.sy;
    holdStartDue = true;
  };

  const down = (
    id: number,
    clientX: number,
    clientY: number,
    time: number,
    inStick: boolean | undefined,
    p?: PointerRecord,
  ): void => {
    if (!takesTouch || input.blocked() || find(id)) return;
    let f: Finger | null = null;
    for (const s of fingers) {
      if (!s.down) {
        f = s;
        break;
      }
    }
    if (!f) return;
    touchSeen = true;
    let zone = inStick;
    if (zone === undefined) {
      zone = false;
      const d = dispatcher;
      if (stickZone !== 'none' && d) {
        const b = d.bounds();
        zone = inStickZone(clientX - b.left, b.width, stickZone, stick !== null);
      }
    }
    f.id = id;
    f.down = true;
    f.role = zone && stick === null ? 'stick' : 'act';
    f.stickHold = false;
    toScreen(f, clientX, clientY, p);
    f.press.set(f.role === 'stick' && stickSpec ? stickSpec : fingerSpec);
    f.press.begin(clientX, clientY, time);
    if (f.role === 'stick') {
      stick = f;
      if (stickSpec && holder === null && !centred()) {
        f.stickHold = stickSpec.when(rayAt(tapAim, f.sx, f.sy));
      }
    } else {
      aimer = f;
    }
  };

  const move = (
    id: number,
    clientX: number,
    clientY: number,
    time: number,
    p?: PointerRecord,
  ): void => {
    const f = find(id);
    if (!f) return;
    const was = f.press.move(clientX, clientY, time);
    toScreen(f, clientX, clientY, p);
    if (f === holder) {
      holdX = f.sx;
      holdY = f.sy;
    }
    if (was === 'pending' && f.press.kind === 'hold') becameHold(f);
  };

  const release = (f: Finger): void => {
    f.down = false;
    f.id = -1;
    if (stick === f) stick = null;
    if (aimer === f) aimer = null;
    if (holder === f) {
      holder = null;
      holdEndDue = true;
    }
  };

  const up = (
    id: number,
    clientX: number | undefined,
    clientY: number | undefined,
    time: number,
    p?: PointerRecord,
  ): void => {
    const f = find(id);
    if (!f) return;
    touchSeen = true;
    const pending = f.press.kind === 'pending';
    const result = f.press.end(time, clientX, clientY);
    if (clientX !== undefined && clientY !== undefined) toScreen(f, clientX, clientY, p);
    if (f === holder) {
      holdX = f.sx;
      holdY = f.sy;
    }
    if (pending && result === 'hold') becameHold(f);
    if (result === 'tap' && f.role === 'act' && tapSpec !== null && taps < TAP_QUEUE) {
      tapX[taps] = f.sx;
      tapY[taps] = f.sy;
      taps++;
    }
    release(f);
  };

  const cancel = (id: number): void => {
    const f = find(id);
    if (!f) return;
    touchSeen = true;
    release(f);
  };

  const cancelAll = (): void => {
    for (const f of fingers) if (f.down) release(f);
    taps = 0;
  };

  const isFinger = (p: PointerRecord): boolean => p.device === 'touch' || p.device === 'pen';
  const timeOf = (p: PointerRecord): number => now() - p.age;
  const consumer: PointerConsumer = {
    pointerDown: (p) => {
      if (!isFinger(p) || p.button !== 0) return;
      down(p.id, p.clientX, p.clientY, timeOf(p), undefined, p);
    },
    pointerMove: (p) => {
      if (isFinger(p)) move(p.id, p.clientX, p.clientY, timeOf(p), p);
    },
    pointerUp: (p) => {
      if (isFinger(p)) up(p.id, p.clientX, p.clientY, timeOf(p), p);
    },
    pointerCancel: (p) => {
      if (isFinger(p)) cancel(p.id);
    },
    cancelAll,
  };

  let dispatcher: PointerDispatcher | null = null;
  let removeConsumer: (() => void) | null = null;
  const attach = (d: PointerDispatcher): void => {
    detach();
    dispatcher = d;
    // After the look and the gestures, before the router's screen source; claimed pointers (touch zones) are not ours.
    removeConsumer = d.add(consumer, POINTER_PRIORITY.gestures + 5);
  };
  const detach = (): void => {
    removeConsumer?.();
    removeConsumer = null;
    dispatcher = null;
    cancelAll();
  };
  if (input.dispatcher) attach(input.dispatcher);
  const offAttach = input.on('attach', attach);
  const offDetach = input.on('detach', detach);

  // ── The tick ──

  const computeViewAim = (): void => {
    aiming = true;
    viewIsNull = true;
    if (centred()) return;
    const xr = options.pointers?.primary;
    if (xr && xr.device === 'xr') {
      const r = xr.ray;
      viewAim.origin[0] = r.origin[0];
      viewAim.origin[1] = r.origin[1];
      viewAim.origin[2] = r.origin[2];
      viewAim.dir[0] = r.dir[0];
      viewAim.dir[1] = r.dir[1];
      viewAim.dir[2] = r.dir[2];
      viewAim.screen = null;
      viewIsNull = false;
      return;
    }
    const last = input.lastDevice;
    if (last === 'touch' || last === 'pen') {
      const f = holder ?? aimer;
      if (!f) {
        aiming = false;
        return;
      }
      rayAt(viewAim, f.sx, f.sy);
      viewIsNull = false;
      return;
    }
    if (last === 'gamepad' || last === 'xr') return;
    const p = input.pointer;
    if (p.type === 'mouse' && p.inside) {
      rayAt(viewAim, p.x, p.y);
      viewIsNull = false;
    }
  };

  const anyOf = (actions: readonly A[] | undefined, read: (a: A) => boolean): boolean => {
    if (!actions) return false;
    for (let i = 0; i < actions.length; i++) if (read(actions[i]!)) return true;
    return false;
  };
  const pressed = (a: A): boolean => input.pressed(a);
  const held = (a: A): boolean => input.held(a);
  const released = (a: A): boolean => input.released(a);

  let holdingName: string | null = null;

  const update = (): void => {
    if (input.blocked()) {
      cancelAll();
      holdStartDue = false;
    }
    const t = now();
    // A still finger whose time is up holds.
    for (const f of fingers) {
      if (f.down && f.press.tick(t)) becameHold(f);
    }
    computeViewAim();
    const aim: AimBox | null = viewIsNull ? null : viewAim;
    const lastTouch = input.lastDevice === 'touch' || input.lastDevice === 'pen';
    const touchEdge = touchSeen || lastTouch;
    touchSeen = false;

    // Touch taps, in the order the fingers lifted.
    for (let i = 0; i < taps; i++) {
      const a = centred() ? null : rayAt(tapAim, tapX[i]!, tapY[i]!);
      for (const c of intents) {
        if (c.decl.kind === 'tap' && c.decl.touch !== false)
          (c.handler as (aim: IntentAim) => void)(a);
      }
    }
    taps = 0;

    // The touch hold.
    const takesThisHold = (c: Compiled<A>): boolean =>
      c.decl.kind === 'hold' &&
      (holdFromStick ? c.decl.stickSide !== undefined : c.decl.touch !== false);
    if (holdStartDue) {
      holdStartDue = false;
      holdLive = true;
      const a = centred() ? null : rayAt(holdAim, holdX, holdY);
      changed(holdMemo, a);
      for (const c of intents) {
        if (takesThisHold(c) && !c.actionHeld) {
          holdingName ??= c.name;
          (c.handler as HoldHandler).start(a, holdAt);
        }
      }
    } else if (holdLive && holder) {
      holdX = holder.sx;
      holdY = holder.sy;
      const a = centred() ? null : rayAt(holdAim, holdX, holdY);
      if (changed(holdMemo, a)) {
        for (const c of intents)
          if (takesThisHold(c) && !c.actionHeld) (c.handler as HoldHandler).aim?.(a);
      }
    }
    if (holdEndDue) {
      holdEndDue = false;
      if (holdLive) {
        holdLive = false;
        for (const c of intents)
          if (takesThisHold(c) && !c.actionHeld) (c.handler as HoldHandler).end();
        if (holdingName !== null && !intents.some((c) => c.actionHeld)) holdingName = null;
      }
      holdMemo.valid = false;
    }

    // Actions.
    for (const c of intents) {
      const d = c.decl;
      switch (d.kind) {
        case 'press':
          if (anyOf(d.actions, pressed)) (c.handler as (aim: IntentAim) => void)(aim);
          break;
        case 'release':
          if (anyOf(d.actions, released)) (c.handler as (aim: IntentAim) => void)(aim);
          break;
        case 'tap':
          if (!(d.touch !== false && touchEdge) && anyOf(d.actions, pressed)) {
            (c.handler as (aim: IntentAim) => void)(aim);
          }
          break;
        case 'hold': {
          const h = c.handler as HoldHandler;
          if (c.actionHeld) {
            if (!anyOf(d.actions, held)) {
              c.actionHeld = false;
              c.memo.valid = false;
              if (holdingName === c.name) holdingName = null;
              h.end();
            } else if (changed(c.memo, aim)) {
              h.aim?.(aim);
            }
          } else if (!(d.touch !== false && touchEdge) && anyOf(d.actions, pressed)) {
            if (holdLive && takesThisHold(c)) break; // a finger already holds it
            c.actionHeld = true;
            changed(c.memo, aim);
            holdingName ??= c.name;
            h.start(aim, t);
          }
          break;
        }
        case 'select': {
          const acts = d.actions;
          for (let i = 0; i < acts.length; i++) {
            if (input.pressed(acts[i]!)) {
              (c.handler as (n: number) => void)(i);
              break;
            }
          }
          break;
        }
        case 'cycle': {
          let delta = 0;
          if (anyOf(d.next, pressed)) delta++;
          if (anyOf(d.prev, pressed)) delta--;
          if (c.wheel) delta += c.wheel.add(input.pointer.wheelY, 0, t);
          if (delta !== 0) (c.handler as (delta: number) => void)(delta);
          break;
        }
        case 'aim': {
          // `aiming` false reads as null; a change of `aiming` alone counts.
          const flip = c.wasAiming !== aiming;
          c.wasAiming = aiming;
          if (changed(c.memo, aim) || flip)
            (c.handler as (aim: IntentAim, aiming: boolean) => void)(aim, aiming);
          break;
        }
      }
    }
  };

  return {
    get aim() {
      return viewIsNull ? null : viewAim;
    },
    get aiming() {
      return aiming;
    },
    get holding() {
      return holdingName;
    },
    update,
    touchDown: (id, x, y, time, inStick) => down(id, x, y, time ?? now(), inStick),
    touchMove: (id, x, y, time) => move(id, x, y, time ?? now()),
    touchUp: (id, x, y, time) => up(id, x, y, time ?? now()),
    touchCancel: cancel,
    cancelAll,
    attach,
    detach,
    dispose() {
      detach();
      offAttach();
      offDetach();
    },
  };
}
