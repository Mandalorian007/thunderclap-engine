/**
 * The pointer router: every pointing source (mouse, pen, touch, the pad cursor, later XR) becomes
 * a world-space ray through the active camera; the game's `HitTester`s say what each ray hits;
 * the router keeps the nearest hit per pointer and reports `hit`, `hitEnd`, `select` and
 * `secondary`. A game reads the hit and the `select` action; it never sees which device pointed.
 */
import { Emitter } from '../core/events';
import type { Gestures } from './gestures';
import type { PointerDispatcher } from './pointer-dispatch';
import {
  type PointerDevice,
  type PointerSample,
  type PointerSource,
  ScreenPointers,
  type XrButtons,
} from './pointer-sources';
import { createHit, createRay, type Hit, type HitTester, type Ray, type RayCamera } from './rays';
import type { Hand, PointerButton, PointerTransform, XrButton } from './types';

/** One live pointer after routing: its sample plus its nearest hit. Reused; read, don't keep. */
export interface RoutedPointer<T = unknown> {
  readonly source: PointerSource;
  readonly key: number;
  readonly device: PointerDevice;
  readonly hand: Hand | null;
  /** Camera screen units, or `NaN` for XR pointers. */
  readonly x: number;
  readonly y: number;
  readonly ray: Ray;
  readonly select: boolean;
  readonly secondary: boolean;
  readonly xr: Readonly<XrButtons> | null;
  /** The nearest hit this tick, or `null`. */
  readonly hit: Hit<T> | null;
}

/** Payload of every router event. Reused between emits: read it in the listener or copy it. */
export interface PointerHitEvent<T = unknown> {
  pointer: RoutedPointer<T>;
  /** `hit`/`hitEnd`: the hit that started or ended. `select`/`secondary`: the pointer's hit, or `null`. */
  hit: Hit<T> | null;
}

export interface PointerRouterEvents<T = unknown> {
  /** A pointer started hitting a target (or moved onto a different one). */
  hit: PointerHitEvent<T>;
  /** A pointer stopped hitting a target (moved off, ended, or input was blocked). */
  hitEnd: PointerHitEvent<T>;
  /** Select on a pointer (see `PointerRouterOptions.selectAction`). */
  select: PointerHitEvent<T>;
  /** Secondary on a pointer (see `PointerRouterOptions.secondaryAction`). */
  secondary: PointerHitEvent<T>;
  /**
   * A pointer moved this tick (position or ray changed), at most once per pointer per tick,
   * after its `hit`/`hitEnd` (ws/input-4). `hit` is the target under it now, or `null`.
   */
  moved: PointerHitEvent<T>;
  /** A pointer's select or secondary button went up this tick (`hit` is what it is over now). */
  released: PointerHitEvent<T>;
}

export interface PointerRouterOptions<T = unknown> {
  /** The camera rays go through: a camera, or a getter read each tick (`() => renderer.camera`). */
  camera?: RayCamera | (() => RayCamera | null) | null;
  /** Hit testers, in tie-break order (see `addTester`). */
  testers?: readonly HitTester<T>[];
  /** Extra sources besides the built-in screen source (`router.screen`), e.g. a `PadCursor`. */
  sources?: readonly PointerSource[];
  /**
   * The action that selects, when the router is linked to an `Input` (`input.setPointers`) whose
   * bindings have it: `select` then fires on the tick that action is pressed, on the primary
   * pointer. Unbound or unlinked, `select` fires when a pointer's select button goes down.
   * Default `'select'`.
   */
  selectAction?: string;
  /** Like `selectAction`, for `secondary`. Default `'secondary'`. */
  secondaryAction?: string;
  /** While true no pointer hits anything (a modal is open). `Input.setPointers` shares the input's. */
  blocked?: () => boolean;
}

/** The slice of `Input` the router reads after the actions are evaluated. */
export interface PointerActions {
  bound(action: string): boolean;
  pressed(action: string): boolean;
}

interface Track<T> {
  source: PointerSource;
  key: number;
  device: PointerDevice;
  hand: Hand | null;
  x: number;
  y: number;
  ray: Ray;
  select: boolean;
  secondary: boolean;
  xr: XrButtons | null;
  hit: Hit<T> | null;
  /** Storage behind `hit`. */
  readonly store: Hit<T>;
  readonly storeNormal: [number, number, number];
  /** Storage for the `hitEnd` payload. */
  readonly ended: Hit<T>;
  readonly endedNormal: [number, number, number];
  readonly xrStore: XrButtons;
  readonly xrPrev: XrButtons;
  seen: boolean;
  prevSelect: boolean;
  prevSecondary: boolean;
  /** Held through a mute (see `route`): reads up until the source lets it go. */
  maskSelect: boolean;
  maskSecondary: boolean;
  readonly xrMask: XrButtons;
  /** Pressed this tick (button went down). */
  pressSelect: boolean;
  pressSecondary: boolean;
  /** Tick of the last move or press (the primary pointer is the latest). */
  active: number;
}

const XR_BUTTONS: readonly XrButton[] = ['trigger', 'squeeze', 'pinch'];

/**
 * Routes pointers to hits. Call `update()` once per tick (an `Input` linked with
 * `input.setPointers(router)` calls it from its own `update()`).
 */
export class PointerRouter<T = unknown> {
  /** The built-in source for mouse, pen and touch (attached by `attach`). */
  readonly screen = new ScreenPointers();
  /** Live pointers this tick (empty while blocked). Reused array. */
  readonly pointers: RoutedPointer<T>[] = [];
  /** The pointer that moved or pressed most recently, or `null`. */
  primary: RoutedPointer<T> | null = null;
  blocked: () => boolean;
  selectAction: string;
  secondaryAction: string;

  private readonly events = new Emitter<PointerRouterEvents<T>>();
  private cameraOpt: RayCamera | (() => RayCamera | null) | null;
  private readonly testers: HitTester<T>[] = [];
  private readonly sources: PointerSource[] = [];
  private readonly tracks: Track<T>[] = [];
  private readonly pool: Track<T>[] = [];
  private tick = 0;
  private isBlocked = false;
  /** `mute()` with no argument: every source, including ones added later. */
  private muteAll = false;
  private readonly muted: PointerSource[] = [];
  /** Sources `unmute()` just woke: their pointers held through the mute are not new presses. */
  private wakeAll = false;
  private readonly waking: PointerSource[] = [];
  private target: HTMLElement | null = null;
  private readonly best: Hit<T> = createHit<T>(undefined as T);
  private readonly bestNormal: [number, number, number] = [0, 0, 0];
  private readonly evHit: PointerHitEvent<T> = { pointer: null as never, hit: null };
  private readonly evEnd: PointerHitEvent<T> = { pointer: null as never, hit: null };
  private readonly evSelect: PointerHitEvent<T> = { pointer: null as never, hit: null };
  private readonly evMoved: PointerHitEvent<T> = { pointer: null as never, hit: null };
  private readonly evReleased: PointerHitEvent<T> = { pointer: null as never, hit: null };

  constructor(opts: PointerRouterOptions<T> = {}) {
    this.cameraOpt = opts.camera ?? null;
    this.blocked = opts.blocked ?? (() => false);
    this.selectAction = opts.selectAction ?? 'select';
    this.secondaryAction = opts.secondaryAction ?? 'secondary';
    this.sources.push(this.screen);
    for (const s of opts.sources ?? []) this.sources.push(s);
    for (const t of opts.testers ?? []) this.testers.push(t);
  }

  /** The camera rays go through now. */
  get camera(): RayCamera | null {
    const c = this.cameraOpt;
    return typeof c === 'function' ? c() : c;
  }
  /** Set the camera, or a getter read each tick. */
  set camera(c: RayCamera | (() => RayCamera | null) | null) {
    this.cameraOpt = c;
  }

  /** The primary pointer's hit, or `null`. */
  get hit(): Hit<T> | null {
    return this.primary?.hit ?? null;
  }

  on<K extends keyof PointerRouterEvents<T>>(
    type: K,
    fn: (e: PointerRouterEvents<T>[K]) => void,
  ): () => void {
    return this.events.on(type, fn);
  }

  /**
   * Add a hit tester; returns its remover. The nearest hit over all testers wins; equal
   * distances go to the tester added first.
   */
  addTester(t: HitTester<T>): () => void {
    this.testers.push(t);
    return () => {
      const i = this.testers.indexOf(t);
      if (i >= 0) this.testers.splice(i, 1);
    };
  }

  /** Add a pointer source (a `PadCursor`, later an XR source); returns its remover. */
  addSource(s: PointerSource): () => void {
    this.sources.push(s);
    if (this.target) s.attach?.(this.target);
    return () => {
      const i = this.sources.indexOf(s);
      if (i < 0) return;
      this.sources.splice(i, 1);
      s.detach?.();
    };
  }

  /**
   * Mute pointer sources (ws/input-11): a muted source is still polled, but its pointers are
   * dropped before routing, so they hit nothing and fire nothing. With no argument every source
   * is muted, the screen source and sources added later included. Samples marked `synthetic`
   * (the pointers `Input.replayPointer` dispatches) are never muted, so a replay keeps its own
   * pointers while the real ones are silenced. A pointer that holds select or secondary when
   * its source is muted is released on the next tick: `hitEnd`, then `released` with `hit:
   * null` (it let go over nothing, as a cancel), and `held` reads false. Calls add up until
   * `unmute()`.
   */
  mute(sources?: readonly PointerSource[]): void {
    if (!sources) {
      this.muteAll = true;
      return;
    }
    for (const s of sources) if (!this.muted.includes(s)) this.muted.push(s);
  }

  /**
   * Lift every mute. A button a woken pointer still holds reads up (not held, not pressed) until
   * it is let go, so a press held through the mute never lands as a new one; its next press does.
   */
  unmute(): void {
    if (this.muteAll) this.wakeAll = true;
    for (const s of this.muted) if (!this.waking.includes(s)) this.waking.push(s);
    this.muteAll = false;
    this.muted.length = 0;
  }

  /** True while `source` is muted (by `mute()` or `mute([source])`). */
  isMuted(source: PointerSource): boolean {
    return this.muteAll || this.muted.includes(source);
  }

  /** Client → camera screen units for the screen source (`Input.setPointers` shares the input's). */
  setPointerTransform(fn: PointerTransform | null): void {
    this.screen.setPointerTransform(fn);
  }

  /** Gestures whose magnify aim steers a single touch (`Input.setPointers` shares the input's). */
  setGestures(g: Gestures | null): void {
    this.screen.setGestures(g);
  }

  /** Listen on `target` (every source with an `attach`). `Input.attach` does this when linked. */
  attach(target: HTMLElement, dispatcher?: PointerDispatcher): void {
    this.detach();
    this.target = target;
    for (const s of this.sources) s.attach?.(target, dispatcher);
  }

  detach(): void {
    if (!this.target) return;
    this.target = null;
    for (const s of this.sources) s.detach?.();
  }

  // ---------------------------------------------------------------- queries

  /**
   * True while any pointer holds `button`. Raw: it keeps tracking while blocked (as `Input`'s
   * keys do), so a press held through a block is not a new press after it.
   */
  held(button: PointerButton): boolean {
    for (const t of this.tracks) if (button === 'select' ? t.select : t.secondary) return true;
    return false;
  }

  /** True when a pointer pressed `button` this tick (never while blocked). */
  fired(button: PointerButton): boolean {
    for (const p of this.pointers) {
      const t = p as Track<T>;
      if (button === 'select' ? t.pressSelect : t.pressSecondary) return true;
    }
    return false;
  }

  /** True while an XR pointer (in `hand`, or either) holds `button`. Raw, like `held`. */
  xrHeld(button: XrButton, hand?: Hand): boolean {
    for (const t of this.tracks) {
      if (t.xr && (!hand || t.hand === hand) && t.xr[button]) return true;
    }
    return false;
  }

  /** True when an XR pointer (in `hand`, or either) pressed `button` this tick. */
  xrFired(button: XrButton, hand?: Hand): boolean {
    if (this.isBlocked) return false;
    for (const p of this.pointers) {
      const t = p as Track<T>;
      if (t.xr && (!hand || t.hand === hand) && t.xr[button] && !t.xrPrev[button]) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- tick

  /**
   * Poll every source, hit-test each pointer and report hover changes, then report presses
   * (button edges; a linked `Input` reports them from its actions instead, see `selectAction`).
   */
  update(): void {
    this.poll();
    this.resolve(null);
  }

  /**
   * First half of `update()`: sources, rays, hits, `hit`/`hitEnd`. `Input` calls it before
   * evaluating `{ pointer }` and `{ xr }` bindings.
   */
  poll(): void {
    this.tick++;
    const blocked = this.blocked();
    this.isBlocked = blocked;
    const camera = this.camera;
    for (const t of this.tracks) t.seen = false;

    for (const src of this.sources) {
      const samples = src.poll(camera);
      const muted = this.isMuted(src);
      const woken = this.wakeAll || this.waking.includes(src);
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!;
        if (muted && !s.synthetic) continue;
        this.route(src, s, blocked, woken);
      }
    }
    this.wakeAll = false;
    this.waking.length = 0;

    // Pointers that were not reported have ended.
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i]!;
      if (t.seen) continue;
      this.endHit(t);
      // A muted pointer holding a button lets go over nothing, never a stuck press.
      if ((t.select || t.secondary) && this.isMuted(t.source)) this.release(t, blocked);
      if (this.primary === t) this.primary = null;
      this.tracks.splice(i--, 1);
      this.pool.push(t);
    }

    const list = this.pointers;
    list.length = 0;
    if (blocked) {
      this.primary = null;
      return;
    }
    let primary: Track<T> | null = null;
    for (const t of this.tracks) {
      list.push(t);
      if (!primary || t.active > primary.active) primary = t;
    }
    this.primary = primary;
  }

  /**
   * Second half of `update()`: `select` and `secondary`. With `actions` (a linked `Input`), an
   * action the bindings have fires on the primary pointer when pressed; otherwise each pointer
   * whose button went down fires.
   */
  resolve(actions: PointerActions | null): void {
    if (this.pointers.length === 0) return;
    this.resolveButton('select', this.selectAction, actions);
    this.resolveButton('secondary', this.secondaryAction, actions);
  }

  private resolveButton(kind: PointerButton, action: string, actions: PointerActions | null): void {
    const ev = this.evSelect;
    if (actions?.bound(action)) {
      const p = this.primary;
      if (!p || !actions.pressed(action)) return;
      ev.pointer = p;
      ev.hit = p.hit;
      this.events.emit(kind, ev);
      return;
    }
    for (const p of this.pointers) {
      const t = p as Track<T>;
      if (!(kind === 'select' ? t.pressSelect : t.pressSecondary)) continue;
      ev.pointer = t;
      ev.hit = t.hit;
      this.events.emit(kind, ev);
    }
  }

  /** End `t`'s held buttons and report `released` (over nothing) unless blocked. */
  private release(t: Track<T>, blocked: boolean): void {
    t.prevSelect = t.select;
    t.prevSecondary = t.secondary;
    t.select = false;
    t.secondary = false;
    t.pressSelect = false;
    t.pressSecondary = false;
    if (t.xr) for (const b of XR_BUTTONS) t.xrPrev[b] = t.xr[b] = false;
    if (blocked) return;
    const ev = this.evReleased;
    ev.pointer = t;
    ev.hit = null;
    this.events.emit('released', ev);
  }

  /**
   * `quiet`: the source was just unmuted, so a button a new track already holds was held through
   * the mute: it reads up (not held, never a press) until it is let go, as a key held through a
   * detach does.
   */
  private route(src: PointerSource, s: PointerSample, blocked: boolean, quiet: boolean): void {
    let t: Track<T> | null = null;
    for (const c of this.tracks) {
      if (c.source === src && c.key === s.key) {
        t = c;
        break;
      }
    }
    const isNew = t === null;
    if (!t) {
      t = this.pool.pop() ?? this.newTrack();
      t.source = src;
      t.key = s.key;
      t.maskSelect = quiet && s.select;
      t.maskSecondary = quiet && s.secondary;
      for (const b of XR_BUTTONS) t.xrMask[b] = quiet && s.xr?.[b] === true;
      t.hit = null;
      this.tracks.push(t);
    } else {
      t.prevSelect = t.select;
      t.prevSecondary = t.secondary;
    }
    t.seen = true;
    if (!s.select) t.maskSelect = false;
    if (!s.secondary) t.maskSecondary = false;
    const select = s.select && !t.maskSelect;
    const secondary = s.secondary && !t.maskSecondary;
    if (isNew) {
      t.prevSelect = select && blocked;
      t.prevSecondary = secondary && blocked;
    }
    const ray = t.ray;
    const moved =
      isNew ||
      s.x !== t.x ||
      s.y !== t.y ||
      s.ray.origin[0] !== ray.origin[0] ||
      s.ray.origin[1] !== ray.origin[1] ||
      s.ray.origin[2] !== ray.origin[2] ||
      s.ray.dir[0] !== ray.dir[0] ||
      s.ray.dir[1] !== ray.dir[1] ||
      s.ray.dir[2] !== ray.dir[2];
    t.device = s.device;
    t.hand = s.hand;
    t.x = s.x;
    t.y = s.y;
    for (let i = 0; i < 3; i++) {
      ray.origin[i] = s.ray.origin[i]!;
      ray.dir[i] = s.ray.dir[i]!;
    }
    if (s.xr) {
      const prev = t.xr ? t.xrStore : null;
      for (const b of XR_BUTTONS) {
        if (!s.xr[b]) t.xrMask[b] = false;
        const v = s.xr[b] && !t.xrMask[b];
        t.xrPrev[b] = prev ? prev[b] : blocked && v;
        t.xrStore[b] = v;
      }
      t.xr = t.xrStore;
    } else {
      t.xr = null;
    }
    // While blocked buttons track (so a press held through the block is not a new press), but
    // nothing is pressed and nothing is hit.
    t.select = select;
    t.secondary = secondary;
    t.pressSelect = !blocked && select && !t.prevSelect;
    t.pressSecondary = !blocked && secondary && !t.prevSecondary;
    if (moved || t.pressSelect || t.pressSecondary) t.active = this.tick;
    if (blocked) {
      this.endHit(t);
      return;
    }
    this.test(t);
    if (moved) {
      const ev = this.evMoved;
      ev.pointer = t;
      ev.hit = t.hit;
      this.events.emit('moved', ev);
    }
    if ((t.prevSelect && !select) || (t.prevSecondary && !secondary)) {
      const ev = this.evReleased;
      ev.pointer = t;
      ev.hit = t.hit;
      this.events.emit('released', ev);
    }
  }

  /** Nearest hit for `t`'s ray; report `hitEnd`/`hit` when the target changes. */
  private test(t: Track<T>): void {
    const best = this.best;
    let found = false;
    for (const tester of this.testers) {
      const h = tester(t.ray);
      if (!h || (found && h.distance >= best.distance)) continue;
      found = true;
      copyHit(best, this.bestNormal, h);
    }
    const prev = t.hit;
    if (!found) {
      this.endHit(t);
      return;
    }
    const changed = !prev || prev.target !== best.target;
    if (changed) this.endHit(t);
    copyHit(t.store, t.storeNormal, best);
    t.hit = t.store;
    if (changed) {
      const ev = this.evHit;
      ev.pointer = t;
      ev.hit = t.hit;
      this.events.emit('hit', ev);
    }
  }

  private endHit(t: Track<T>): void {
    if (!t.hit) return;
    copyHit(t.ended, t.endedNormal, t.hit);
    t.hit = null;
    const ev = this.evEnd;
    ev.pointer = t;
    ev.hit = t.ended;
    this.events.emit('hitEnd', ev);
  }

  private newTrack(): Track<T> {
    return {
      source: this.screen,
      key: 0,
      device: 'mouse',
      hand: null,
      x: Number.NaN,
      y: Number.NaN,
      ray: createRay(),
      select: false,
      secondary: false,
      xr: null,
      hit: null,
      store: createHit<T>(undefined as T),
      storeNormal: [0, 0, 0],
      ended: createHit<T>(undefined as T),
      endedNormal: [0, 0, 0],
      xrStore: { trigger: false, squeeze: false, pinch: false },
      xrPrev: { trigger: false, squeeze: false, pinch: false },
      seen: false,
      prevSelect: false,
      prevSecondary: false,
      maskSelect: false,
      maskSecondary: false,
      xrMask: { trigger: false, squeeze: false, pinch: false },
      pressSelect: false,
      pressSecondary: false,
      active: 0,
    };
  }
}

function copyHit<T>(dst: Hit<T>, normal: [number, number, number], src: Hit<T>): void {
  dst.point[0] = src.point[0];
  dst.point[1] = src.point[1];
  dst.point[2] = src.point[2];
  dst.distance = src.distance;
  dst.target = src.target;
  if (src.normal) {
    normal[0] = src.normal[0];
    normal[1] = src.normal[1];
    normal[2] = src.normal[2];
    dst.normal = normal;
  } else {
    dst.normal = null;
  }
}

/**
 * A pointer router (see `PointerRouter`). Link it to the action map with
 * `input.setPointers(router)`; add `planeTester`/`aabbTester` or the game's own testers.
 */
export function createPointerRouter<T = unknown>(
  opts: PointerRouterOptions<T> = {},
): PointerRouter<T> {
  return new PointerRouter<T>(opts);
}
