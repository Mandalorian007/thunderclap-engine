/**
 * Test-only `Host` (ws/testing-kit): everything a page or shell offers the game, in memory and
 * under the test's control. Storage is a `MemoryStorage`, the lifecycle moves on `setState`,
 * haptics, fullscreen, links, copies and wake-lock requests are written down, the safe area is
 * set by hand, and frames run only when the test calls `runFrame`. Nothing touches the DOM.
 */
import type {
  HapticImpact,
  HapticNotification,
  Host,
  HostFullscreen,
  HostHaptics,
  HostInsets,
  HostKind,
  HostLifecycle,
  HostLifecycleState,
  HostSafeArea,
  HostStorage,
} from '../host';
import type { CopyResult, EmbedContext, LinkActivation, OpenResult } from '../platform';
import { MemoryStorage, type StorageLike } from '../save';

/** `createFakeHost` options. Every field has a default that makes the host fully capable. */
export interface FakeHostOptions {
  /** `Host.kind`. Default `'web'`. */
  kind?: HostKind;
  /** `Host.embed`. Default `'top'`. */
  embed?: EmbedContext;
  /**
   * The save backend `storage.open()` returns. Default a fresh `MemoryStorage`; `null` is a host
   * with no working storage (`open()` returns null), as when the browser blocks it.
   */
  storage?: StorageLike | null;
  /** The lifecycle state at creation. Default `'active'`. */
  state?: HostLifecycleState;
  /** The safe-area insets at creation, CSS px. Missing sides are 0. */
  safeArea?: Partial<HostInsets>;
  /** `fullscreen.available()`. Default true. When false, `toggle` resolves false and changes nothing. */
  fullscreen?: boolean;
  /** `haptics.available()`. Default true. Calls are recorded either way. */
  haptics?: boolean;
  /** What `openExternal` answers. Default `'opened'`. */
  openResult?: OpenResult;
  /** What `copyText` resolves to. Default `'copied'`. */
  copyResult?: CopyResult;
  /** `clipboardWriteAllowed()`. Default true. */
  clipboardWriteAllowed?: boolean;
  /** Timestamp of the first `runFrame` that is given none, ms. Default 0. */
  startTime?: number;
  /** How far a `runFrame` without a timestamp moves frame time, ms. Default 1000 / 60. */
  frameMs?: number;
}

/** One haptic call, in the order made. */
export type FakeHapticCall =
  | { readonly op: 'impact'; readonly style: HapticImpact }
  | { readonly op: 'notification'; readonly kind: HapticNotification }
  | { readonly op: 'vibrate'; readonly ms: number };

/**
 * A wake-lock stub. `Host` has no wake-lock facet yet; this records what a game that keeps the
 * screen on through its own code would ask for, so the test can assert it.
 */
export interface FakeWakeLock {
  /** True between a `request()` and the next `release()`. */
  readonly held: boolean;
  /** Every call, in order. */
  readonly calls: readonly ('request' | 'release')[];
  /** Takes the lock. Resolves true. */
  request(): Promise<boolean>;
  /** Drops the lock; a second release does nothing more than record the call. */
  release(): void;
}

/** A full `Host` the test drives. Every optional facet is present. */
export interface FakeHost extends Host {
  readonly lifecycle: HostLifecycle;
  readonly haptics: HostHaptics;
  readonly safeArea: HostSafeArea;
  /** The backend `storage.open()` returns (the same object every call), or null. */
  readonly memory: StorageLike | null;
  /** Moves the lifecycle; watchers run only when the state changes. */
  setState(state: HostLifecycleState): void;
  /** Sets some or all insets; watchers run only when a value changes. */
  setSafeArea(insets: Partial<HostInsets>): void;
  /** Every haptic call, in order. */
  readonly hapticCalls: readonly FakeHapticCall[];
  /** Every `fullscreen.toggle` call with its options, in order. */
  readonly fullscreenCalls: readonly { readonly lockLandscape?: boolean }[];
  /** Every `openExternal` call, in order. */
  readonly opened: readonly { readonly url: string; readonly activation: LinkActivation }[];
  /** Every `copyText` argument, in order. */
  readonly copied: readonly string[];
  /** The wake-lock stub. */
  readonly wakeLock: FakeWakeLock;
  /** Frame requests waiting for the next `runFrame`. */
  readonly pendingFrames: number;
  /** The timestamp of the last `runFrame`, ms (`startTime` before the first one). */
  readonly frameTime: number;
  /**
   * Runs every frame requested before this call, with `timeMs` (default: the last frame time
   * plus `frameMs`). A callback that requests another frame is queued for the next call, so one
   * `runFrame` is one display frame. Returns how many callbacks ran.
   */
  runFrame(timeMs?: number): number;
}

/** A recording, fully controllable `Host` for unit tests. See `FakeHostOptions`. */
export function createFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const memory = opts.storage === undefined ? new MemoryStorage() : opts.storage;
  const frameMs = opts.frameMs ?? 1000 / 60;
  let frameTime = opts.startTime ?? 0;
  let firstFrame = true;
  let nextHandle = 1;
  let queue = new Map<number, (timeMs: number) => void>();
  /** The batch `runFrame` is running, so a callback can cancel one later in it. */
  let running: Map<number, (timeMs: number) => void> | null = null;

  let state: HostLifecycleState = opts.state ?? 'active';
  const stateWatchers = new Set<(s: HostLifecycleState) => void>();
  const lifecycle: HostLifecycle = {
    state: () => state,
    watch(fn) {
      stateWatchers.add(fn);
      return () => stateWatchers.delete(fn);
    },
  };

  const insets: HostInsets = { top: 0, right: 0, bottom: 0, left: 0, ...opts.safeArea };
  const insetWatchers = new Set<(i: Readonly<HostInsets>) => void>();
  const safeArea: HostSafeArea = {
    insets: () => insets,
    watch(fn) {
      insetWatchers.add(fn);
      return () => insetWatchers.delete(fn);
    },
  };

  const hapticCalls: FakeHapticCall[] = [];
  const hapticsOn = opts.haptics ?? true;
  const haptics: HostHaptics = {
    available: () => hapticsOn,
    impact: (style) => hapticCalls.push({ op: 'impact', style }),
    notification: (kind) => hapticCalls.push({ op: 'notification', kind }),
    vibrate: (ms) => hapticCalls.push({ op: 'vibrate', ms }),
  };

  const fullscreenCalls: { lockLandscape?: boolean }[] = [];
  const fullscreenOn = opts.fullscreen ?? true;
  let fullscreenActive = false;
  const fullscreenWatchers = new Set<(on: boolean) => void>();
  const fullscreen: HostFullscreen = {
    available: () => fullscreenOn,
    active: () => fullscreenActive,
    toggle(topts) {
      fullscreenCalls.push(
        topts?.lockLandscape === undefined ? {} : { lockLandscape: topts.lockLandscape },
      );
      if (!fullscreenOn) return Promise.resolve(false);
      fullscreenActive = !fullscreenActive;
      for (const fn of [...fullscreenWatchers]) fn(fullscreenActive);
      return Promise.resolve(fullscreenActive);
    },
    watch(fn) {
      fullscreenWatchers.add(fn);
      return () => fullscreenWatchers.delete(fn);
    },
  };

  const storage: HostStorage = { kind: 'memory', open: () => memory };

  const wakeCalls: ('request' | 'release')[] = [];
  let wakeHeld = false;
  const wakeLock: FakeWakeLock = {
    get held() {
      return wakeHeld;
    },
    calls: wakeCalls,
    request() {
      wakeCalls.push('request');
      wakeHeld = true;
      return Promise.resolve(true);
    },
    release() {
      wakeCalls.push('release');
      wakeHeld = false;
    },
  };

  const opened: { url: string; activation: LinkActivation }[] = [];
  const copied: string[] = [];
  const openResult = opts.openResult ?? 'opened';
  const copyResult = opts.copyResult ?? 'copied';
  const clipboardOk = opts.clipboardWriteAllowed ?? true;

  return {
    kind: opts.kind ?? 'web',
    embed: opts.embed ?? 'top',
    requestFrame(cb) {
      const handle = nextHandle++;
      queue.set(handle, cb);
      return handle;
    },
    cancelFrame(handle) {
      queue.delete(handle);
      running?.delete(handle);
    },
    openExternal(url, o) {
      opened.push({ url, activation: o.activation });
      return openResult;
    },
    copyText(text) {
      copied.push(text);
      return Promise.resolve(copyResult);
    },
    clipboardWriteAllowed: () => clipboardOk,
    fullscreen,
    storage,
    lifecycle,
    haptics,
    safeArea,
    memory,
    setState(next) {
      if (next === state) return;
      state = next;
      for (const fn of [...stateWatchers]) fn(next);
    },
    setSafeArea(patch) {
      let changed = false;
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const v = patch[side];
        if (v !== undefined && v !== insets[side]) {
          insets[side] = v;
          changed = true;
        }
      }
      if (changed) for (const fn of [...insetWatchers]) fn(insets);
    },
    hapticCalls,
    fullscreenCalls,
    opened,
    copied,
    wakeLock,
    get pendingFrames() {
      return queue.size;
    },
    get frameTime() {
      return frameTime;
    },
    runFrame(timeMs) {
      frameTime = timeMs ?? (firstFrame ? frameTime : frameTime + frameMs);
      firstFrame = false;
      const run = queue;
      queue = new Map();
      running = run;
      let count = 0;
      try {
        for (const cb of run.values()) {
          count++;
          cb(frameTime);
        }
      } finally {
        running = null;
      }
      return count;
    },
  };
}
