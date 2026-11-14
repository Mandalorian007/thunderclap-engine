/**
 * Intents (ws/intents-quality, D1 P8 and §2.13): actions and pointer rays turned into the game's
 * own verbs. The game declares its intents (`press`, `release`, `tap`, `hold`, `aim`, `cycle`,
 * `select`), each bound to actions, and hands a sink with one handler per intent; every scheme
 * (keys, mouse, touch, pad, an XR controller) reaches the same handlers, aimed by a ray.
 *
 * - Actions (keys, pad buttons, the locked mouse, XR buttons) act at once.
 * - Touches and pens go through a still-press classifier: a finger lifted soon is a `tap`, one
 *   held still is a `hold` that then follows the finger, one that moves is a drag (the look's, not
 *   an intent). A thumb on the move stick holds only through `stickSideHold`. A free (unlocked)
 *   mouse does too, per button, for the intents that declare `mouse: mouseStill(...)`.
 * - The wheel steps a `cycle`, or reaches a `wheel` intent gated by modifiers (Alt, Ctrl) and by
 *   an XR ray leading (a laser's sticks come to the page as a wheel).
 * - The aim is a ray (`AimRay`), or `null` for the view's centre (the crosshair). A ray made
 *   through a screen point keeps that point (`screen`) and is made again from the camera every
 *   tick, so a hold's aim follows the view as it turns.
 *
 * Generalized from Forge Wilds' `ActionSink` (play/actions.ts), its finger roles (play/gestures.ts)
 * and its touch scheme (ui/touch.ts); the vocabulary is the game's, the plumbing is here.
 */
import {
  inStickZone,
  type MouseStillSpec,
  type StickSideHoldSpec,
  type StillHoldOptions,
  type StillHoldSpec,
  StillPress,
  stillHold,
  WheelSteps,
} from './gestures-hold';
import type { Input } from './input';
import {
  eventTime,
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
  /**
   * A free mouse's still click on `mouse.button` taps it too (ws/input-fit; default none): the
   * button's own action press is then ignored for this intent while the mouse is free (the
   * mouse is the last device and the view does not aim at its centre).
   */
  readonly mouse?: MouseStillSpec | false;
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
  /** A free mouse's still press on `mouse.button` holds it too (ws/input-fit; see `TapIntent.mouse`). */
  readonly mouse?: MouseStillSpec | false;
}

/** The view's aim: `handler(aim, aiming)` on every tick it changes. `aiming` is false while a touch scheme has no finger down. */
export interface AimIntent {
  readonly kind: 'aim';
}

/**
 * Steps a selection: `handler(+1)` on `next`, `handler(-1)` on `prev`, and wheel steps when `wheel`
 * is on (down is +1). `wheel: true` steps on every wheel; a `WheelGate` steps only on the wheels
 * it lets through (ws/input-fit).
 */
export interface CycleIntent<A extends string> {
  readonly kind: 'cycle';
  readonly next?: readonly A[];
  readonly prev?: readonly A[];
  readonly wheel?: boolean | WheelGate;
}

/**
 * Modifier keys a wheel needs: `true` held, `false` not held, absent either. Read from the wheel
 * event itself, so a trackpad's pinch (Ctrl + wheel, no key down) counts as Ctrl.
 */
export interface WheelModifiers {
  readonly alt?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

/** Which wheel events reach an intent (ws/input-fit). */
export interface WheelGate {
  readonly modifiers?: WheelModifiers;
  /**
   * Whether the wheel acts while an XR ray leads (`IntentsOptions.pointers`' primary is an XR
   * pointer: a headset's sticks come to the page as a wheel). Default false.
   */
  readonly whileRay?: boolean;
  /** The game's own gate, read per wheel event (a laser mode, a paused view). */
  readonly when?: () => boolean;
}

/**
 * The wheel (ws/input-fit): `handler(delta)` once a tick the gate let wheels through. With `steps`
 * (default true) `delta` is whole steps, at most one per event (`WheelSteps`, `pixelsPerStep`
 * default 50); with `steps: false` it is the scroll in CSS px (lines 16, pages 400). Down is
 * positive.
 */
export interface WheelIntent extends WheelGate {
  readonly kind: 'wheel';
  readonly steps?: boolean;
  readonly pixelsPerStep?: number;
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
  | SelectIntent<A>
  | WheelIntent;

/** The game's intents by name. */
export type IntentSpec<A extends string> = Readonly<Record<string, IntentDecl<A>>>;

/**
 * A hold intent's handlers. `pressedAt` is when the press began (ms on the intents' clock), earlier
 * than now for a still hold. `pointer` (ws/input-fit) is the finger's or the free mouse's pointer
 * id (`PointerEvent.pointerId`, or the id a feed method was given) for a still hold, `null` for an
 * action's.
 */
export interface HoldHandler {
  start(aim: IntentAim, pressedAt: number, pointer?: number | null): void;
  aim?(aim: IntentAim, pointer?: number | null): void;
  end(pointer?: number | null): void;
}

/** The handler an intent declaration takes. */
export type IntentHandler<D> = D extends { kind: 'hold' }
  ? HoldHandler
  : D extends { kind: 'cycle' } | { kind: 'wheel' }
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
  /** The share of the width, from `stickZone`'s side, that is the stick's (`Look`'s `touch.moveZoneShare`). Default 0.5. */
  stickZoneShare?: number;
  /** The clock (ms), the one pointer event ages are taken on. Default `performance.now`. */
  now?: () => number;
}

/**
 * Still-press timing and the stick's share, changed live (`Intents.setTiming`, ws/input-fit). Each
 * field given replaces that part; a press already down keeps the timing it began with.
 */
export interface IntentTiming {
  /** Fingers and pens (the hold intents' `touch`, else the taps'). */
  touch?: StillHoldOptions;
  /** The move stick's thumb (`stickSideHold`). */
  stickSide?: StillHoldOptions;
  /** The free mouse, every button (`mouseStill`). */
  mouse?: StillHoldOptions;
  /** `IntentsOptions.stickZoneShare`. */
  stickZoneShare?: number;
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
  /**
   * Free-mouse feed methods (ws/input-fit; tests, a game's own listeners): client CSS px, `time`
   * on the intents' clock. `id` defaults to 1. Ignored while the view aims at its centre or when
   * no intent declares `mouse` for `button`.
   */
  mouseDown(button: number, clientX: number, clientY: number, time?: number, id?: number): void;
  mouseMove(clientX: number, clientY: number, time?: number): void;
  mouseUp(clientX?: number, clientY?: number, time?: number): void;
  /** A wheel event (ws/input-fit feed): `deltaY` in `deltaMode` units, the modifiers held, `time` on the intents' clock. */
  wheel(deltaY: number, deltaMode?: number, modifiers?: WheelModifiers, time?: number): void;
  /** Change still-press timing and the stick's share without rebuilding (see `IntentTiming`). */
  setTiming(timing: IntentTiming): void;
  /** Every touch and the free mouse let go, with no tap; a hold in progress ends. */
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
  /** A gated wheel (a `wheel` intent, a cycle's `WheelGate`): its gate, steps and what is owed. */
  gate: WheelGate | null;
  gateSteps: WheelSteps | null;
  gateAcc: number;
  /** Tap or hold: the free mouse's button that drives it, or -1. */
  mouseButton: number;
}

const NO_MODIFIERS: WheelModifiers = {};

/** Mouse buttons a `mouseStill` may name (left, middle, right, back, forward). */
const MOUSE_BUTTONS = 5;

const DEFAULT_WHEEL_PX_PER_STEP = 50;

/** CSS px per wheel `deltaMode` unit: pixels, lines, pages (as `Input` normalizes them). */
const wheelPx = (deltaMode: number): number => (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);

/** Whether `mods` (the event's) meet `want`. */
function modifiersMatch(want: WheelModifiers | undefined, mods: WheelModifiers): boolean {
  if (!want) return true;
  if (want.alt !== undefined && want.alt !== (mods.alt ?? false)) return false;
  if (want.ctrl !== undefined && want.ctrl !== (mods.ctrl ?? false)) return false;
  if (want.shift !== undefined && want.shift !== (mods.shift ?? false)) return false;
  if (want.meta !== undefined && want.meta !== (mods.meta ?? false)) return false;
  return true;
}

/** A mutable copy of a still-press timing. */
interface Timing {
  tolerancePx: number;
  ms: number;
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
  let stickShare = options.stickZoneShare ?? 0.5;

  const intents: Compiled<A>[] = [];
  const mouseTiming: (Timing | undefined)[] = [];
  const mouseHoldDeclared: boolean[] = [];
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
    let mouseButton = -1;
    if ((decl.kind === 'tap' || decl.kind === 'hold') && decl.mouse) {
      const m = decl.mouse;
      if (!(m.button >= 0 && m.button < MOUSE_BUTTONS))
        throw new Error(`createIntents: intent '${name}' names mouse button ${m.button}`);
      mouseButton = m.button;
      // One timing per button: the hold intents' (else the taps'), the first declared.
      const t = mouseTiming[m.button];
      if (!t || (decl.kind === 'hold' && !mouseHoldDeclared[m.button])) {
        mouseTiming[m.button] = { tolerancePx: m.tolerancePx, ms: m.ms };
      }
      if (decl.kind === 'hold') mouseHoldDeclared[m.button] = true;
    }
    const gate: WheelGate | null =
      decl.kind === 'wheel'
        ? decl
        : decl.kind === 'cycle' && typeof decl.wheel === 'object'
          ? decl.wheel
          : null;
    const gateSteps =
      decl.kind === 'wheel'
        ? decl.steps === false
          ? null
          : new WheelSteps({ pixelsPerStep: decl.pixelsPerStep ?? DEFAULT_WHEEL_PX_PER_STEP })
        : gate
          ? new WheelSteps({ pixelsPerStep: DEFAULT_WHEEL_PX_PER_STEP })
          : null;
    intents.push({
      name,
      decl,
      handler,
      actionHeld: false,
      wasAiming: true,
      memo: newMemo(),
      wheel:
        decl.kind === 'cycle' && decl.wheel === true
          ? new WheelSteps({ pixelsPerStep: WHEEL_PX_PER_STEP })
          : null,
      gate,
      gateSteps,
      gateAcc: 0,
      mouseButton,
    });
  }
  const gated = intents.some((c) => c.gate !== null);
  // One classifier per finger: the hold time is the hold intents' (else the taps'), the tolerance too.
  const firstFinger = holdSpec ?? tapSpec ?? stillHold();
  const fingerSpec: Timing = { tolerancePx: firstFinger.tolerancePx, ms: firstFinger.ms };
  const stickTiming: Timing | null = stickSpec
    ? { tolerancePx: stickSpec.tolerancePx, ms: stickSpec.ms }
    : null;
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
  /** The holder's pointer id. */
  let holdId = -1;
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
    holdId = f.id;
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
        zone = inStickZone(clientX - b.left, b.width, stickZone, stick !== null, stickShare);
      }
    }
    f.id = id;
    f.down = true;
    f.role = zone && stick === null ? 'stick' : 'act';
    f.stickHold = false;
    toScreen(f, clientX, clientY, p);
    f.press.set(f.role === 'stick' && stickTiming ? stickTiming : fingerSpec);
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
    mouseRelease();
    mouseTaps = 0;
  };

  // ── The free mouse (ws/input-fit): one still press at a time, on a button an intent declares ──

  const mousePress = new StillPress();
  let mouseId = -1;
  let mouseBtn = -1;
  let mouseSx = 0;
  let mouseSy = 0;
  /** A free-mouse press went down or up since the last update: its button's action edges are its. */
  let mouseSeen = false;
  let mouseHoldBtn = -1;
  let mouseHoldId = -1;
  let mouseHoldAt = 0;
  let mouseHoldLive = false;
  let mouseHoldStartDue = false;
  let mouseHoldEndDue = false;
  const mouseHoldAim = newAim();
  const mouseHoldMemo = newMemo();
  const mouseTapX = new Float64Array(TAP_QUEUE);
  const mouseTapY = new Float64Array(TAP_QUEUE);
  const mouseTapB = new Int8Array(TAP_QUEUE);
  let mouseTaps = 0;

  const mouseToScreen = (clientX: number, clientY: number, p?: PointerRecord): void => {
    const t = options.toScreen;
    if (t) {
      const q = t(clientX, clientY);
      if (q) {
        mouseSx = q.x;
        mouseSy = q.y;
      }
    } else if (p) {
      mouseSx = p.x;
      mouseSy = p.y;
    } else {
      mouseSx = clientX;
      mouseSy = clientY;
    }
  };

  const mouseBecameHold = (): void => {
    if (!mouseHoldDeclared[mouseBtn] || mouseHoldLive || mouseHoldStartDue) return;
    mouseHoldBtn = mouseBtn;
    mouseHoldId = mouseId;
    mouseHoldAt = mousePress.t0;
    mouseHoldStartDue = true;
  };

  const mouseRelease = (): void => {
    if (mouseId === -1) return;
    if (mouseHoldStartDue || mouseHoldLive) mouseHoldEndDue = true;
    mouseId = -1;
    mouseBtn = -1;
  };

  const mDown = (
    button: number,
    clientX: number,
    clientY: number,
    time: number,
    id: number,
    p?: PointerRecord,
  ): void => {
    const timing = button >= 0 && button < MOUSE_BUTTONS ? mouseTiming[button] : undefined;
    if (!timing || mouseId !== -1 || input.blocked() || centred()) return;
    mouseId = id;
    mouseBtn = button;
    mouseSeen = true;
    mouseToScreen(clientX, clientY, p);
    mousePress.set(timing);
    mousePress.begin(clientX, clientY, time);
  };

  const mMove = (clientX: number, clientY: number, time: number, p?: PointerRecord): void => {
    if (mouseId === -1) return;
    const was = mousePress.move(clientX, clientY, time);
    mouseToScreen(clientX, clientY, p);
    if (was === 'pending' && mousePress.kind === 'hold') mouseBecameHold();
  };

  const mUp = (
    clientX: number | undefined,
    clientY: number | undefined,
    time: number,
    p?: PointerRecord,
  ): void => {
    if (mouseId === -1) return;
    mouseSeen = true;
    const pending = mousePress.kind === 'pending';
    const result = mousePress.end(time, clientX, clientY);
    if (clientX !== undefined && clientY !== undefined) mouseToScreen(clientX, clientY, p);
    if (pending && result === 'hold') mouseBecameHold();
    if (result === 'tap' && mouseTaps < TAP_QUEUE) {
      mouseTapX[mouseTaps] = mouseSx;
      mouseTapY[mouseTaps] = mouseSy;
      mouseTapB[mouseTaps] = mouseBtn;
      mouseTaps++;
    }
    mouseRelease();
  };

  const isFinger = (p: PointerRecord): boolean => p.device === 'touch' || p.device === 'pen';
  const timeOf = (p: PointerRecord): number => now() - p.age;
  const consumer: PointerConsumer = {
    pointerDown: (p) => {
      if (p.device === 'mouse') {
        mDown(p.button, p.clientX, p.clientY, timeOf(p), p.id, p);
        return;
      }
      if (!isFinger(p) || p.button !== 0) return;
      down(p.id, p.clientX, p.clientY, timeOf(p), undefined, p);
    },
    pointerMove: (p) => {
      if (isFinger(p)) move(p.id, p.clientX, p.clientY, timeOf(p), p);
      else if (p.id === mouseId) mMove(p.clientX, p.clientY, timeOf(p), p);
    },
    pointerUp: (p) => {
      if (isFinger(p)) up(p.id, p.clientX, p.clientY, timeOf(p), p);
      else if (p.id === mouseId) mUp(p.clientX, p.clientY, timeOf(p), p);
    },
    pointerCancel: (p) => {
      if (isFinger(p)) cancel(p.id);
      else if (p.id === mouseId) mouseRelease();
    },
    cancelAll,
  };

  // ── The wheel, gated (ws/input-fit) ──

  const wheelMods: { alt: boolean; ctrl: boolean; shift: boolean; meta: boolean } = {
    alt: false,
    ctrl: false,
    shift: false,
    meta: false,
  };
  const rayLeads = (): boolean => options.pointers?.primary?.device === 'xr';
  const feedWheel = (
    deltaY: number,
    deltaMode: number,
    mods: WheelModifiers,
    t: number,
  ): boolean => {
    if (input.blocked()) return false;
    let took = false;
    const ray = rayLeads();
    for (const c of intents) {
      const g = c.gate;
      if (g === null) continue;
      if (ray && !g.whileRay) continue;
      if (!modifiersMatch(g.modifiers, mods)) continue;
      if (g.when && !g.when()) continue;
      took = true;
      if (c.gateSteps) c.gateAcc += c.gateSteps.add(deltaY, deltaMode, t);
      else c.gateAcc += deltaY * wheelPx(deltaMode);
    }
    return took;
  };
  const onWheel = (e: WheelEvent): void => {
    wheelMods.alt = e.altKey === true;
    wheelMods.ctrl = e.ctrlKey === true;
    wheelMods.shift = e.shiftKey === true;
    wheelMods.meta = e.metaKey === true;
    // A wheel an intent took is never the page's (a trackpad's pinch would zoom it).
    if (feedWheel(e.deltaY, e.deltaMode, wheelMods, eventTime(e.timeStamp, now)))
      e.preventDefault();
  };
  let wheelTarget: HTMLElement | null = null;

  let dispatcher: PointerDispatcher | null = null;
  let removeConsumer: (() => void) | null = null;
  const attach = (d: PointerDispatcher): void => {
    detach();
    dispatcher = d;
    // After the look and the gestures, before the router's screen source; claimed pointers (touch zones) are not ours.
    removeConsumer = d.add(consumer, POINTER_PRIORITY.gestures + 5);
    if (gated) {
      wheelTarget = d.target;
      wheelTarget.addEventListener('wheel', onWheel, { passive: false });
    }
  };
  const detach = (): void => {
    removeConsumer?.();
    removeConsumer = null;
    dispatcher = null;
    wheelTarget?.removeEventListener('wheel', onWheel);
    wheelTarget = null;
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
      mouseHoldStartDue = false;
    }
    const t = now();
    // A still finger whose time is up holds.
    for (const f of fingers) {
      if (f.down && f.press.tick(t)) becameHold(f);
    }
    if (mouseId !== -1 && mousePress.tick(t)) mouseBecameHold();
    computeViewAim();
    const aim: AimBox | null = viewIsNull ? null : viewAim;
    const lastTouch = input.lastDevice === 'touch' || input.lastDevice === 'pen';
    const touchEdge = touchSeen || lastTouch;
    touchSeen = false;
    // The free mouse's own button presses are its still press's, not the actions'.
    const mouseEdge = mouseSeen || (input.lastDevice === 'mouse' && !centred());
    mouseSeen = false;

    // Free-mouse clicks, in order.
    for (let i = 0; i < mouseTaps; i++) {
      const a = centred() ? null : rayAt(tapAim, mouseTapX[i]!, mouseTapY[i]!);
      const b = mouseTapB[i]!;
      for (const c of intents) {
        if (c.decl.kind === 'tap' && c.mouseButton === b)
          (c.handler as (aim: IntentAim) => void)(a);
      }
    }
    mouseTaps = 0;

    // The free mouse's hold.
    const takesMouseHold = (c: Compiled<A>): boolean =>
      c.decl.kind === 'hold' && c.mouseButton === mouseHoldBtn && !c.actionHeld;
    if (mouseHoldStartDue) {
      mouseHoldStartDue = false;
      mouseHoldLive = true;
      const a = centred() ? null : rayAt(mouseHoldAim, mouseSx, mouseSy);
      changed(mouseHoldMemo, a);
      for (const c of intents) {
        if (takesMouseHold(c)) {
          holdingName ??= c.name;
          (c.handler as HoldHandler).start(a, mouseHoldAt, mouseHoldId);
        }
      }
    } else if (mouseHoldLive && mouseId !== -1) {
      const a = centred() ? null : rayAt(mouseHoldAim, mouseSx, mouseSy);
      if (changed(mouseHoldMemo, a)) {
        for (const c of intents)
          if (takesMouseHold(c)) (c.handler as HoldHandler).aim?.(a, mouseHoldId);
      }
    }
    if (mouseHoldEndDue) {
      mouseHoldEndDue = false;
      if (mouseHoldLive) {
        mouseHoldLive = false;
        for (const c of intents) if (takesMouseHold(c)) (c.handler as HoldHandler).end(mouseHoldId);
        if (holdingName !== null && !holdLive && !intents.some((c) => c.actionHeld))
          holdingName = null;
      }
      mouseHoldMemo.valid = false;
      mouseHoldBtn = -1;
    }

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
          (c.handler as HoldHandler).start(a, holdAt, holdId);
        }
      }
    } else if (holdLive && holder) {
      holdX = holder.sx;
      holdY = holder.sy;
      const a = centred() ? null : rayAt(holdAim, holdX, holdY);
      if (changed(holdMemo, a)) {
        for (const c of intents)
          if (takesThisHold(c) && !c.actionHeld) (c.handler as HoldHandler).aim?.(a, holdId);
      }
    }
    if (holdEndDue) {
      holdEndDue = false;
      if (holdLive) {
        holdLive = false;
        for (const c of intents)
          if (takesThisHold(c) && !c.actionHeld) (c.handler as HoldHandler).end(holdId);
        if (holdingName !== null && !mouseHoldLive && !intents.some((c) => c.actionHeld))
          holdingName = null;
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
          if (
            !(d.touch !== false && touchEdge) &&
            !(c.mouseButton >= 0 && mouseEdge) &&
            anyOf(d.actions, pressed)
          ) {
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
              h.end(null);
            } else if (changed(c.memo, aim)) {
              h.aim?.(aim, null);
            }
          } else if (
            !(d.touch !== false && touchEdge) &&
            !(c.mouseButton >= 0 && mouseEdge) &&
            anyOf(d.actions, pressed)
          ) {
            if (holdLive && takesThisHold(c)) break; // a finger already holds it
            if (mouseHoldLive && c.mouseButton === mouseHoldBtn) break; // so does the free mouse
            c.actionHeld = true;
            changed(c.memo, aim);
            holdingName ??= c.name;
            h.start(aim, t, null);
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
          delta += c.gateAcc;
          c.gateAcc = 0;
          if (delta !== 0) (c.handler as (delta: number) => void)(delta);
          break;
        }
        case 'wheel': {
          const delta = c.gateAcc;
          c.gateAcc = 0;
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
    mouseDown: (button, x, y, time, id) => mDown(button, x, y, time ?? now(), id ?? 1),
    mouseMove: (x, y, time) => mMove(x, y, time ?? now()),
    mouseUp: (x, y, time) => mUp(x, y, time ?? now()),
    wheel: (deltaY, deltaMode = 0, modifiers = NO_MODIFIERS, time) => {
      feedWheel(deltaY, deltaMode, modifiers, time ?? now());
    },
    setTiming(timing) {
      const apply = (to: Timing | null | undefined, from: StillHoldOptions | undefined): void => {
        if (!to || !from) return;
        if (from.tolerancePx !== undefined) to.tolerancePx = from.tolerancePx;
        if (from.ms !== undefined) to.ms = from.ms;
      };
      apply(fingerSpec, timing.touch);
      apply(stickTiming, timing.stickSide);
      for (let b = 0; b < MOUSE_BUTTONS; b++) apply(mouseTiming[b], timing.mouse);
      if (timing.stickZoneShare !== undefined) stickShare = timing.stickZoneShare;
    },
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
