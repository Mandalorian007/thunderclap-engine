/**
 * A physical input that can drive an action. The engine ships no default bindings;
 * the game supplies them.
 */
export type Binding =
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
   * No XR source ships yet, so this reads inactive until one is added to the router.
   */
  | { xr: XrButton; hand?: Hand };

/** Pointer buttons a `{ pointer }` binding can name. */
export type PointerButton = 'select' | 'secondary';

/** XR buttons a `{ xr }` binding can name: controller trigger, grip squeeze, hand pinch. */
export type XrButton = 'trigger' | 'squeeze' | 'pinch';

/** Which hand an XR pointer is in. */
export type Hand = 'left' | 'right';

/** The gestures `Gestures` recognises (and a `{ gesture }` binding can name). */
export type GestureKind = 'tap' | 'doubleTap' | 'longPress' | 'pan' | 'drag' | 'pinch';

export type Bindings<A extends string> = { readonly [K in A]: readonly Binding[] };

export type InputDevice = 'keyboard' | 'mouse' | 'touch' | 'pen' | 'gamepad';

/** Minimal shape of a `Gamepad` (lets tests feed plain objects). */
export interface GamepadLike {
  readonly connected?: boolean;
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
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
}
