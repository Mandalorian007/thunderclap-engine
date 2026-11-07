/**
 * The host: what the page or shell the game runs in can do for it (D-041, ARCHITECTURE.md
 * "Host"). The engine reaches the outside world only through this: frame scheduling, opening a
 * link, copying text, fullscreen, and where saves are kept. `createWebHost()` (host/web.ts) is the browser,
 * at top level or in a frame such as itch.io's; `createElectronHost()` (`@thunderclap/host-electron`)
 * satisfies the same interface through a preload bridge and adds `window`;
 * `createCapacitorHost()` (`@thunderclap/host-capacitor`) fills it from Capacitor's plugins for a
 * store app; `createXrHost()` (host/xr.ts) takes frames from an XR session and delegates the
 * rest to the host it wraps. The optional facets `lifecycle`, `haptics` and `safeArea` (ws/host-mobile) are what
 * a mobile shell adds and the web host can also answer.
 */
import type { CopyResult, EmbedContext, LinkActivation, OpenResult } from '../platform/links';
import type { StorageLike } from '../save/storage';

/** Which implementation this is. */
export type HostKind = 'web' | 'electron' | 'xr' | 'capacitor';

/**
 * Where saves are kept. `open()` returns a working backend right now, or null when there is
 * none (missing, blocked by the browser, or failing a round-trip). It never throws and it
 * probes on every call, so a caller that got null can try again later (the save store does,
 * on each write). Writes may still throw (quota); `engine/save` handles that.
 */
export interface HostStorage {
  /** `local`: the web host's `localStorage`. Other hosts name their own. */
  readonly kind: string;
  open(): StorageLike | null;
}

/** Fullscreen for the game's page or window. */
export interface HostFullscreen {
  /** True when going fullscreen can work here (false on iPhone Safari, or in a frame without `allowfullscreen`). */
  available(): boolean;
  /** True while fullscreen (a getter: read it each time). */
  readonly active: boolean;
  /**
   * Enters or leaves fullscreen; call it inside a tap or click. `lockLandscape` also asks for
   * landscape where the platform allows it. Resolves to whether it is fullscreen afterwards;
   * a refusal leaves things as they were and never rejects.
   */
  toggle(opts?: { lockLandscape?: boolean }): Promise<boolean>;
  /** Calls `fn` when fullscreen starts or ends. Returns unsubscribe. */
  watch(fn: (on: boolean) => void): () => void;
}

/** Window controls a desktop shell offers. The web host has none. */
export interface HostWindow {
  close(): void;
  minimize?(): void;
  toggleMaximize?(): void;
  /** Sets the window's title bar text. */
  setTitle?(title: string): void;
}

/** Whether the app is in front of the player or paged out (a hidden tab, a backgrounded app). */
export type HostLifecycleState = 'active' | 'background';

/**
 * The app's lifecycle (ws/host-mobile). `createGame` stops requesting frames and flushes the
 * save on `background` and starts them again on `active`; a game autosaves from
 * `hooks.lifecycle`. The web host reads it from `visibilitychange` and `pagehide`/`pageshow`; a
 * store app's host reads it from the shell (Capacitor's `appStateChange`).
 */
export interface HostLifecycle {
  /**
   * The state now (a getter, E-036: read it each time). Before ws/core-8 this was a method,
   * `state()`; a custom host writes it as a getter.
   */
  readonly state: HostLifecycleState;
  /** Calls `fn` on every change (never twice with the same state). Returns unsubscribe. */
  watch(fn: (state: HostLifecycleState) => void): () => void;
}

export type HapticImpact = 'light' | 'medium' | 'heavy';
export type HapticNotification = 'success' | 'warning' | 'error';

/**
 * Haptic feedback. Every call is fire-and-forget and safe when `available()` is false (it does
 * nothing). The web host maps everything onto `navigator.vibrate`; a store app's host onto the
 * platform's haptics engine.
 */
export interface HostHaptics {
  /** True when the device can produce any haptic at all. */
  available(): boolean;
  /** A short tap of the given weight, for a press or a landing. */
  impact(style: HapticImpact): void;
  /** A patterned buzz for an outcome. */
  notification(kind: HapticNotification): void;
  /** A plain vibration of `ms` milliseconds. */
  vibrate(ms: number): void;
}

/** Safe-area insets in CSS px: what a notch, a home indicator or rounded corners cover. */
export interface HostInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The viewport's safe-area insets, CSS px. The UI layout pads its regions by them
 * (`followSafeArea` in `ui/layout`). The web host reads `env(safe-area-inset-*)` and re-reads
 * on resize.
 */
export interface HostSafeArea {
  /** The insets now. The object is reused: copy it to keep it. */
  insets(): Readonly<HostInsets>;
  /** Calls `fn` when the insets change (a rotation, a resize). Returns unsubscribe. */
  watch(fn: (insets: Readonly<HostInsets>) => void): () => void;
}

/**
 * Where frames come from: the display's refresh (`requestAnimationFrame` in a browser), a
 * test's manual stepping, or an XR session's `requestAnimationFrame` (`createXrHost`). `GameLoop` schedules
 * every frame through this, never through the globals.
 */
export interface FrameSource {
  /**
   * Calls `cb(timeMs)` once, at the next frame, with the frame's timestamp in ms on the same
   * clock as `performance.now()`. Returns a handle for `cancelFrame`.
   */
  requestFrame(cb: (timeMs: number) => void): number;
  /** Drops a pending request; a handle already run or cancelled is ignored. */
  cancelFrame(handle: number): void;
}

export interface Host extends FrameSource {
  readonly kind: HostKind;
  /** Where the page runs: top level, or framed by the same or another origin (itch.io). */
  readonly embed: EmbedContext;
  /**
   * Opens `url` (a plain `https:` link, else `invalid`) outside the game. `activation` says how
   * the player asked: `pointer` and `keyboard` are real gestures, `gamepad` and `script` are
   * not, so the open may come back `blocked` (then show the URL for copying instead).
   */
  openExternal(url: string, opts: { activation: LinkActivation }): OpenResult;
  /** Copies `text`; `manual` means every method failed (show it for copying by hand). */
  copyText(text: string): Promise<CopyResult>;
  /** False when the platform rules out writing the clipboard directly (itch's frame policy). */
  clipboardWriteAllowed(): boolean;
  readonly fullscreen: HostFullscreen;
  readonly storage: HostStorage;
  /** Desktop window controls, when the host has a window of its own. */
  readonly window?: HostWindow;
  /** The app's foreground/background state, when the host can tell (web and capacitor do; the XR host passes on its base host's). */
  readonly lifecycle?: HostLifecycle;
  /** Haptic feedback, when the host offers any (`available()` says whether the device does). */
  readonly haptics?: HostHaptics;
  /** The viewport's safe-area insets, when the host can measure them. */
  readonly safeArea?: HostSafeArea;
}
