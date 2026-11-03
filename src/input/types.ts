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
  | { padAxis: number; dir: 1 | -1; pad?: number; threshold?: number };

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
