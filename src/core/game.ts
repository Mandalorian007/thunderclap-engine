/**
 * `createGame` (D-041 Phase 1): the noun-free wiring every ThunderClap game starts from.
 *
 * It blocks browser zoom, boots WebGPU on a surface and builds, in this order:
 * renderer, post stack, particles, host, the game's save (if any), overlay and pad navigation,
 * audio (mixer persisted through the host), the game's tick clock, input with its gestures (on
 * that clock) and pointer router, the scene stack and the frame loop (frames come from the
 * host). It also wires the page lifecycle (hide, pagehide and freeze stop frames and flush the
 * save; show resumes), the host's app lifecycle (`background` stops frames and flushes the save,
 * `active` resumes) and device loss (the reload screen, then loop, audio and captions halt for
 * good).
 *
 * The surface letterboxes the design space (or covers it, cropped to a band, under
 * `surface.fit`); what the overlay's layout leaves free of UI is
 * `ctx.ui.layout.freeRect`, and a 2D game frames its world into it with
 * `ctx.camera.fitFreeRect(worldRect, ctx.ui.layout.freeRect, ctx.surface)`. Scenes draw through
 * `ctx.camera` (`Scene.render(frame, camera, alpha)`); the loop calls
 * `renderer.render(frame, ctx.camera)` once per frame.
 *
 * Two parts are opt-in, so a pure client of a server-authoritative game (VISION pillar 6) uses
 * the same wiring: `save` (omit it and `ctx.save` is null, and nothing touches `host.storage`)
 * and the fixed-step sim (`sim: false` runs the loop at render rate, `hooks.frame` each frame).
 *
 * Games add their nouns by extending the returned object (`Object.assign(ctx, { ... })`): the
 * scene stack hands scenes this same object, so a scene typed against the game's own ctx sees
 * them. Game logic plugs into the frame and the lifecycle through `ctx.hooks`.
 *
 * Headless (ws/core-8): given `gpu` (a fake device in a test) `createGame` skips the WebGPU
 * boot and its fatal screens and mounts the surface without a GPU canvas context; with `clock`
 * the game runs on that tick clock and with `host` on that host's frames. `root` may then be
 * left out. The overlay still needs a DOM (happy-dom in Vitest). `@thunderclap-engine/engine/testing`
 * `createTestGame` wires the fakes in.
 *
 * VR is one call (`ctx.xr.enter()`, ws/xr): frames then come from the session through an XR
 * host, the scenes record once through the surface's head camera and the renderer draws each
 * eye into the surface's HDR scene target and resolves it through the post stack into the
 * session's layer (ws/xr-post); controllers and hands join `ctx.pointers`. Leaving (`exit()` or
 * the session ending) puts everything back; a game that never enters runs the same code as before.
 */

import type { AudioEngine } from '../audio';
import type { ParticleSystem, ParticleSystemOptions } from '../fx';
import type { Host } from '../host';
import type {
  Bindings,
  GamepadLike,
  Gestures,
  HitTester,
  Input,
  InputRecording,
  MagnifyOptions,
  PointerRouter,
  TickClock,
} from '../input';
import { withAudio } from '../kit/audio';
import { composeGame } from '../kit/compose';
import { withInput } from '../kit/input';
import { withOverlay } from '../kit/overlay';
import { withParticles, withPost } from '../kit/post';
import type {
  CrashOptions,
  FlushableSave,
  GameHooks,
  GameReplay,
  ReplayOptions,
  SimOption,
  XrControl,
  XrOptions,
} from '../kit/types';
import { withXr } from '../kit/xr';
import type { GpuContext, Surface, SurfaceOptions } from '../platform';
import type { PostSettingsPatch, PostStack } from '../post';
import type { Camera, Frame, Renderer, SceneTargetAux } from '../render';
import type { LayoutSpec, Overlay, PadNav, ThemeOverrides } from '../ui';
import { NO_DOM } from './detached-surface';
import type { GameLoop } from './loop';
import type { SceneStack } from './scene';

// The kit's shared types, under their 1.x names (they moved to `kit/types.ts`, ws/kit).
export type {
  CrashOptions,
  FlushableSave,
  GameHooks,
  GameReplay,
  HideReason,
  ReplayOptions,
  ShowReason,
  SimOption,
  XrControl,
  XrOptions,
} from '../kit/types';

export interface CreateGameOptions<
  A extends string,
  S extends FlushableSave | null = null,
  // biome-ignore lint/suspicious/noExplicitAny: a bare `CreateGameOptions<A, S>` takes testers of any target (ws/input-12)
  P = any,
> {
  /**
   * Element the canvas and overlay mount into. Required unless `gpu` is given; a headless game
   * without it mounts into a new detached `<div>` of `document`.
   */
  root?: HTMLElement;
  /**
   * Headless (ws/core-8): the GPU to build on, instead of booting WebGPU on the canvas. Nothing
   * is asked of `navigator.gpu`, the unsupported and device-lost screens are never shown, and the
   * canvas gets no context; device loss is read from `gpu.device.lost` where the device has it
   * (a lost device reaches `hooks.deviceLost` and `ctx.onDeviceLost` as usual). A test passes the
   * fake GPU (`@thunderclap-engine/engine/testing`); `createTestGame` does.
   */
  gpu?: GpuContext;
  /**
   * `false` (ws/core-9): no overlay and no DOM at all, for a game run in plain Node (a test, a
   * server-side sim). Needs `gpu` and `host`. Nothing touches `document` or `window`: no
   * overlay, panels, captions or `styles`, no canvas or root (`root` is not used, and
   * `ctx.surface` letterboxes a virtual container of the design size at a pixel ratio of 1, so
   * client px are design px; its `root` and `canvas` throw), no zoom block, no page lifecycle
   * or audio unlock listeners, and the input is attached to nothing (feed it with `keyDown`,
   * `pointerAt` and the rest, or a replay's key, button, pointer and pad lanes; recorded
   * pointer events and overlay clicks have nothing to reach). Reading `ctx.ui` throws.
   * `ctx.padNav` exists and never owns the pad. The host's own lifecycle (`host.lifecycle`) and
   * device loss work as usual. Default true.
   */
  overlay?: boolean;
  /**
   * The game's tick clock (`ctx.clock`, ws/core-8). Default `createTickClock()`. The loop
   * advances it by the fixed step (`clock.advance(step × 1000)`) before each fixed update; a
   * test passes `createFixedClock(step × 1000)`, which counts each such advance as one whole step.
   */
  clock?: TickClock;
  /** The game's name, shown as the eyebrow on the fatal screens. */
  title?: string;
  /** Logical design size the renderer, surface and overlay share. Default 1920×1080. */
  design?: { width: number; height: number };
  /**
   * Surface options other than the design size (DPR cap, pixel cap, bar colour, and `fit`:
   * `{ fit: { minVisibleHeight, belowScale: PHONE_SCALE } }` fills a phone instead of
   * letterboxing, #1).
   */
  surface?: Omit<SurfaceOptions, 'logicalWidth' | 'logicalHeight'>;
  /** Initial post settings (`PostStack` patch). */
  post?: PostSettingsPatch;
  /**
   * Aux attachments of the renderer's scene target (`RendererOptions.aux`, ws/core-7): `{
   * velocity: true }` gives `post.motionBlur` per-object motion (lists and batches with
   * `velocity`/`prevMatrices`, drawn with an `aux` material such as the standard one) instead
   * of camera motion only; `{ roughMetal: true }` feeds SSR's per-surface fade. They reach the
   * post stack as `PostInputs.velocity` / `roughMetal`. Default none: the target, pipelines and
   * frames are what they were without the option. The XR scene target has none.
   */
  aux?: SceneTargetAux;
  particles?: ParticleSystemOptions;
  /** The page the game runs in. Default `createWebHost()`. */
  host?: Host;
  /**
   * Builds the game's save from the host's storage; it is flushed on hide, on `host.lifecycle`
   * going to `background` (a store app's shell) and on device loss.
   * Omit it (a client whose state lives on a server) and `ctx.save` is null, typed `null`, and
   * the engine never touches `host.storage` (leave `mixerKey` out too for that).
   */
  save?(host: Host): S;
  /**
   * The fixed-step sim. Default `{ step: 1 / 60 }`: `hooks.update` and the scenes run in fixed
   * steps. `false`: the loop runs at render rate only, calling `hooks.frame(dt)` and the scenes'
   * `update(dt)` once per frame with the real delta (input, pad navigation and particles too).
   */
  sim?: SimOption;
  /**
   * The key the audio mixer (volumes, mutes) persists under: `thunderclap:<mixerKey>:audio`.
   * Omit to keep the mixer in memory.
   */
  mixerKey?: string;
  input: {
    /**
     * The base action map. `A` is the full action union: the map may leave out actions a pushed
     * context binds (ws/input-12; `createGame<'jump' | 'back'>({ input: { bindings: { jump } } })`,
     * then `ctx.input.pushContext('menu', { bindings: { back } })`).
     */
    bindings: Partial<Bindings<A>>;
    /** See `InputOptions.globalKeys`. */
    globalKeys?: Iterable<string>;
    /** See `InputOptions.buttonKeys`. */
    buttonKeys?: Iterable<string>;
    /** Extra block on top of "a modal panel is open". */
    blocked?: () => boolean;
    /**
     * Gamepad source for both the action map (`InputOptions.getGamepads`) and the pad
     * navigation of modal panels (`PadNavOptions.getGamepads`). Default: `navigator.getGamepads()`,
     * guarded. A test passes a fake pad here and drives `ctx.padNav` with it.
     */
    getGamepads?: () => readonly (GamepadLike | null)[];
    /**
     * Loupe and snap for small touch targets, passed to the `Gestures` `createGame` builds
     * (`GestureOptions.magnify`); see `input/magnify.ts`. Omit for no magnify.
     */
    magnify?: MagnifyOptions;
    /**
     * Record everything the input is fed (ws/input-replay): `ctx.input.recorder` is the
     * `InputRecorder`; `stop()` it for the `InputRecording`. Default false.
     */
    record?: boolean;
    /**
     * Run from a recording instead of the DOM (ws/input-replay): the input is not attached to the
     * canvas or the window, and before each fixed step `ctx.input.playback.step()` feeds that
     * tick's keys, buttons, pointer, wheel and pads. Once the recording is done the input holds
     * its last state.
     */
    replay?: InputRecording;
  };
  /**
   * Injects the game's stylesheets. Runs before the overlay adds the engine's, so the cascade
   * (engine sheets after game sheets) is the same in every game.
   */
  styles?(doc: Document): void;
  /**
   * The overlay's layout: region tracks per form factor, the form-factor rule and each form's
   * units (see `Layout`; read it as `ctx.ui.layout`).
   */
  layout?: LayoutSpec;
  /**
   * Token overrides on the overlay's `defaultTheme` (ws/api-core; `OverlayOptions.theme`, sizes
   * in design px). Later changes: `ctx.ui.setTheme`.
   */
  theme?: ThemeOverrides;
  /**
   * The overlay's text scale, 1 = 100% (ws/api-core): `applyTextScale(ctx.ui.root, textScale,
   * ctx.ui.setTheme)` at boot. Default 1 (nothing applied).
   */
  textScale?: number;
  /** Called once WebGPU is up, before anything else is built (load-timing marks). */
  onGpuReady?(gpu: GpuContext): void;
  /** Stop double-tap, pinch and ctrl+wheel from zooming the page (`blockBrowserZoom`). Default true. */
  blockBrowserZoom?: boolean;
  /** Dev aid: show the unsupported screen as if WebGPU were missing. */
  forceUnsupported?: boolean;
  /**
   * The crash screen (#6, `installCrashScreen`): `true` or options turn it on. Default off. It is
   * installed into `root` before boot, so a throw while `createGame` builds shows the card (Reload
   * only) instead of a blank page; `createGame` still rejects with the error. After boot an
   * uncaught error or unhandled rejection from the game's code shows it with Reload and Keep
   * playing. The save is flushed first: `crash.flush` when given, else the game's `save`, whose
   * flush must return true (the engine's `SaveStore` does when the write reached storage) for the
   * card to say the progress is saved. Not installed without a DOM (`overlay: false`) or a
   * `root`.
   */
  crash?: boolean | CrashOptions;
  /** VR (ws/xr): the reference space and session callbacks `ctx.xr.enter()` uses. */
  xr?: XrOptions;
  /**
   * The pointer router's first hit testers (ws/input-12; `PointerRouterOptions.testers`). Their
   * target type is `P`, so `createGame` infers the router's type from them: `ctx.pointers` is a
   * `PointerRouter<P>` and its hits' `target`s are typed without naming `P`.
   */
  pointers?: { testers?: readonly HitTester<P>[] };
}

/**
 * Everything noun-free a scene may use. `A` is the game's action names, `S` its save, `C` the
 * ctx the scene stack hands to scenes (the game's own ctx type, which extends this one) and `P`
 * what the pointer router's hits carry (`ctx.pointers`' testers' `target`s). `createGame` infers
 * `P` from `pointers.testers` (else `unknown`, or name it: `createGame<A, S, C, P>`). The default
 * is `any`, so `EngineCtx<A>` takes a ctx whatever its `P` (the router is covariant in its target
 * since ws/input-12, so `unknown` would too; it stays `any` under the 1.x freeze and may tighten
 * to `unknown` in 2.0).
 * A game created without `save` gets `S = null`: `ctx.save` is then typed `null`, so a client
 * cannot reach for one. The default `S` is `FlushableSave | null` (ws/api-core), so code written
 * against `EngineCtx<A>` takes a ctx with a save or without one; name the save type
 * (`EngineCtx<A, MySave>`) to read it.
 */
export interface EngineCtx<
  A extends string = string,
  S extends FlushableSave | null = FlushableSave | null,
  C = unknown,
  // biome-ignore lint/suspicious/noExplicitAny: `EngineCtx<A>` takes any `P`; may tighten to `unknown` in 2.0
  P = any,
> {
  readonly design: { readonly width: number; readonly height: number };
  readonly surface: Surface;
  readonly gpu: GpuContext;
  readonly renderer: Renderer;
  /**
   * The camera the scenes draw through (`renderer.camera`, `Camera.ortho2d(design)` by default):
   * the loop passes it to `Scene.render(frame, camera, alpha)` and `renderer.render`, the
   * pointer rays and `ui.anchors()` go through it. Re-aim it in place (`fitRect`,
   * `setPerspective`, `lookAt`), or swap it with `setCamera`.
   */
  readonly camera: Camera;
  /**
   * Swap the camera (ws/api-core): `ctx.setCamera(Camera.perspective(fovY, aspect, near, far))`.
   * `ctx.camera` and `renderer.camera` read it from now; the next frame, the next pointer
   * update and the overlay's anchors use it.
   */
  setCamera(camera: Camera): void;
  readonly post: PostStack;
  /** Shared GPU particle pool; updated by the loop, drawn by views. */
  readonly particles: ParticleSystem;
  readonly input: Input<A>;
  /**
   * The game's tick clock (ws/core-4), in ms: it moves by the fixed step before each fixed
   * update (by the frame delta with `sim: false`) and stands still while `loop.paused` is set
   * or the loop is stopped. `ctx.gestures` reads it, so long-press and double-tap run on game
   * time and a recording replays them on the same ticks. Gestures or a `Look` the game builds
   * itself take it as `{ clock: ctx.clock }`, and so does a playback (`createInputPlayback`'s
   * `clock`), which is why it is typed `TickClock`; only the loop or a playback advances it.
   */
  readonly clock: TickClock;
  /**
   * Replay `recording` from now (a replay started from a menu, ws/core-6): installs an
   * `InputPlayback` on `input`, driven by `clock`, and detaches the input from the canvas and the
   * window for its length, so the real player cannot disturb it; the recorded pointers still
   * reach `gestures` and `pointers`. From the next fixed step the loop steps it. When the
   * recording ends (the first step after its last tick) or `stop()` is called, the playback is
   * uninstalled and the input reattached as before. A second call stops the first replay; a
   * playback from `input.replay` is replaced (the input then returns to its detached element).
   */
  replay(recording: InputRecording, opts?: ReplayOptions): GameReplay;
  /**
   * Tap, double tap, long-press, pan, drag and pinch, linked to `input` (shared block and
   * transform, advanced in `input.update()`), so `{ gesture }` bindings work out of the box.
   * Read a gesture's position here (`gestures.tap`) when an action fires.
   */
  readonly gestures: Gestures;
  /**
   * Pointer rays through `ctx.camera` (mouse, pen, touch; a `PadCursor` when added; the XR
   * controllers and hands, through the head camera, while `xr` is active): register hit testers
   * on it and listen for `hover`/`select`. Linked to `input`, which polls it each update and
   * shares its block and pointer transform. `P` types the hits' `target`s
   * (`createGame<Action, Save, GameCtx, Target>`); the router itself does not check them.
   */
  readonly pointers: PointerRouter<P>;
  /** Drives modal panels from the pad (d-pad moves focus, A activates, B closes). */
  readonly padNav: PadNav;
  readonly audio: AudioEngine;
  /** The DOM overlay, CSS px, with its layout (`ui.layout`); `ui.padOwner` says who has the pad. */
  readonly ui: Overlay;
  /**
   * The page the game runs in: frames, links, copying, fullscreen, save storage, and where the
   * host has them the app lifecycle (`host.lifecycle`, `hooks.lifecycle`), haptics
   * (`host.haptics`) and the safe area (`host.safeArea`, which pads `ui.layout`).
   */
  readonly host: Host;
  /** The game's save, or null when `createGame` was given none (`S` is then `null`). */
  readonly save: S;
  readonly stack: SceneStack<C, Frame, Camera>;
  readonly loop: GameLoop;
  /** Game logic in the frame and lifecycle; see `GameHooks`. */
  readonly hooks: GameHooks;
  /** Runs `fn` after the device-lost screen and the engine's halt. Returns unsubscribe. */
  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): () => void;
  /** Entering and leaving VR; see `XrControl`. */
  readonly xr: XrControl;
}

/**
 * Boots WebGPU and builds the engine ctx. Resolves `null` when WebGPU is unavailable: the
 * engine has already shown the unsupported screen and there is nothing more to do.
 *
 * Nothing runs until the game calls `ctx.loop.start()`, except the lifecycle handlers (a show
 * starts the loop) and resize, which keeps the renderer and overlay in step.
 *
 * This is the default kit (ws/kit): `composeGame` from `@thunderclap-engine/engine/kit` with
 * every service passed. A game that wants fewer composes its own.
 */
export async function createGame<
  A extends string,
  S extends FlushableSave | null = null,
  C = unknown,
  P = unknown,
>(opts: CreateGameOptions<A, S, P>): Promise<EngineCtx<A, NoInfer<S>, C, P> | null> {
  // `overlay: false` (ws/core-9): no DOM is touched.
  const dom = opts.overlay !== false;
  if (!dom && (!opts.gpu || !opts.host)) {
    throw new Error('createGame: `overlay: false` needs `gpu` and `host` (it touches no DOM)');
  }
  const ctx = await composeGame({
    root: opts.root,
    gpu: opts.gpu,
    dom,
    host: opts.host,
    clock: opts.clock,
    title: opts.title,
    design: opts.design,
    surface: opts.surface,
    aux: opts.aux,
    onGpuReady: opts.onGpuReady,
    blockBrowserZoom: opts.blockBrowserZoom,
    forceUnsupported: opts.forceUnsupported,
    save: opts.save,
    crash: opts.crash,
    loop: { sim: opts.sim },
    post: withPost(opts.post),
    particles: withParticles(opts.particles),
    ui: dom
      ? withOverlay({
          styles: opts.styles,
          layout: opts.layout,
          theme: opts.theme,
          textScale: opts.textScale,
        })
      : undefined,
    audio: withAudio({ mixerKey: opts.mixerKey }),
    input: withInput<A, P>({ ...opts.input, testers: opts.pointers?.testers }),
    xr: withXr(opts.xr),
  });
  if (!ctx) return null;
  // `overlay: false`: `ctx.ui` throws instead of handing out an overlay that does not exist.
  if (!dom) {
    Object.defineProperty(ctx, 'ui', {
      get: () => {
        throw new Error(NO_DOM('ctx.ui'));
      },
      enumerable: false,
      configurable: true,
    });
  }
  return ctx as unknown as EngineCtx<A, S, C, P>;
}
