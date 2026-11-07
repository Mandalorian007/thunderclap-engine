import { Emitter } from '../core/events';
import type { GestureDevice, Gestures } from './gestures';
import {
  bindingMatchesDevice,
  type Glyph,
  glyphForBinding,
  guessPadLayout,
  type PadLayout,
} from './glyphs';
import type { Look } from './look';
import {
  createPointerDispatcher,
  POINTER_PRIORITY,
  type PointerConsumer,
  type PointerDispatcher,
  type PointerRecord,
} from './pointer-dispatch';
import type { PointerActions, PointerRouter } from './pointer-router';
import type { InputPlayback, InputRecorder } from './record';
import type {
  ActionState,
  Binding,
  Bindings,
  GamepadLike,
  InputDevice,
  PointerState,
  PointerTransform,
  XrButton,
} from './types';

export interface InputOptions {
  /** Gamepad source. Default: `navigator.getGamepads()` (guarded). */
  getGamepads?: () => readonly (GamepadLike | null)[];
  /**
   * While this returns true (e.g. a modal UI panel is open) every action reads inactive and no
   * keys are `preventDefault`ed. Raw state keeps tracking so nothing sticks on unblock.
   */
  blocked?: () => boolean;
  /**
   * Key codes that still register while a button, link or other non-text control has focus
   * (e.g. HUD shortcuts after clicking a HUD button). They never register in text entry and
   * are not preventDefaulted on interactive targets. See `setGlobalKeys`.
   */
  globalKeys?: Iterable<string>;
  /**
   * Key codes that still register while a plain button or link has focus (`isButtonTarget`),
   * but not on form controls that use them (sliders, checkboxes, selects, text). For keys
   * like Escape and the arrows: a clicked button shouldn't swallow "back" or navigation.
   * Like global keys they are not preventDefaulted there. See `setButtonKeys`.
   */
  buttonKeys?: Iterable<string>;
  /**
   * Queue repeat taps: when a key or mouse button goes down again before the tick that saw
   * its first press, each extra tap fires `pressed` on a following tick instead of merging
   * into one. Default true; pass false for the old one-press-per-tick behaviour.
   */
  queueTaps?: boolean;
  /** Gestures to link (see `Input.setGestures`). */
  gestures?: Gestures;
  /** Pointer router to link (see `Input.setPointers`). */
  // biome-ignore lint/suspicious/noExplicitAny: any hit target type links
  pointers?: PointerRouter<any>;
  /** Look controls to link (see `Input.setLook`). */
  look?: Look;
  /**
   * Ms per `update()` tick, the clock `'hold'` and `'doubleTap'` triggers and `listen` timeouts
   * count in (ws/input-3). Default 1000/60. Pass the game's fixed step so `holdMs` means ms.
   */
  tickMs?: number;
  /** Pad button naming for `glyphFor`; default guessed from the first connected pad's `id`. */
  padLayout?: PadLayout;
}

/** `Input` events (`Input.on`). */
export interface InputEvents {
  /** `lastDevice` changed. */
  device: InputDevice;
  /** `rumble` was issued (whether or not a pad could play it). */
  rumble: RumbleOptions;
  /** `attach` built its pointer dispatcher (touch zones and other consumers join here). */
  attach: PointerDispatcher;
  /** `detach` is about to destroy the dispatcher. */
  detach: PointerDispatcher;
  /** The top action context changed (`pushContext`, `popContext`): its name, `null` for none. */
  context: string | null;
}

/**
 * What a pushed action context lets through for the actions it does not bind (ws/input-5):
 * `'unbound'` falls through to the context below, `'none'` silences them, `'all'` falls through
 * and also adds the context below's bindings to the ones it does bind.
 */
export type ContextPass = 'none' | 'unbound' | 'all';

/** `Input.pushContext` options. */
export interface ContextOptions<A extends string> {
  /** The context's own bindings; the actions must exist in the base map. Default none. */
  bindings?: Partial<Bindings<A>>;
  /** What happens to the actions it does not bind. Default `'unbound'`. */
  pass?: ContextPass;
}

/** How `shapeStick` and `Input.stick` treat the deadzone (ws/input-5). */
export type StickShape = 'radial' | 'axial' | 'scaledRadial';

/** `shapeStick` / `Input.stick` options. */
export interface StickOptions {
  /** Below this length (each axis for `'axial'`) the stick reads 0. 0..1, default 0.15. */
  deadzone?: number;
  /**
   * `'scaledRadial'` (default): a radial deadzone, the rest rescaled so its edge is 0 and full
   * deflection 1 (continuous). `'radial'`: a radial deadzone, the rest passed through as is.
   * `'axial'`: each axis has its own deadzone, passed through (cardinal snapping).
   */
  shape?: StickShape;
  /** Exponent on the shaped length (each axis for `'axial'`): 2 is finer near the centre. Default 1. */
  curve?: number;
  /** Clamp the length to 1 (diagonal keys read 1, not √2). Default true. */
  clamp?: boolean;
}

/** The phase of a pointer the feed saw (`InputFeedHook.pointer`, the recording's `ptr` lane). */
export type InputPointerPhase = 'down' | 'move' | 'up' | 'cancel' | 'leave';

const EMPTY_BINDINGS: readonly Binding[] = [];

/**
 * Shape a stick (x, y) through a deadzone into `out` and return it (ws/input-5). Pure and
 * allocation-free; `Input.stick` reads four actions through it and `Look` reads the pad sticks
 * and the touch stick through it. See `StickOptions` for the shapes.
 */
export function shapeStick(
  x: number,
  y: number,
  out: [number, number],
  opts?: StickOptions,
): [number, number] {
  const dz = opts?.deadzone ?? 0.15;
  const shape = opts?.shape ?? 'scaledRadial';
  const curve = opts?.curve ?? 1;
  const clamp = opts?.clamp ?? true;
  if (shape === 'axial') {
    let ax = Math.abs(x) <= dz ? 0 : x;
    let ay = Math.abs(y) <= dz ? 0 : y;
    if (curve !== 1) {
      ax = Math.sign(ax) * Math.abs(ax) ** curve;
      ay = Math.sign(ay) * Math.abs(ay) ** curve;
    }
    const m = Math.hypot(ax, ay);
    if (clamp && m > 1) {
      ax /= m;
      ay /= m;
    }
    out[0] = ax;
    out[1] = ay;
    return out;
  }
  const m = Math.hypot(x, y);
  if (m <= dz || m === 0) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const mag = clamp ? Math.min(1, m) : m;
  let len: number;
  if (shape === 'radial') len = mag;
  else len = dz >= 1 ? 0 : (mag - dz) / (1 - dz);
  if (curve !== 1) len **= curve;
  const k = len / m;
  out[0] = x * k;
  out[1] = y * k;
  return out;
}

/** Per-context bookkeeping. */
interface ContextEntry<A extends string> {
  name: string;
  bindings: Partial<Record<A, readonly Binding[]>>;
  pass: ContextPass;
}

/** The latest `pressed` per action for `buffered` / `consume`. */
interface PressBuffer {
  /** Tick of the latest press, -1 when none. */
  tick: number;
  used: boolean;
}

/**
 * Something that feeds action values from outside the bindings (ws/input-4): touch zones. The
 * input calls `update()` every tick before evaluating actions, then `value(action)` per action
 * (0..1, folded in like a `press` binding) and `fresh(action)` for a new press while already
 * active (a repeated button tap).
 */
export interface ActionSource {
  update?(): void;
  value(action: string): number;
  fresh?(action: string): boolean;
}

/** `Input.rumble` parameters: magnitudes 0..1, duration in ms. */
export interface RumbleOptions {
  /** Low-frequency motor, 0..1. Default 1. */
  strong?: number;
  /** High-frequency motor, 0..1. Default 1. */
  weak?: number;
  /** Duration in ms. Default 100. */
  ms?: number;
  /** Pad index; default the first connected pad that can rumble. */
  pad?: number;
}

/** `Input.listen` options. */
export interface ListenOptions {
  /** Give up (resolve `null`) after this many ms of ticks. Default: never. */
  timeoutMs?: number;
}

/** Default `holdMs` for `trigger: 'hold'`. */
export const DEFAULT_HOLD_MS = 400;
/** Default `doubleTapMs` for `trigger: 'doubleTap'`. */
export const DEFAULT_DOUBLE_TAP_MS = 300;

/**
 * Sees every low-level feed call and the pads `update()` reads, in call order. `input/record.ts`
 * builds the two implementations (`createInputRecorder`, `createInputPlayback`); `Input.onFeed`
 * installs one. Nothing here changes how `Input` evaluates bindings.
 */
export interface InputFeedHook {
  keyDown(code: string): void;
  keyUp(code: string): void;
  buttonDown(button: number): void;
  buttonUp(button: number): void;
  wheel(dx: number, dy: number): void;
  pointerAt(clientX: number, clientY: number, type: PointerState['type']): void;
  releaseAll(): void;
  /** Called once per `update()` with the pads `getGamepads` returned; what it returns is used. */
  gamepads(pads: readonly (GamepadLike | null)[]): readonly (GamepadLike | null)[];
  /**
   * Replace this tick's pads before anything reads them (ws/input-9): called once per `update()`,
   * before gestures and a linked look advance, with the pads `getGamepads` returned. A playback
   * returns its recorded snapshot here, so the linked look turns from the recorded sticks too.
   * `gamepads` then sees what this returned.
   */
  padSource?(pads: readonly (GamepadLike | null)[]): readonly (GamepadLike | null)[];
  /** Sees every `rumble` call (ws/input-3), after defaults are applied. */
  rumble?(strong: number, weak: number, ms: number, pad: number | undefined): void;
  /**
   * Sees every pointer the attached dispatcher delivers, claimed or not, primary or not
   * (ws/input-5): the recorder's `ptr` lane. The record is reused; copy what you keep.
   */
  pointer?(phase: InputPointerPhase, p: Readonly<PointerRecord>): void;
  /** The dispatcher dropped every pointer (window blur, hidden tab). */
  cancelPointers?(): void;
  /** `pushContext` (`pushed` true) or a context's removal (false). */
  context?(name: string, pushed: boolean): void;
  /** `consume(action)` was called. */
  consume?(action: string): void;
}

export interface AttachOptions {
  /** Element that receives pointer/wheel input (the canvas, or the element wrapping it). */
  pointerTarget: HTMLElement;
  /** Where keyboard events are read. Default: the pointer target's window. */
  keyTarget?: Window | HTMLElement;
  /** Set `touch-action: none` on the pointer target so touch drags don't scroll/zoom. Default true. */
  disableTouchScroll?: boolean;
  /**
   * Let a pointer claimed through the dispatcher (an orbit drag, a touch-zone thumb) still hover
   * the linked router (`hit`/`hitEnd`, no select). Default false: a claimed pointer is hidden
   * from the router until it is released.
   */
  hoverWhileClaimed?: boolean;
}

const DEFAULT_AXIS_THRESHOLD = 0.5;
const DEFAULT_BUTTON_THRESHOLD = 0.5;
/** Most repeat taps queued per key/button. */
const MAX_QUEUED_TAPS = 8;
const XR_BUTTONS: readonly XrButton[] = ['trigger', 'squeeze', 'pinch'];

/** Per-binding trigger bookkeeping (one per binding, built with the bindings; no per-tick allocs). */
interface TriggerState {
  /** Raw input was down last tick. */
  wasDown: boolean;
  /** Consecutive ticks the raw input has been down (`'hold'`). */
  downTicks: number;
  /** Tick of the previous raw down edge (`'doubleTap'`), -1 when none. */
  lastDownTick: number;
  /** Down when `rebind` installed it: reads 0 until it lifts, so the old action gets `released`. */
  latched: boolean;
}

/** What `evaluate` reports for one action (one reused object; see `evalOut`). */
interface EvalOut {
  value: number;
  pad: boolean;
  fresh: boolean;
  hold: number;
}

function newTriggerState(): TriggerState {
  return { wasDown: false, downTicks: 0, lastDownTick: -1, latched: false };
}

interface Listening<A> {
  action: A;
  resolve: (b: Binding | null) => void;
  /** Tick after which the listen times out, or Infinity. */
  deadline: number;
  /** Pad buttons (pad * 64 + button) already down when the listen began. */
  baseline: Set<number>;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'image',
  'range',
  'color',
  'file',
]);

/** True for elements where keys type text (text inputs, textareas, selects, contenteditable). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean; type?: string }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  switch (el.tagName) {
    case 'TEXTAREA':
    case 'SELECT':
      return true;
    case 'INPUT':
      return !NON_TEXT_INPUTS.has((el.type ?? '').toLowerCase());
  }
  const role = el.getAttribute?.('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

const BUTTON_INPUTS = new Set(['button', 'submit', 'reset', 'image']);

/**
 * True for plain activatable controls (buttons, links, `summary`, button-type inputs,
 * `role=button|link|menuitem`) whose own keys are only Enter and Space.
 */
export function isButtonTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { type?: string }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  switch (el.tagName) {
    case 'BUTTON':
    case 'A':
    case 'SUMMARY':
      return true;
    case 'INPUT':
      return BUTTON_INPUTS.has((el.type ?? '').toLowerCase());
  }
  const role = el.getAttribute?.('role');
  return role === 'button' || role === 'link' || role === 'menuitem';
}

function defaultGamepads(): readonly (GamepadLike | null)[] {
  try {
    return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    // Permissions policy can forbid the Gamepad API inside iframes.
    return [];
  }
}

/** True for elements that own their keyboard input (text fields, buttons, links, …). */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  switch (el.tagName) {
    case 'INPUT':
    case 'TEXTAREA':
    case 'SELECT':
    case 'BUTTON':
    case 'A':
    case 'SUMMARY':
      return true;
  }
  const role = el.getAttribute?.('role');
  return role === 'button' || role === 'textbox' || role === 'slider' || role === 'menuitem';
}

/**
 * Action-mapped input. Feed it raw events (via `attach` or the low-level methods), call
 * `update()` once per simulation tick, then query actions.
 *
 * ```ts
 * const input = new Input({ confirm: [{ key: 'Enter' }, { key: 'Space' }, { padButton: 0 }],
 *                           cancel:  [{ key: 'Escape' }, { padButton: 1 }] });
 * input.attach({ pointerTarget: canvas });
 * input.setPointerTransform(platform.clientToLogical);
 * // each tick:
 * input.update();
 * if (input.pressed('confirm')) …
 * ```
 */
export class Input<A extends string> {
  readonly pointer: PointerState = {
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    inside: false,
    down: false,
    wheelX: 0,
    wheelY: 0,
    type: 'mouse',
  };
  blocked: () => boolean;
  /** Pad button naming for `glyphFor` (`InputOptions.padLayout`); `null` guesses from the pad's `id`. */
  padLayout: PadLayout | null;
  /** Ms per tick (`InputOptions.tickMs`). */
  readonly tickMs: number;
  /** The recorder capturing this input's feed (`createInputRecorder`), until `stop()`. */
  recorder: InputRecorder | null = null;
  /** The playback feeding this input (`createInputPlayback`), until `detach()`. */
  playback: InputPlayback | null = null;
  /** Feed hooks in install order (`onFeed`). Read-only for callers. */
  private readonly feedHooks: InputFeedHook[] = [];

  /** The base bindings (below every context). */
  private map: Bindings<A>;
  /** The bindings in force: `map` with the context stack resolved over it (`map` when empty). */
  private active: Bindings<A>;
  /** Pushed contexts, bottom first. */
  private readonly contexts: ContextEntry<A>[] = [];
  /** The latest press per action (`buffered`, `consume`). */
  private readonly presses = new Map<A, PressBuffer>();
  /** True while `replayPointer` dispatches: the feed consumer then leaves the raw state alone. */
  private injecting = false;
  private readonly states = new Map<A, ActionState>();
  private readonly triggers = new Map<A, TriggerState[]>();
  private readonly events = new Emitter<InputEvents>();
  private deviceValue: InputDevice = 'keyboard';
  /** Ticks since construction (the trigger clock). */
  private tick = 0;
  private listening: Listening<A> | null = null;
  /** Last client-space pointer position fed through `pointerAt` (the orbit drag's coordinates). */
  private clientX = 0;
  private clientY = 0;
  private readonly claimFn = (_id: number, device: GestureDevice) =>
    this.look?.claimsPointer(device) ?? false;
  private readonly getGamepads: () => readonly (GamepadLike | null)[];
  private transform: PointerTransform | null = null;

  // Raw state.
  private readonly keysDown = new Set<string>();
  private readonly keysTapped = new Set<string>();
  private readonly buttonsDown = new Set<number>();
  private readonly buttonsTapped = new Set<number>();
  /** Extra taps queued per key/button (see `InputOptions.queueTaps`). */
  private readonly keyRepeats = new Map<string, number>();
  private readonly buttonRepeats = new Map<number, number>();
  private readonly queueTaps: boolean;
  private globalKeys = new Set<string>();
  private buttonKeys = new Set<string>();
  private wheelAccX = 0;
  private wheelAccY = 0;
  private prevX = 0;
  private prevY = 0;
  private boundKeys = new Set<string>();
  private boundMouse = new Set<number>();
  private boundWheel = false;
  private pads: readonly (GamepadLike | null)[] = [];
  /** `this.pads`, bound once, for a linked look (`Look.padsFromInput`). */
  private readonly readTickPads = (): readonly (GamepadLike | null)[] => this.pads;
  /** Keys and mouse buttons that were down or tapped on the last tick. */
  private readonly prevKeys = new Set<string>();
  private readonly prevButtons = new Set<number>();
  private detachFn: (() => void) | null = null;
  private gestures: Gestures | null = null;
  private pointers: PointerRouter<unknown> | null = null;
  private look: Look | null = null;
  private attached: AttachOptions | null = null;
  private dispatcherValue: PointerDispatcher | null = null;
  private readonly updatedFns: (() => void)[] = [];
  private readonly actionSources: ActionSource[] = [];
  private readonly actionReader: PointerActions = {
    bound: (action) => this.states.has(action as A),
    pressed: (action) => this.states.get(action as A)?.pressed ?? false,
  };

  constructor(bindings: Bindings<A>, opts: InputOptions = {}) {
    this.map = bindings;
    this.active = bindings;
    this.getGamepads = opts.getGamepads ?? defaultGamepads;
    this.blocked = opts.blocked ?? (() => false);
    this.queueTaps = opts.queueTaps ?? true;
    this.tickMs = opts.tickMs ?? 1000 / 60;
    this.padLayout = opts.padLayout ?? null;
    if (opts.globalKeys) this.setGlobalKeys(opts.globalKeys);
    if (opts.buttonKeys) this.setButtonKeys(opts.buttonKeys);
    this.setBindings(bindings);
    if (opts.gestures) this.setGestures(opts.gestures);
    if (opts.pointers) this.setPointers(opts.pointers);
    if (opts.look) this.setLook(opts.look);
  }

  /**
   * Device that produced the most recent input (updated on real events: keys, pointer events,
   * pad activity, XR button presses). Useful for showing the right button prompts; `on('device')`
   * fires when it changes.
   */
  get lastDevice(): InputDevice {
    return this.deviceValue;
  }
  set lastDevice(device: InputDevice) {
    if (device === this.deviceValue) return;
    this.deviceValue = device;
    this.events.emit('device', device);
  }

  /** Subscribe to an `InputEvents` event; returns the unsubscriber. */
  on<K extends keyof InputEvents>(type: K, fn: (payload: InputEvents[K]) => void): () => void {
    return this.events.on(type, fn);
  }

  /**
   * Link gestures (or unlink with `null`). Linked gestures share this input's `blocked()` and
   * pointer transform, attach to the same pointer target, and advance in `update()` before the
   * actions are read, so `{ gesture }` bindings work. Don't call `gestures.update()` yourself.
   */
  setGestures(gestures: Gestures | null): void {
    if (this.gestures === gestures) return;
    if (this.gestures && this.attached) this.gestures.detach();
    this.gestures = gestures;
    if (!gestures) return;
    gestures.blocked = () => this.blocked();
    gestures.setPointerTransform(this.transform);
    this.pointers?.setGestures(gestures);
    this.wireClaim();
    if (this.attached) {
      gestures.attach({
        pointerTarget: this.attached.pointerTarget,
        disableTouchScroll: this.attached.disableTouchScroll,
      });
    }
  }

  getGestures(): Gestures | null {
    return this.gestures;
  }

  /**
   * Link a pointer router (or unlink with `null`). A linked router shares this input's
   * `blocked()`, pointer transform (client → camera screen units) and gestures (the magnify aim),
   * attaches to the same pointer target, and is polled in `update()` before the actions are
   * read, so `{ pointer }` and `{ xr }` bindings work; after them its `select` and `secondary`
   * events follow the actions named by `selectAction` / `secondaryAction` when bound. Don't call
   * `router.update()` yourself.
   */
  setPointers<T>(router: PointerRouter<T> | null): void {
    if (this.pointers === router) return;
    if (this.pointers && this.attached) this.pointers.detach();
    this.pointers = router as PointerRouter<unknown> | null;
    if (!router) return;
    router.blocked = () => this.blocked();
    router.setPointerTransform(this.transform);
    router.setGestures(this.gestures);
    if (this.attached)
      router.attach(this.attached.pointerTarget, this.dispatcherValue ?? undefined);
  }

  getPointers(): PointerRouter<unknown> | null {
    return this.pointers;
  }

  /**
   * Link look controls (or unlink with `null`). Linked, they share this input's `blocked()`, read
   * their move keys from its raw key state, attach to the same pointer target and advance in
   * `update()`, so `look.look` and `look.move` are this tick's. Don't call `look.update()` yourself.
   */
  setLook(look: Look | null): void {
    if (this.look === look) return;
    if (this.look) {
      if (this.attached) this.look.detach();
      this.look.keyHeld = null;
      this.look.orbitFromInput = false;
      this.look.pointerTransform = null;
      this.look.padsFromInput = null;
    }
    this.look = look;
    this.wireClaim();
    if (!look) return;
    look.blocked = () => this.blocked();
    look.keyHeld = (code) => this.keysDown.has(code);
    // Orbit drags come through this input's own pointer feed, so recordings capture them.
    look.orbitFromInput = true;
    look.pointerTransform = this.transform;
    // Its pad stick reads this tick's pads, recorded and replayed with the rest (ws/input-9).
    look.padsFromInput = this.readTickPads;
    if (this.attached) look.attach(this.attached.pointerTarget, this.dispatcherValue ?? undefined);
  }

  /**
   * The pointer dispatcher `attach` built (one DOM listener set shared by the feed, gestures,
   * look, router and touch zones), or `null` while detached.
   */
  get dispatcher(): PointerDispatcher | null {
    return this.dispatcherValue;
  }

  /**
   * Run `fn` at the end of every `update()`, after gestures, look, router and triggers have
   * advanced (same tick, registration order): the place to poll a world panel or read
   * `pressed()` for the frame. Returns the remover.
   */
  onUpdated(fn: () => void): () => void {
    this.updatedFns.push(fn);
    return () => {
      const i = this.updatedFns.indexOf(fn);
      if (i >= 0) this.updatedFns.splice(i, 1);
    };
  }

  /** Add an `ActionSource` (touch zones). Returns the remover. */
  addActionSource(src: ActionSource): () => void {
    this.actionSources.push(src);
    return () => {
      const i = this.actionSources.indexOf(src);
      if (i >= 0) this.actionSources.splice(i, 1);
    };
  }

  /** `value(positive) - value(negative)`, -1..1: a move axis from two actions. */
  axis(negative: A, positive: A): number {
    return this.value(positive) - this.value(negative);
  }

  /**
   * Gives the linked gestures the look's pointer claim (an orbit drag is never a pan) when the
   * gestures have no claim of their own; takes it back when the look unlinks.
   */
  private wireClaim(): void {
    const g = this.gestures;
    if (!g) return;
    if (this.look) {
      if (!g.claim || g.claim === this.claimFn) g.claim = this.claimFn;
    } else if (g.claim === this.claimFn) g.claim = null;
  }

  getLook(): Look | null {
    return this.look;
  }

  /**
   * Replace the base bindings (below every pushed context). Action states and the input buffer
   * reset (use `rebind` to change one action and keep the rest).
   */
  setBindings(bindings: Bindings<A>): void {
    this.map = bindings;
    this.states.clear();
    this.triggers.clear();
    this.presses.clear();
    this.keyRepeats.clear();
    this.buttonRepeats.clear();
    for (const action of Object.keys(bindings) as A[]) {
      this.states.set(action, {
        pressed: false,
        held: false,
        released: false,
        value: 0,
        heldTicks: 0,
        holdProgress: 0,
      });
      this.presses.set(action, { tick: -1, used: false });
    }
    for (const c of this.contexts) this.checkContextActions(c.bindings);
    this.active = this.resolveContexts();
    for (const action of this.states.keys()) {
      this.triggers.set(action, this.active[action].map(newTriggerState));
    }
    this.rebuildBound();
  }

  /**
   * Replace one action's bindings, keeping every other action's state (ws/input-3). Rebinding
   * while an input is held is safe: the old action sees `released` next tick, and a new binding
   * whose input is already down reads inactive until it lifts and goes down again.
   *
   * With contexts pushed (ws/input-5) it writes into the top context (the action becomes one that
   * context binds); `context` names another pushed context instead, `null` the base map.
   */
  rebind(action: A, list: readonly Binding[], context?: string | null): void {
    if (!this.states.has(action)) throw new Error(`unknown action "${action}"`);
    const entry = this.contextEntry(context);
    if (entry) entry.bindings = { ...entry.bindings, [action]: list };
    else this.map = { ...this.map, [action]: list };
    // The action's trigger state is always rebuilt (latched), as before contexts.
    this.applyActive(action);
  }

  /**
   * The bindings in force (what `serializeBindings` saves): the base map with the pushed
   * contexts resolved over it. `context` reads one context's own bindings over the ones below
   * it as if it were on top (`null`: the base map).
   */
  bindings(context?: string | null): Bindings<A> {
    if (context === undefined) return this.active;
    if (context === null) return this.map;
    const i = this.contextIndex(context);
    if (i < 0) throw new Error(`no context "${context}"`);
    return this.resolveContexts(i);
  }

  // ---------------------------------------------------------------- contexts

  /**
   * Push an action context (ws/input-5): a menu, gameplay, a vehicle, each with its own bindings.
   * The top context's bindings win; `pass` says what happens to the actions it does not bind
   * (default `'unbound'`: they fall through). Pushing a name already on the stack moves it to the
   * top with the new options. Every action whose bindings in force change resets its hold
   * progress, tap counts and buffered press, and a binding whose input is already down reads
   * inactive until it lifts, so a held key never fires across the change. Returns the remover
   * (it removes this push only).
   */
  pushContext(name: string, opts: ContextOptions<A> = {}): () => void {
    const bindings = (opts.bindings ?? {}) as Partial<Record<A, readonly Binding[]>>;
    this.checkContextActions(bindings);
    const old = this.contextIndex(name);
    if (old >= 0) this.contexts.splice(old, 1);
    const entry: ContextEntry<A> = { name, bindings, pass: opts.pass ?? 'unbound' };
    this.contexts.push(entry);
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.context?.(name, true);
    this.applyActive(null);
    this.events.emit('context', name);
    return () => {
      const i = this.contexts.indexOf(entry);
      if (i >= 0) this.removeContextAt(i);
    };
  }

  /** Remove the topmost context named `name`. Returns false when none is pushed. */
  popContext(name: string): boolean {
    const i = this.contextIndex(name);
    if (i < 0) return false;
    this.removeContextAt(i);
    return true;
  }

  /** The top context's name, `null` with none pushed. */
  get context(): string | null {
    return this.contexts[this.contexts.length - 1]?.name ?? null;
  }

  /** The pushed context names, bottom first. */
  contextStack(): string[] {
    return this.contexts.map((c) => c.name);
  }

  /** Shorthand for `on('context', fn)`: the top context changed. Returns the remover. */
  onContextChange(fn: (name: string | null) => void): () => void {
    return this.events.on('context', fn);
  }

  private removeContextAt(i: number): void {
    const before = this.context;
    const [entry] = this.contexts.splice(i, 1);
    const hooks = this.feedHooks;
    for (let h = 0; h < hooks.length; h++) hooks[h]!.context?.(entry!.name, false);
    this.applyActive(null);
    const now = this.context;
    if (now !== before) this.events.emit('context', now);
  }

  private contextIndex(name: string): number {
    for (let i = this.contexts.length - 1; i >= 0; i--) {
      if (this.contexts[i]!.name === name) return i;
    }
    return -1;
  }

  /** The context `rebind` writes to: `undefined` the top one (or none), `null` none, else by name. */
  private contextEntry(context: string | null | undefined): ContextEntry<A> | null {
    if (context === null) return null;
    if (context === undefined) return this.contexts[this.contexts.length - 1] ?? null;
    const i = this.contextIndex(context);
    if (i < 0) throw new Error(`no context "${context}"`);
    return this.contexts[i]!;
  }

  private checkContextActions(bindings: Partial<Record<A, readonly Binding[]>>): void {
    for (const action of Object.keys(bindings)) {
      if (!this.states.has(action as A)) throw new Error(`unknown action "${action}"`);
    }
  }

  /** The bindings in force with contexts `0..top` on the stack (all of them by default). */
  private resolveContexts(top = this.contexts.length - 1): Bindings<A> {
    if (top < 0) return this.map;
    const out = {} as Record<A, readonly Binding[]>;
    for (const action of this.states.keys()) out[action] = this.resolveAction(action, top);
    return out;
  }

  private resolveAction(action: A, i: number): readonly Binding[] {
    if (i < 0) return this.map[action] ?? EMPTY_BINDINGS;
    const c = this.contexts[i]!;
    const own = c.bindings[action];
    if (own) return c.pass === 'all' ? [...own, ...this.resolveAction(action, i - 1)] : own;
    return c.pass === 'none' ? EMPTY_BINDINGS : this.resolveAction(action, i - 1);
  }

  /**
   * Recompute the bindings in force; every action whose list changed (element by element), and
   * `force` too, gets fresh trigger state, latched where its input is down, and loses its
   * buffered press.
   */
  private applyActive(force: A | null): void {
    const prev = this.active;
    const next = this.resolveContexts();
    this.active = next;
    for (const action of this.states.keys()) {
      const list = next[action];
      if (action !== force && sameList(prev[action], list)) continue;
      const ts = list.map(newTriggerState);
      for (let i = 0; i < list.length; i++) {
        if (this.rawValue(list[i]!) > 0) ts[i]!.latched = true;
      }
      this.triggers.set(action, ts);
      if (action !== force) {
        const b = this.presses.get(action);
        if (b) b.tick = -1;
      }
    }
    this.rebuildBound();
  }

  // ---------------------------------------------------------------- buffer

  /**
   * True if `action` went `pressed` within the last `windowMs` (counted in ticks:
   * `ceil(windowMs / tickMs)`, this tick included) and that press was not `consume`d
   * (ws/input-5). A press a few frames early still lands: `if (input.buffered('jump', 100) &&
   * grounded) { input.consume('jump'); jump(); }`. Deterministic under replay.
   */
  buffered(action: A, windowMs: number): boolean {
    const b = this.presses.get(action);
    if (!b || b.tick < 0 || b.used) return false;
    return this.tick - b.tick <= Math.ceil(windowMs / this.tickMs);
  }

  /**
   * Mark `action`'s latest press used: `buffered` no longer returns it and `pressed` reads false
   * for the rest of this tick. Returns whether there was an unused press. Feed hooks see it, so a
   * recording carries it.
   */
  consume(action: A): boolean {
    const b = this.presses.get(action);
    if (!b) return false;
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.consume?.(action);
    const st = this.states.get(action)!;
    st.pressed = false;
    if (b.tick < 0 || b.used) return false;
    b.used = true;
    return true;
  }

  // ---------------------------------------------------------------- sticks

  /**
   * Read four actions as a stick into `out` (`[x, y]`, the caller's; returned) through
   * `shapeStick` (ws/input-5): x is `value(posX) - value(negX)`, y `value(posY) - value(negY)`.
   * Keys, pad axes (bind them with `threshold: 0` for an analog read) and touch-zone sticks all
   * go through it; diagonal keys read length 1. Allocation-free.
   */
  stick(
    negX: A,
    posX: A,
    negY: A,
    posY: A,
    out: [number, number],
    opts?: StickOptions,
  ): [number, number] {
    const x = this.value(posX) - this.value(negX);
    const y = this.value(posY) - this.value(negY);
    return shapeStick(x, y, out, opts);
  }

  /**
   * The aim angle of a stick read (`Math.atan2(y, x)`, radians), `null` when it is at rest
   * (inside the deadzone). Pass the array `stick` filled.
   */
  stickAngle(out: readonly [number, number]): number | null {
    if (out[0] === 0 && out[1] === 0) return null;
    return Math.atan2(out[1], out[0]);
  }

  private rebuildBound(): void {
    this.boundKeys = new Set();
    this.boundMouse = new Set();
    this.boundWheel = false;
    for (const action of this.states.keys()) {
      for (const b of this.active[action]) this.noteBound(b);
    }
  }

  private noteBound(b: Binding): void {
    if ('key' in b) this.boundKeys.add(b.key);
    else if ('mouse' in b) this.boundMouse.add(b.mouse);
    else if ('wheel' in b) this.boundWheel = true;
    else if ('chord' in b) for (const m of b.chord) this.noteBound(m);
  }

  /**
   * Resolve with the next input the player presses (ws/input-3): a key as `{ key }`, a mouse
   * or pen button as `{ mouse }`, a pad button that was up when the listen began as
   * `{ padButton }`, an XR button as `{ xr }`. Escape, a `timeoutMs` elapsing or a newer
   * `listen` resolve `null`. The captured input is swallowed (no action sees it). Keys typed
   * into text fields never reach `Input`, so they are not captured either. The caller rebinds:
   * `const b = await input.listen('jump'); if (b) input.rebind('jump', [b]);`.
   */
  listen(action: A, opts: ListenOptions = {}): Promise<Binding | null> {
    this.listening?.resolve(null);
    return new Promise((resolve) => {
      const baseline = new Set<number>();
      this.pads.forEach((p, pi) => {
        if (!p || p.connected === false) return;
        p.buttons.forEach((b, bi) => {
          if (b.pressed) baseline.add(pi * 64 + bi);
        });
      });
      const ticks =
        opts.timeoutMs === undefined ? Infinity : Math.ceil(opts.timeoutMs / this.tickMs);
      this.listening = { action, resolve, deadline: this.tick + ticks, baseline };
    });
  }

  /** The action a `listen` is waiting for, or `null`. */
  listeningFor(): A | null {
    return this.listening?.action ?? null;
  }

  private settleListen(b: Binding | null): void {
    const l = this.listening;
    if (!l) return;
    this.listening = null;
    l.resolve(b);
  }

  /** Replace the global keys (see `InputOptions.globalKeys`). */
  setGlobalKeys(codes: Iterable<string>): void {
    this.globalKeys = new Set(codes);
  }

  /** Replace the button keys (see `InputOptions.buttonKeys`). */
  setButtonKeys(codes: Iterable<string>): void {
    this.buttonKeys = new Set(codes);
  }

  /** The bindings in force (same as `bindings()`). */
  getBindings(): Bindings<A> {
    return this.active;
  }

  /**
   * The prompt glyph for `action` on `device` (default `lastDevice`): the first binding that
   * device produces, else the action's first binding; `null` for an unbound action. Pad labels
   * follow `padLayout`, guessed from the first connected pad's `id` when unset. Reads the
   * bindings in force, so the top context's (ws/input-5).
   */
  glyphFor(action: A, device: InputDevice = this.deviceValue): Glyph | null {
    const list = this.active[action];
    if (!list || list.length === 0) return null;
    const b = list.find((x) => bindingMatchesDevice(x, device)) ?? list[0]!;
    return glyphForBinding(b, this.padLayout ?? guessPadLayout(this.firstPad()?.id));
  }

  private firstPad(index?: number): GamepadLike | null {
    if (index !== undefined) {
      const p = this.pads[index];
      return p && p.connected !== false ? p : null;
    }
    for (const p of this.pads) if (p && p.connected !== false) return p;
    return null;
  }

  /** True when `pad` (or any connected pad) has a vibration actuator `rumble` can drive. */
  rumbleSupported(pad?: number): boolean {
    return this.actuatorPad(pad) !== null;
  }

  private actuatorPad(index?: number): GamepadLike | null {
    if (index !== undefined) {
      const p = this.firstPad(index);
      return p?.vibrationActuator ? p : null;
    }
    for (const p of this.pads) if (p && p.connected !== false && p.vibrationActuator) return p;
    return null;
  }

  /**
   * Play a dual-rumble effect on `pad` (default: the first connected pad that can). Returns
   * true when an actuator took it; a no-op (false) otherwise, so games call it freely. Feed hooks
   * see every call, so a recording carries the rumbles for playback to assert.
   */
  rumble(opts: RumbleOptions = {}): boolean {
    const strong = clamp01(opts.strong ?? 1);
    const weak = clamp01(opts.weak ?? 1);
    const ms = Math.max(0, opts.ms ?? 100);
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.rumble?.(strong, weak, ms, opts.pad);
    this.events.emit('rumble', opts);
    const p = this.actuatorPad(opts.pad);
    if (!p?.vibrationActuator) return false;
    try {
      const r = p.vibrationActuator.playEffect('dual-rumble', {
        duration: ms,
        startDelay: 0,
        strongMagnitude: strong,
        weakMagnitude: weak,
      });
      (r as Promise<unknown> | undefined)?.catch?.(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install a feed hook: it sees every `keyDown`, `keyUp`, `buttonDown`, `buttonUp`, `wheel`,
   * `pointerAt` and `releaseAll` call (DOM or direct) and the pads read in `update()`, and may
   * substitute those pads. Returns the uninstaller. Used by `createInputRecorder` and
   * `createInputPlayback`; hooks never change how bindings are evaluated.
   */
  onFeed(hook: InputFeedHook): () => void {
    this.feedHooks.push(hook);
    return () => {
      const i = this.feedHooks.indexOf(hook);
      if (i >= 0) this.feedHooks.splice(i, 1);
    };
  }

  /** Install the client → game-space mapping (platform owns letterboxing). `null` = identity relative to the target. */
  setPointerTransform(fn: PointerTransform | null): void {
    this.transform = fn;
    this.gestures?.setPointerTransform(fn);
    this.pointers?.setPointerTransform(fn);
    this.dispatcherValue?.setTransform(fn);
    if (this.look) this.look.pointerTransform = fn;
  }

  // ---------------------------------------------------------------- queries

  pressed(action: A): boolean {
    return this.states.get(action)?.pressed ?? false;
  }
  held(action: A): boolean {
    return this.states.get(action)?.held ?? false;
  }
  released(action: A): boolean {
    return this.states.get(action)?.released ?? false;
  }
  value(action: A): number {
    return this.states.get(action)?.value ?? 0;
  }
  state(action: A): Readonly<ActionState> {
    const st = this.states.get(action);
    if (!st) throw new Error(`unknown action "${action}"`);
    return st;
  }
  /** True if any bound action was pressed this tick. */
  anyPressed(): boolean {
    for (const st of this.states.values()) if (st.pressed) return true;
    return false;
  }
  /** Raw key state by `KeyboardEvent.code`, ignoring bindings and blocking. */
  keyHeld(code: string): boolean {
    return this.keysDown.has(code);
  }

  // ---------------------------------------------------------------- tick

  /** Advance one tick: poll gamepads, compute edges, clear per-tick accumulators. */
  update(): void {
    // The pads are read first, so a linked look turns from the same snapshot the action map
    // reads and a recorder writes down (ws/input-9), and a playback's replace both.
    let pads = this.getGamepads();
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) {
      const src = hooks[i]!.padSource;
      if (src) pads = src(pads);
    }
    this.pads = pads;
    this.gestures?.update();
    this.look?.update();
    this.pointers?.poll();
    const blocked = this.blocked();
    for (let i = 0; i < hooks.length; i++) pads = hooks[i]!.gamepads(pads);
    this.pads = pads;
    this.tick++;
    let padActive = false;
    if (this.listening) this.pollListen();
    const sources = this.actionSources;
    for (let i = 0; i < sources.length; i++) sources[i]!.update?.();

    for (const [action, st] of this.states) {
      const v = this.evaluate(action, this.active[action], this.triggers.get(action)!);
      if (v.pad) padActive = true;
      const active = v.value > 0;
      if (blocked) {
        // Report nothing. A key held through the block must not fire `pressed` afterwards,
        // so remember it as held internally via heldTicks > 0.
        st.pressed = false;
        st.released = false;
        st.value = 0;
        st.held = false;
        st.holdProgress = 0;
        st.heldTicks = active ? Math.max(1, st.heldTicks) : 0;
        continue;
      }
      const was = st.heldTicks > 0;
      st.pressed = active && (!was || v.fresh);
      st.released = !active && was && st.held;
      st.held = active;
      st.value = v.value;
      st.holdProgress = v.hold;
      st.heldTicks = active ? st.heldTicks + 1 : 0;
      if (st.pressed) {
        const b = this.presses.get(action)!;
        b.tick = this.tick;
        b.used = false;
      }
    }

    if (padActive) this.lastDevice = 'gamepad';
    const r = this.pointers;
    if (r && (r.xrFired('trigger') || r.xrFired('squeeze') || r.xrFired('pinch'))) {
      this.lastDevice = 'xr';
    }
    if (blocked) {
      this.keyRepeats.clear();
      this.buttonRepeats.clear();
    } else {
      consumeRepeats(this.keyRepeats, this.keysTapped);
      consumeRepeats(this.buttonRepeats, this.buttonsTapped);
    }
    rememberActive(this.prevKeys, this.keysDown, this.keysTapped);
    rememberActive(this.prevButtons, this.buttonsDown, this.buttonsTapped);
    this.keysTapped.clear();
    this.buttonsTapped.clear();
    this.pointer.wheelX = this.wheelAccX;
    this.pointer.wheelY = this.wheelAccY;
    this.wheelAccX = 0;
    this.wheelAccY = 0;
    this.pointer.dx = this.pointer.x - this.prevX;
    this.pointer.dy = this.pointer.y - this.prevY;
    this.prevX = this.pointer.x;
    this.prevY = this.pointer.y;
    this.pointers?.resolve(this.actionReader);
    const fns = this.updatedFns;
    for (let i = 0; i < fns.length; i++) fns[i]!();
  }

  /** A pending `listen`: pad buttons newly down, XR presses, the timeout. Keys and mouse come via the feed. */
  private pollListen(): void {
    const l = this.listening!;
    if (this.tick > l.deadline) {
      this.settleListen(null);
      return;
    }
    for (let pi = 0; pi < this.pads.length; pi++) {
      const p = this.pads[pi];
      if (!p || p.connected === false) continue;
      for (let bi = 0; bi < p.buttons.length; bi++) {
        if (p.buttons[bi]!.pressed && !l.baseline.has(pi * 64 + bi)) {
          this.lastDevice = 'gamepad';
          this.settleListen({ padButton: bi });
          return;
        }
      }
    }
    const r = this.pointers;
    if (r) {
      for (const xr of XR_BUTTONS) {
        if (r.xrFired(xr)) {
          this.lastDevice = 'xr';
          this.settleListen({ xr });
          return;
        }
      }
    }
  }

  private readonly evalOut: EvalOut = { value: 0, pad: false, fresh: false, hold: 0 };

  /**
   * Fold a list of bindings into one value: the largest raw value after each binding's trigger
   * (`press` passes it through, `hold` gates it on `holdMs` of ticks down, `doubleTap` passes a
   * second down edge within `doubleTapMs`). `fresh` marks a new press while already active,
   * `hold` the furthest hold progress, `pad` that a pad produced the value.
   */
  private evaluate(action: A, list: readonly Binding[], ts: TriggerState[]): EvalOut {
    const out = this.evalOut;
    out.value = 0;
    out.pad = false;
    out.fresh = false;
    out.hold = 0;
    const sources = this.actionSources;
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]!;
      const v = src.value(action);
      if (v > out.value) out.value = v;
      if (v > 0 && src.fresh?.(action)) out.fresh = true;
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      const t = ts[i]!;
      const freshBefore: boolean = out.fresh;
      out.fresh = false;
      let v = this.rawValue(b);
      const rawFresh: boolean = out.fresh;
      out.fresh = freshBefore;
      const down = v > 0;
      const edge = down && (!t.wasDown || rawFresh);
      t.wasDown = down;
      if (t.latched) {
        // Installed by `rebind` while its input was down: silent until a fresh press.
        if (!down) t.latched = false;
        t.downTicks = 0;
        continue;
      }
      if (b.trigger === undefined || b.trigger === 'press') {
        if (rawFresh) out.fresh = true;
      } else if (b.trigger === 'hold') {
        const need = Math.max(1, Math.ceil((b.holdMs ?? DEFAULT_HOLD_MS) / this.tickMs));
        t.downTicks = down ? (edge ? 1 : t.downTicks + 1) : 0;
        const progress = Math.min(1, t.downTicks / need);
        if (progress > out.hold) out.hold = progress;
        if (t.downTicks < need) v = 0;
        else if (t.downTicks === need) out.fresh = true;
      } else if (b.trigger === 'doubleTap') {
        const window = Math.max(
          1,
          Math.ceil((b.doubleTapMs ?? DEFAULT_DOUBLE_TAP_MS) / this.tickMs),
        );
        if (edge && t.lastDownTick >= 0 && this.tick - t.lastDownTick <= window) {
          t.lastDownTick = -1;
          out.fresh = true;
        } else {
          if (edge) t.lastDownTick = this.tick;
          v = 0;
        }
      }
      if (v > out.value) out.value = v;
    }
    return out;
  }

  /** One binding's raw value before its trigger; sets `evalOut.fresh`/`pad` as a side effect. */
  private rawValue(b: Binding): number {
    const out = this.evalOut;
    let v = 0;
    if ('key' in b) {
      const tapped = this.keysTapped.has(b.key);
      // A queued repeat counts once the tick holding its first tap has passed.
      const queued = !tapped && (this.keyRepeats.get(b.key) ?? 0) > 0;
      // Released and pressed again since last tick: a new press, not a hold.
      if (queued || (tapped && this.prevKeys.has(b.key))) out.fresh = true;
      v = this.keysDown.has(b.key) || tapped || queued ? 1 : 0;
    } else if ('mouse' in b) {
      const tapped = this.buttonsTapped.has(b.mouse);
      const queued = !tapped && (this.buttonRepeats.get(b.mouse) ?? 0) > 0;
      if (queued || (tapped && this.prevButtons.has(b.mouse))) out.fresh = true;
      v = this.buttonsDown.has(b.mouse) || tapped || queued ? 1 : 0;
    } else if ('wheel' in b) {
      v = Math.sign(this.wheelAccY) === b.wheel ? 1 : 0;
    } else if ('padButton' in b) {
      v = this.padValue(b.pad, (p) => {
        const btn = p.buttons[b.padButton];
        if (!btn) return 0;
        const t = b.threshold ?? DEFAULT_BUTTON_THRESHOLD;
        return btn.pressed || btn.value >= t ? Math.max(btn.value, btn.pressed ? 1 : 0) : 0;
      });
      if (v > 0) out.pad = true;
    } else if ('pointer' in b) {
      const r = this.pointers;
      // A press shorter than a tick still holds for one tick (the sources keep it).
      if (r?.held(b.pointer)) {
        v = 1;
        if (r.fired(b.pointer)) out.fresh = true;
      }
    } else if ('xr' in b) {
      const r = this.pointers;
      if (r?.xrHeld(b.xr, b.hand)) {
        v = 1;
        if (r.xrFired(b.xr, b.hand)) out.fresh = true;
      }
    } else if ('gesture' in b) {
      const g = this.gestures;
      if (g?.active(b.gesture)) {
        v = 1;
        // A tap on consecutive ticks is a new press each time.
        if (g.fired(b.gesture)) out.fresh = true;
      }
    } else if ('chord' in b) {
      // Every member down, in any order. Members' own triggers are ignored.
      v = b.chord.length > 0 ? 1 : 0;
      const fresh = out.fresh;
      for (const m of b.chord) {
        if (this.rawValue(m) <= 0) {
          v = 0;
          break;
        }
      }
      out.fresh = fresh;
    } else {
      v = this.padValue(b.pad, (p) => {
        const raw = (p.axes[b.padAxis] ?? 0) * b.dir;
        const t = b.threshold ?? DEFAULT_AXIS_THRESHOLD;
        return raw >= t ? Math.min(1, raw) : 0;
      });
      if (v > 0) out.pad = true;
    }
    return v;
  }

  private padValue(index: number | undefined, read: (p: GamepadLike) => number): number {
    if (index !== undefined) {
      const p = this.pads[index];
      return p && p.connected !== false ? read(p) : 0;
    }
    let best = 0;
    for (const p of this.pads) {
      if (!p || p.connected === false) continue;
      const v = read(p);
      if (v > best) best = v;
    }
    return best;
  }

  // ---------------------------------------------------------------- low-level feed
  // Public so tests, replays and automated playtests can drive input without a DOM.

  keyDown(code: string): void {
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.keyDown(code);
    this.lastDevice = 'keyboard';
    if (this.listening) {
      this.settleListen(code === 'Escape' ? null : { key: code });
      return;
    }
    if (!this.keysDown.has(code)) {
      if (this.queueTaps && (this.keysTapped.has(code) || this.keyRepeats.has(code))) {
        queueRepeat(this.keyRepeats, code);
      } else {
        this.keysTapped.add(code);
      }
    }
    this.keysDown.add(code);
  }
  keyUp(code: string): void {
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.keyUp(code);
    this.keysDown.delete(code);
  }
  buttonDown(button: number): void {
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.buttonDown(button);
    if (this.listening) {
      this.settleListen({ mouse: button });
      return;
    }
    if (button === 0 && this.pointer.type !== 'touch') {
      this.look?.orbitDown(this.clientX, this.clientY);
    }
    if (!this.buttonsDown.has(button)) {
      if (this.queueTaps && (this.buttonsTapped.has(button) || this.buttonRepeats.has(button))) {
        queueRepeat(this.buttonRepeats, button);
      } else {
        this.buttonsTapped.add(button);
      }
    }
    this.buttonsDown.add(button);
    if (button === 0) this.pointer.down = true;
  }
  buttonUp(button: number): void {
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.buttonUp(button);
    this.buttonsDown.delete(button);
    if (button === 0) {
      this.pointer.down = false;
      this.look?.orbitUp();
    }
  }
  wheel(dx: number, dy: number): void {
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.wheel(dx, dy);
    this.wheelAccX += dx;
    this.wheelAccY += dy;
  }
  /** Set the pointer position from client coordinates (runs the transform). */
  pointerAt(clientX: number, clientY: number, type: PointerState['type'] = 'mouse'): void {
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.pointerAt(clientX, clientY, type);
    const p = this.transform ? this.transform(clientX, clientY) : { x: clientX, y: clientY };
    this.pointer.type = type;
    this.lastDevice = type;
    this.clientX = clientX;
    this.clientY = clientY;
    if (type !== 'touch') this.look?.orbitMove(clientX, clientY);
    if (p) {
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.pointer.inside = true;
    } else {
      this.pointer.inside = false;
    }
  }
  /** Release every key and button (focus loss, tab hidden). */
  releaseAll(): void {
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) hooks[i]!.releaseAll();
    this.keysDown.clear();
    this.buttonsDown.clear();
    this.keyRepeats.clear();
    this.buttonRepeats.clear();
    this.pointer.down = false;
    this.look?.orbitUp();
  }

  // ---------------------------------------------------------------- DOM

  /**
   * Listen to the DOM. Keyboard: only bound keys are `preventDefault`ed, and never when a
   * modifier (Ctrl/Meta/Alt) is held, the target is a text field/button/link, input is
   * blocked, or the document lacks focus. That keeps browser shortcuts working and avoids
   * scrolling hijacks inside the itch.io iframe.
   */
  attach(opts: AttachOptions): void {
    this.detach();
    const target = opts.pointerTarget;
    const win = target.ownerDocument.defaultView ?? window;
    const doc = target.ownerDocument;
    const keyTarget = opts.keyTarget ?? win;
    const prevTouchAction = target.style.touchAction;
    if (opts.disableTouchScroll !== false) target.style.touchAction = 'none';

    const onKeyDown = (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (isInteractiveTarget(e.target)) {
        // Global keys still count on buttons/links (never in text entry); the control keeps
        // the default action.
        const passes =
          (this.globalKeys.has(e.code) && !isTextEntryTarget(e.target)) ||
          (this.buttonKeys.has(e.code) && isButtonTarget(e.target));
        if (!e.repeat && passes) this.keyDown(e.code);
        return;
      }
      if (!e.repeat) this.keyDown(e.code);
      if (
        this.boundKeys.has(e.code) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !this.blocked() &&
        doc.hasFocus()
      ) {
        e.preventDefault();
      }
    };
    const onKeyUp = (ev: Event) => {
      this.keyUp((ev as KeyboardEvent).code);
    };
    const dispatcher = createPointerDispatcher(target, {
      transform: this.transform,
      hoverWhileClaimed: opts.hoverWhileClaimed,
    });
    this.dispatcherValue = dispatcher;
    // The feed sees every pointer, claimed or not, so recordings stay complete and identical.
    // Hooks see every record (the recording's `ptr` lane); while `replayPointer` dispatches, the
    // raw state is left alone (the playback feeds it from the `p` and `b` lanes).
    const hooks = this.feedHooks;
    const notePointer = (phase: InputPointerPhase, p: PointerRecord): boolean => {
      for (let i = 0; i < hooks.length; i++) hooks[i]!.pointer?.(phase, p);
      return this.injecting;
    };
    const consumer: PointerConsumer = {
      pointerDown: (p: PointerRecord) => {
        if (notePointer('down', p)) return;
        if (!p.primary && p.device === 'touch') return;
        this.pointerAt(p.x, p.y, p.device);
        this.buttonDown(p.button);
        // Clicking the canvas should give the iframe keyboard focus.
        if (!doc.hasFocus()) win.focus();
      },
      pointerMove: (p: PointerRecord) => {
        if (notePointer('move', p)) return;
        if (!p.primary) return;
        this.pointerAt(p.x, p.y, p.device);
      },
      pointerUp: (p: PointerRecord) => {
        if (notePointer('up', p)) return;
        if (!p.primary && p.device === 'touch') return;
        this.buttonUp(p.button);
      },
      pointerCancel: (p: PointerRecord) => {
        if (notePointer('cancel', p)) return;
        if (p.primary) this.buttonUp(0);
      },
      pointerLeave: (p: PointerRecord) => {
        if (notePointer('leave', p)) return;
        if (p.device === 'mouse') this.pointer.inside = false;
      },
      cancelAll: () => {
        for (let i = 0; i < hooks.length; i++) hooks[i]!.cancelPointers?.();
        if (!this.injecting) this.releaseAll();
      },
    };
    const removeConsumer = dispatcher.add(consumer, POINTER_PRIORITY.feed, true);
    const onWheel = (e: WheelEvent) => {
      // deltaMode 1 = lines, 2 = pages; normalise roughly to pixels.
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      this.wheel(e.deltaX * k, e.deltaY * k);
      if (this.boundWheel && !this.blocked()) e.preventDefault();
    };
    const onContextMenu = (e: Event) => {
      if (this.boundMouse.has(2) && !this.blocked()) e.preventDefault();
    };

    keyTarget.addEventListener('keydown', onKeyDown);
    keyTarget.addEventListener('keyup', onKeyUp);
    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('contextmenu', onContextMenu);

    this.attached = opts;
    this.gestures?.attach({
      pointerTarget: target,
      disableTouchScroll: opts.disableTouchScroll,
      dispatcher,
    });
    this.pointers?.attach(target, dispatcher);
    this.look?.attach(target, dispatcher);
    this.events.emit('attach', dispatcher);

    this.detachFn = () => {
      this.events.emit('detach', dispatcher);
      this.gestures?.detach();
      this.pointers?.detach();
      this.look?.detach();
      this.attached = null;
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContextMenu);
      removeConsumer();
      dispatcher.destroy();
      this.dispatcherValue = null;
      target.style.touchAction = prevTouchAction;
    };
  }

  /**
   * Dispatch a recorded pointer event on the attached pointer target (ws/input-5), so every
   * dispatcher consumer (gestures, look, touch zones, the router) sees it as it saw the original;
   * the feed's own key/button/pointer state is left to the playback's `b` and `p` lanes.
   * `createInputPlayback` calls it for the recording's `ptr` lane. `age` (ws/input-7) is how
   * many ms ago the event happened on the consumers' clocks (`PointerRecord.age`; negative is
   * ahead); omitted, it happened now. Returns false (and does nothing) while detached or
   * without `PointerEvent`.
   */
  replayPointer(
    phase: InputPointerPhase,
    id: number,
    device: 'mouse' | 'touch' | 'pen',
    clientX: number,
    clientY: number,
    button: number,
    primary: boolean,
    age = 0,
  ): boolean {
    const d = this.dispatcherValue;
    if (!d || typeof PointerEvent !== 'function') return false;
    const type =
      phase === 'down'
        ? 'pointerdown'
        : phase === 'move'
          ? 'pointermove'
          : phase === 'up'
            ? 'pointerup'
            : phase === 'cancel'
              ? 'pointercancel'
              : 'pointerleave';
    const e = new PointerEvent(type, {
      pointerId: id,
      pointerType: device,
      isPrimary: primary,
      button,
      clientX,
      clientY,
    });
    this.injecting = true;
    d.replayAge = age;
    try {
      d.target.dispatchEvent(e);
    } finally {
      this.injecting = false;
      d.replayAge = null;
    }
    return true;
  }

  detach(): void {
    this.detachFn?.();
    this.detachFn = null;
    this.releaseAll();
  }
}

/** Same length and the same binding objects in order. */
function sameList(a: readonly Binding[] | undefined, b: readonly Binding[]): boolean {
  if (a === b) return true;
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function queueRepeat<K>(repeats: Map<K, number>, k: K): void {
  repeats.set(k, Math.min(MAX_QUEUED_TAPS, (repeats.get(k) ?? 0) + 1));
}

/** One queued repeat per key is used up each tick, except on the tick of its first tap. */
function rememberActive<K>(prev: Set<K>, down: Set<K>, tapped: Set<K>): void {
  prev.clear();
  for (const k of down) prev.add(k);
  for (const k of tapped) prev.add(k);
}

function consumeRepeats<K>(repeats: Map<K, number>, tappedNow: Set<K>): void {
  for (const [k, n] of repeats) {
    if (tappedNow.has(k)) continue;
    if (n <= 1) repeats.delete(k);
    else repeats.set(k, n - 1);
  }
}
