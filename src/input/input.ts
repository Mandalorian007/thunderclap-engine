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
  /** Sees every `rumble` call (ws/input-3), after defaults are applied. */
  rumble?(strong: number, weak: number, ms: number, pad: number | undefined): void;
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

  private map: Bindings<A>;
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
    }
    this.look = look;
    this.wireClaim();
    if (!look) return;
    look.blocked = () => this.blocked();
    look.keyHeld = (code) => this.keysDown.has(code);
    // Orbit drags come through this input's own pointer feed, so recordings capture them.
    look.orbitFromInput = true;
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

  /** Replace all bindings. Action states reset (use `rebind` to change one action and keep the rest). */
  setBindings(bindings: Bindings<A>): void {
    this.map = bindings;
    this.states.clear();
    this.triggers.clear();
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
      this.triggers.set(action, bindings[action].map(newTriggerState));
    }
    this.rebuildBound();
  }

  /**
   * Replace one action's bindings, keeping every other action's state (ws/input-3). Rebinding
   * while an input is held is safe: the old action sees `released` next tick, and a new binding
   * whose input is already down reads inactive until it lifts and goes down again.
   */
  rebind(action: A, list: readonly Binding[]): void {
    if (!this.states.has(action)) throw new Error(`unknown action "${action}"`);
    this.map = { ...this.map, [action]: list };
    const ts = list.map(newTriggerState);
    for (let i = 0; i < list.length; i++) {
      if (this.rawValue(list[i]!) > 0) ts[i]!.latched = true;
    }
    this.triggers.set(action, ts);
    this.rebuildBound();
  }

  /** The current bindings map (what `serializeBindings` saves). */
  bindings(): Bindings<A> {
    return this.map;
  }

  private rebuildBound(): void {
    this.boundKeys = new Set();
    this.boundMouse = new Set();
    this.boundWheel = false;
    for (const action of Object.keys(this.map) as A[]) {
      for (const b of this.map[action]) this.noteBound(b);
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

  getBindings(): Bindings<A> {
    return this.map;
  }

  /**
   * The prompt glyph for `action` on `device` (default `lastDevice`): the first binding that
   * device produces, else the action's first binding; `null` for an unbound action. Pad labels
   * follow `padLayout`, guessed from the first connected pad's `id` when unset.
   */
  glyphFor(action: A, device: InputDevice = this.deviceValue): Glyph | null {
    const list = this.map[action];
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
    this.gestures?.update();
    this.look?.update();
    this.pointers?.poll();
    const blocked = this.blocked();
    let pads = this.getGamepads();
    const hooks = this.feedHooks;
    for (let i = 0; i < hooks.length; i++) pads = hooks[i]!.gamepads(pads);
    this.pads = pads;
    this.tick++;
    let padActive = false;
    if (this.listening) this.pollListen();
    const sources = this.actionSources;
    for (let i = 0; i < sources.length; i++) sources[i]!.update?.();

    for (const [action, st] of this.states) {
      const v = this.evaluate(action, this.map[action], this.triggers.get(action)!);
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
    const consumer: PointerConsumer = {
      pointerDown: (p: PointerRecord) => {
        if (!p.primary && p.device === 'touch') return;
        this.pointerAt(p.x, p.y, p.device);
        this.buttonDown(p.button);
        // Clicking the canvas should give the iframe keyboard focus.
        if (!doc.hasFocus()) win.focus();
      },
      pointerMove: (p: PointerRecord) => {
        if (!p.primary) return;
        this.pointerAt(p.x, p.y, p.device);
      },
      pointerUp: (p: PointerRecord) => {
        if (!p.primary && p.device === 'touch') return;
        this.buttonUp(p.button);
      },
      pointerCancel: (p: PointerRecord) => {
        if (p.primary) this.buttonUp(0);
      },
      pointerLeave: (p: PointerRecord) => {
        if (p.device === 'mouse') this.pointer.inside = false;
      },
      cancelAll: () => this.releaseAll(),
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

  detach(): void {
    this.detachFn?.();
    this.detachFn = null;
    this.releaseAll();
  }
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
