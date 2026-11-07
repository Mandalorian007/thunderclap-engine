/**
 * How a binding turns its raw input into an action (ws/input-3). `'press'` (the default) is
 * active while the input is down. `'hold'` becomes active once the input has stayed down for
 * `holdMs` (400) and stays active until it lifts; `ActionState.holdProgress` runs 0..1 meanwhile.
 * `'doubleTap'` is active for one tick when the input goes down a second time within
 * `doubleTapMs` (300) of the previous down. Times are measured in ticks of `Input.update()`
 * (`InputOptions.tickMs`, default 1000/60), so a recording replays identically.
 */
export type Trigger = 'press' | 'hold' | 'doubleTap';

/** The trigger fields every `Binding` may carry. */
export interface TriggerOptions {
  trigger?: Trigger;
  /** Ms down before a `'hold'` fires. Default 400. */
  holdMs?: number;
  /** Most ms between the two downs of a `'doubleTap'`. Default 300. */
  doubleTapMs?: number;
}

/** The input half of a `Binding`, without its trigger fields. */
export type BindingSource =
  /** `KeyboardEvent.code` (layout-independent), e.g. `'KeyZ'`, `'Space'`, `'ArrowLeft'`, `'Escape'`. */
  | { key: string }
  /** `PointerEvent.button`: 0 primary (also touch/pen contact), 1 middle, 2 secondary. */
  | { mouse: number }
  /** Wheel scrolled this tick. `1` = deltaY > 0 (down / towards the user), `-1` = up. */
  | { wheel: 1 | -1 }
  /** Standard-mapping gamepad button index (0 = A/Cross, 9 = Start …). `pad` omitted = any pad. */
  | { padButton: number; pad?: number; threshold?: number }
  /** Gamepad axis past `threshold` (default 0.5) in direction `dir`. Value is analog 0..1. */
  | { padAxis: number; dir: 1 | -1; pad?: number; threshold?: number }
  /**
   * A gesture from the `Gestures` linked with `Input.setGestures`. `tap` and `doubleTap` press
   * for one tick; `longPress` holds until its pointer lifts; `pan`, `drag` and `pinch` hold
   * from their start until they end. Reads inactive when no gestures are linked.
   */
  | { gesture: GestureKind }
  /**
   * A button of any pointer the linked `PointerRouter` routes (`Input.setPointers`): `select` is
   * mouse button 0, a touch or pen contact, the pad cursor's press button and an XR trigger or
   * pinch; `secondary` is mouse button 2, the pad cursor's second button and an XR squeeze.
   * Pressed when one goes down; held while any is down. Inactive with no router linked.
   */
  | { pointer: PointerButton }
  /**
   * An XR controller or hand button from an XR `PointerSource` (`hand` omitted = either hand).
   * `createGame({ xr })` adds an `XrPointerSource` to `ctx.pointers` for the session; with no XR
   * source on the router this reads inactive.
   */
  | { xr: XrButton; hand?: Hand }
  /**
   * A chord (ws/input-3): active while every member binding is down, in any order; `pressed`
   * fires once when the last one lands. Members are plain bindings (their own triggers are
   * ignored); the members may also drive actions of their own.
   */
  | { chord: readonly Binding[] };

/**
 * A physical input that can drive an action, with optional trigger fields (`trigger`, `holdMs`,
 * `doubleTapMs`). The engine ships no default bindings; the game supplies them.
 */
export type Binding = BindingSource & TriggerOptions;

/** Pointer buttons a `{ pointer }` binding can name. */
export type PointerButton = 'select' | 'secondary';

/** XR buttons a `{ xr }` binding can name: controller trigger, grip squeeze, hand pinch. */
export type XrButton = 'trigger' | 'squeeze' | 'pinch';

/** Which hand an XR pointer is in. */
export type Hand = 'left' | 'right';

/** The gestures `Gestures` recognises (and a `{ gesture }` binding can name). */
export type GestureKind = 'tap' | 'doubleTap' | 'longPress' | 'pan' | 'drag' | 'pinch';

export type Bindings<A extends string> = { readonly [K in A]: readonly Binding[] };

/** The device that last produced input (`Input.lastDevice`); `'xr'` once an XR button fires. */
export type InputDevice = 'keyboard' | 'mouse' | 'touch' | 'pen' | 'gamepad' | 'xr';

/** The `Gamepad.vibrationActuator` shape `Input.rumble` drives. */
export interface GamepadActuatorLike {
  readonly type?: string;
  playEffect(
    type: string,
    params: {
      duration: number;
      startDelay?: number;
      strongMagnitude?: number;
      weakMagnitude?: number;
    },
  ): Promise<unknown> | unknown;
}

/** Minimal shape of a `Gamepad` (lets tests feed plain objects). */
export interface GamepadLike {
  readonly connected?: boolean;
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
  /** `Gamepad.id`, used to guess the button layout for prompt glyphs. */
  readonly id?: string;
  /** `Gamepad.vibrationActuator`, when the pad can rumble. */
  readonly vibrationActuator?: GamepadActuatorLike | null;
}

/** Maps a client-space point (CSS px, `clientX/Y`) into game space, or `null` if outside it. */
export type PointerTransform = (
  clientX: number,
  clientY: number,
) => { x: number; y: number } | null;

export interface PointerState {
  /** Position in game space (after the transform). Holds the last inside position when outside. */
  x: number;
  y: number;
  /** Movement since the previous `update()`, game space. */
  dx: number;
  dy: number;
  /** True when the last known position mapped inside the game rect. */
  inside: boolean;
  /** Primary button / contact currently down. */
  down: boolean;
  /** Wheel accumulated since the previous `update()` (pixels, normalised). */
  wheelX: number;
  wheelY: number;
  /** Device of the most recent pointer event. */
  type: 'mouse' | 'touch' | 'pen';
}

export interface ActionState {
  /** True on the first tick the action became active. */
  pressed: boolean;
  /** True while active (also for a tap that started and ended between two ticks). */
  held: boolean;
  /** True on the first tick after the action stopped being active. */
  released: boolean;
  /** Analog value 0..1 (digital inputs give 0 or 1). */
  value: number;
  /** Consecutive ticks held (0 when not held). */
  heldTicks: number;
  /**
   * For `'hold'` bindings: how far the longest press in progress is towards `holdMs`, 0..1 (1
   * once the hold fired, 0 while nothing is down or the action has no hold binding).
   */
  holdProgress: number;
}
