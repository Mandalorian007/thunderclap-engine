import type {
  ActionState,
  Binding,
  Bindings,
  GamepadLike,
  InputDevice,
  PointerState,
  PointerTransform,
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
}

export interface AttachOptions {
  /** Element that receives pointer/wheel input (the canvas, or the element wrapping it). */
  pointerTarget: HTMLElement;
  /** Where keyboard events are read. Default: the pointer target's window. */
  keyTarget?: Window | HTMLElement;
  /** Set `touch-action: none` on the pointer target so touch drags don't scroll/zoom. Default true. */
  disableTouchScroll?: boolean;
}

const DEFAULT_AXIS_THRESHOLD = 0.5;
const DEFAULT_BUTTON_THRESHOLD = 0.5;
/** Most repeat taps queued per key/button. */
const MAX_QUEUED_TAPS = 8;

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
  /** Device that produced the most recent input. Useful for showing the right button prompts. */
  lastDevice: InputDevice = 'keyboard';
  blocked: () => boolean;

  private bindings: Bindings<A>;
  private readonly states = new Map<A, ActionState>();
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

  constructor(bindings: Bindings<A>, opts: InputOptions = {}) {
    this.bindings = bindings;
    this.getGamepads = opts.getGamepads ?? defaultGamepads;
    this.blocked = opts.blocked ?? (() => false);
    this.queueTaps = opts.queueTaps ?? true;
    if (opts.globalKeys) this.setGlobalKeys(opts.globalKeys);
    if (opts.buttonKeys) this.setButtonKeys(opts.buttonKeys);
    this.setBindings(bindings);
  }

  /** Replace all bindings (e.g. after the player rebinds). Action states reset. */
  setBindings(bindings: Bindings<A>): void {
    this.bindings = bindings;
    this.states.clear();
    this.keyRepeats.clear();
    this.buttonRepeats.clear();
    this.boundKeys = new Set();
    this.boundMouse = new Set();
    this.boundWheel = false;
    for (const action of Object.keys(bindings) as A[]) {
      this.states.set(action, {
        pressed: false,
        held: false,
        released: false,
        value: 0,
        heldTicks: 0,
      });
      for (const b of bindings[action]) {
        if ('key' in b) this.boundKeys.add(b.key);
        else if ('mouse' in b) this.boundMouse.add(b.mouse);
        else if ('wheel' in b) this.boundWheel = true;
      }
    }
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
    return this.bindings;
  }

  /** Install the client → game-space mapping (platform owns letterboxing). `null` = identity relative to the target. */
  setPointerTransform(fn: PointerTransform | null): void {
    this.transform = fn;
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
    const blocked = this.blocked();
    this.pads = this.getGamepads();
    let padActive = false;

    for (const [action, st] of this.states) {
      const v = this.evaluate(this.bindings[action]);
      if (v.pad) padActive = true;
      const active = v.value > 0;
      if (blocked) {
        // Report nothing. A key held through the block must not fire `pressed` afterwards,
        // so remember it as held internally via heldTicks > 0.
        st.pressed = false;
        st.released = false;
        st.value = 0;
        st.held = false;
        st.heldTicks = active ? Math.max(1, st.heldTicks) : 0;
        continue;
      }
      const was = st.heldTicks > 0;
      st.pressed = active && (!was || v.fresh);
      st.released = !active && was && st.held;
      st.held = active;
      st.value = v.value;
      st.heldTicks = active ? st.heldTicks + 1 : 0;
    }

    if (padActive) this.lastDevice = 'gamepad';
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
  }

  private readonly evalOut = { value: 0, pad: false, fresh: false };

  private evaluate(list: readonly Binding[]): { value: number; pad: boolean; fresh: boolean } {
    const out = this.evalOut;
    out.value = 0;
    out.pad = false;
    out.fresh = false;
    for (const b of list) {
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
      } else {
        v = this.padValue(b.pad, (p) => {
          const raw = (p.axes[b.padAxis] ?? 0) * b.dir;
          const t = b.threshold ?? DEFAULT_AXIS_THRESHOLD;
          return raw >= t ? Math.min(1, raw) : 0;
        });
        if (v > 0) out.pad = true;
      }
      if (v > out.value) out.value = v;
    }
    return out;
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
    if (!this.keysDown.has(code)) {
      if (this.queueTaps && (this.keysTapped.has(code) || this.keyRepeats.has(code))) {
        queueRepeat(this.keyRepeats, code);
      } else {
        this.keysTapped.add(code);
      }
    }
    this.keysDown.add(code);
    this.lastDevice = 'keyboard';
  }
  keyUp(code: string): void {
    this.keysDown.delete(code);
  }
  buttonDown(button: number): void {
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
    this.buttonsDown.delete(button);
    if (button === 0) this.pointer.down = false;
  }
  wheel(dx: number, dy: number): void {
    this.wheelAccX += dx;
    this.wheelAccY += dy;
  }
  /** Set the pointer position from client coordinates (runs the transform). */
  pointerAt(clientX: number, clientY: number, type: PointerState['type'] = 'mouse'): void {
    const p = this.transform ? this.transform(clientX, clientY) : { x: clientX, y: clientY };
    this.pointer.type = type;
    this.lastDevice = type;
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
    this.keysDown.clear();
    this.buttonsDown.clear();
    this.keyRepeats.clear();
    this.buttonRepeats.clear();
    this.pointer.down = false;
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

    const clientToLocal = (e: PointerEvent | WheelEvent) => {
      if (this.transform) return [e.clientX, e.clientY] as const;
      const r = target.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };

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
    const pointerType = (e: PointerEvent): PointerState['type'] =>
      e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse';
    const onPointerDown = (e: PointerEvent) => {
      if (!e.isPrimary && e.pointerType === 'touch') return;
      const [x, y] = clientToLocal(e);
      this.pointerAt(x, y, pointerType(e));
      this.buttonDown(Math.max(e.button, 0));
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events have no active pointer.
      }
      // Clicking the canvas should give the iframe keyboard focus.
      if (!doc.hasFocus()) win.focus();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      const [x, y] = clientToLocal(e);
      this.pointerAt(x, y, pointerType(e));
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!e.isPrimary && e.pointerType === 'touch') return;
      this.buttonUp(Math.max(e.button, 0));
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (e.isPrimary) this.buttonUp(0);
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.pointer.inside = false;
    };
    const onWheel = (e: WheelEvent) => {
      // deltaMode 1 = lines, 2 = pages; normalise roughly to pixels.
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      this.wheel(e.deltaX * k, e.deltaY * k);
      if (this.boundWheel && !this.blocked()) e.preventDefault();
    };
    const onContextMenu = (e: Event) => {
      if (this.boundMouse.has(2) && !this.blocked()) e.preventDefault();
    };
    const onBlur = () => this.releaseAll();
    const onVisibility = () => {
      if (doc.visibilityState === 'hidden') this.releaseAll();
    };

    keyTarget.addEventListener('keydown', onKeyDown);
    keyTarget.addEventListener('keyup', onKeyUp);
    target.addEventListener('pointerdown', onPointerDown);
    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerCancel);
    target.addEventListener('pointerleave', onPointerLeave);
    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('contextmenu', onContextMenu);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibility);

    this.detachFn = () => {
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerCancel);
      target.removeEventListener('pointerleave', onPointerLeave);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContextMenu);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
      target.style.touchAction = prevTouchAction;
    };
  }

  detach(): void {
    this.detachFn?.();
    this.detachFn = null;
    this.releaseAll();
  }
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
