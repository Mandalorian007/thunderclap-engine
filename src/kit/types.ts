/**
 * The kit's shared types (ws/kit, E-041 P4): the hooks, lifecycle reasons, save and XR shapes
 * every composed game uses, and the service protocol `composeGame` builds from. The root entry
 * re-exports the 1.x names (`GameHooks`, `XrControl`, ...) from here unchanged.
 */

import type { CrashScreenOptions } from '../core/crash';
import type { GameLoop, Time } from '../core/loop';
import type { Host, HostLifecycleState } from '../host';
import type { InputPlayback, InputPlaybackOptions, PointerRouter, TickClock } from '../input';
import type { GpuContext, Surface, XrSurface } from '../platform';
import type { XRSession } from '../platform/xr-types';
import type { Camera, Renderer, SceneTargetAux } from '../render';
import type { Overlay } from '../ui';

/**
 * What the kit needs from a game's save: it is flushed on hide (and `host.lifecycle` going to
 * `background`) and on device loss.
 */
export interface FlushableSave {
  flush(): void;
}

/** Why the page is going away: `visibilitychange` to hidden, `pagehide` or `freeze`. */
export type HideReason = 'hidden' | 'pagehide' | 'freeze';

/** Why the page is back: `visibilitychange` to visible, `pageshow` or `resume`. */
export type ShowReason = 'visible' | 'pageshow' | 'resume';

/**
 * The fixed-step sim (`CreateGameOptions.sim`). `step` is in seconds (default 1/60); `false`
 * runs the loop at render rate only, for a client that applies server state each frame.
 */
export type SimOption = { step?: number } | false;

/** Game logic plugged into the frame loop and the lifecycle. Set fields on `ctx.hooks`. */
export interface GameHooks {
  /**
   * Each fixed step, after input and pad navigation, before particles and the scenes. Not
   * called with `sim: false` (see `frame`).
   */
  update?(dt: number): void;
  /**
   * `sim: false` only: once per rendered frame with the real frame delta, after input and pad
   * navigation, before particles, the scenes (`update(dt)` with the same delta) and render.
   * Apply the latest server state here.
   */
  frame?(dt: number): void;
  /** Each rendered frame, before `renderer.beginFrame`. */
  beforeRender?(time: Time): void;
  /** Each rendered frame, after `renderer.endFrame`. */
  afterRender?(time: Time): void;
  /**
   * The page is hidden, paged out or frozen: after the loop stops, before the save flushes.
   * Can fire several times in a row (hidden, then pagehide, then freeze).
   */
  hide?(reason: HideReason): void;
  /** The page is back and visible: after the loop restarts (not after a device loss). */
  show?(reason: ShowReason): void;
  /**
   * The host's lifecycle changed (`host.lifecycle`, ws/host-mobile): `background` after the loop
   * stops and the save flushes (autosave here), `active` after it restarts. On the web host this
   * follows the same page events as `hide`/`show`; in a store app it follows the shell.
   */
  lifecycle?(state: HostLifecycleState): void;
  /** The GPU device was lost: after the loop halts, before audio halts and the save flushes. */
  deviceLost?(info: GPUDeviceLostInfo): void;
}

/** `CreateGameOptions.crash` as options: the crash screen's save flush and reload. */
export type CrashOptions = Pick<CrashScreenOptions, 'flush' | 'reload'>;

/** `CreateGameOptions.xr`: how `ctx.xr.enter()` sets the session up. */
export interface XrOptions {
  /**
   * The reference space poses and pointer rays are expressed in. Default `local-floor` (the
   * origin on the floor; standing play), `local` (at the headset's start) or `viewer`.
   */
  referenceSpace?: 'local-floor' | 'local' | 'viewer';
  /** The session is up and frames come from it. */
  onEnter?(session: XRSession): void;
  /** The session ended (by `exit()` or the headset); frames come from the page again. */
  onExit?(): void;
}

/**
 * `ctx.xr`: entering and leaving VR. `supported()` is false and `enter()` rejects where the
 * browser has no WebXR or no WebXR/WebGPU binding, so the same build runs on the page and in a
 * headset.
 */
export interface XrControl {
  /** Whether `enter()` can work here: WebXR with the WebGPU binding and `immersive-vr`. */
  supported(): Promise<boolean>;
  /**
   * Request an `immersive-vr` session (call from a user gesture) and move the game into it: the
   * loop's frames come from the session, each eye renders into the session's layer, controllers
   * and hands are pointers. Resolves once the first frame can run; rejects when the browser
   * refuses. A call while active resolves at once.
   */
  enter(): Promise<void>;
  /** End the session and return to the page; resolves when everything is restored. */
  exit(): Promise<void>;
  /** True while a session runs. */
  readonly active: boolean;
  /** The running session, or null. */
  readonly session: XRSession | null;
  /** The XR surface (eye views, head camera, layer) while active, or null. */
  readonly surface: XrSurface | null;
}

/**
 * `ctx.replay(recording, opts)`: ticks per `step()` and ms per fed tick (`InputPlaybackOptions`),
 * and `onEnd`.
 */
export interface ReplayOptions extends Pick<InputPlaybackOptions, 'speed' | 'tickMs'> {
  /**
   * The recording ended (ws/core-7): called once, on the fixed step where the loop uninstalls
   * the replay (the first step after its last tick), after the input is reattached and before
   * that step's input update and `hooks.update`. Not called on `stop()`, nor when a second
   * `ctx.replay` replaces this one. A `ctx.replay` started here is stepped from the next step.
   */
  onEnd?(): void;
}

/**
 * What `ctx.replay` returns: the `InputPlayback` installed on `ctx.input` (it is
 * `ctx.input.playback`), driving `ctx.clock`. `stop()` (or `detach()`, the same call) uninstalls
 * it and reattaches the input to the canvas at once; the loop does the same on the first step
 * after the recording ends.
 */
export interface GameReplay extends InputPlayback {
  /** Uninstall the playback and give the input back to the player. Idempotent. */
  stop(): void;
}

// ── The service protocol ────────────────────────────────────────────────────────────────────

/**
 * What `composeGame` hands each service's `setup`: the core it always builds (surface, GPU,
 * renderer, host, tick clock, loop, hooks) and the services built before this one. Services are
 * built in a fixed order (post, particles, ui, audio, input, xr), so `ui` is set by the time
 * input is built and `pointers` by the time xr is.
 */
export interface KitCore {
  readonly design: { readonly width: number; readonly height: number };
  readonly surface: Surface;
  readonly gpu: GpuContext;
  readonly renderer: Renderer;
  readonly host: Host;
  readonly clock: TickClock;
  readonly loop: GameLoop;
  readonly hooks: GameHooks;
  /** False with `dom: false`: nothing may touch `document` or `window`. */
  readonly dom: boolean;
  /** `KitOptions.aux`: the renderer's scene-target aux attachments (the XR target reuses them). */
  readonly aux: SceneTargetAux | undefined;
  /** The overlay, once the `ui` service is built; null without one. */
  readonly ui: Overlay | null;
  /** The pointer router, once the `input` service is built; null without one. */
  readonly pointers: PointerRouter<unknown> | null;
  /** The camera pointer rays go through: the XR head while a session runs, else `renderer.camera`. */
  rayCamera(): Camera;
}

/**
 * One service of a composed game: `setup` builds it from the core and returns its part, whose
 * `fields` join the ctx (`ctx.post`, `ctx.ui`, ...). Make one with `withPost`, `withOverlay`,
 * `withInput` and the rest; `composeGame` calls `setup` once, in its fixed order.
 */
export interface KitService<F extends object, Part extends KitPart<F> = KitPart<F>> {
  setup(core: KitCore): Part;
}

/** What a service's `setup` returns: the ctx fields it adds. */
export interface KitPart<F extends object> {
  readonly fields: F;
}

/** A part the loop steps each update (particles: after `hooks.update`, before the scenes). */
export interface KitStepPart<F extends object> extends KitPart<F> {
  update(dt: number): void;
}
