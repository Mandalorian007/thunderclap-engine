/**
 * The host: what the page or shell the game runs in can do for it (D-041, ARCHITECTURE.md
 * "Host"). The engine reaches the outside world only through this: frame scheduling, opening a
 * link, copying text, fullscreen, and where saves are kept. `createWebHost()` (host/web.ts) is the browser,
 * at top level or in a frame such as itch.io's; a later `createElectronHost()` satisfies the same
 * interface through a preload bridge, and adds `window`.
 */
import type { CopyResult, EmbedContext, LinkActivation, OpenResult } from '../platform/links';
import type { StorageLike } from '../save/storage';

/** Which implementation this is. */
export type HostKind = 'web' | 'electron';

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
  /** True while fullscreen. */
  active(): boolean;
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

/**
 * Where frames come from: the display's refresh (`requestAnimationFrame` in a browser), a
 * test's manual stepping, later an XR session's `requestAnimationFrame`. `GameLoop` schedules
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
}
