/// <reference path="../platform/xr-types.d.ts" />
/**
 * `createGame` (D-041 Phase 1): the noun-free wiring every ThunderClap game starts from.
 *
 * It blocks browser zoom, boots WebGPU on a letterboxed surface and builds, in this order:
 * renderer, post stack, particles, host, the game's save (if any), overlay and pad navigation,
 * audio (mixer persisted through the host), the game's tick clock, input with its gestures (on
 * that clock) and pointer router, the scene stack and the frame loop (frames come from the
 * host). It also wires the page lifecycle (hide, pagehide and freeze stop frames and flush the
 * save; show resumes), the host's app lifecycle (`background` stops frames and flushes the save,
 * `active` resumes) and device loss (the reload screen, then loop, audio and captions halt for
 * good).
 *
 * The surface letterboxes the design space; what the overlay's layout leaves free of UI is
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
 * VR is one call (`ctx.xr.enter()`, ws/xr): frames then come from the session through an XR
 * host, the scenes record once through the surface's head camera and the renderer draws each
 * eye into the surface's HDR scene target and resolves it through the post stack into the
 * session's layer (ws/xr-post); controllers and hands join `ctx.pointers`. Leaving (`exit()` or
 * the session ending) puts everything back; a game that never enters runs the same code as before.
 */
import { AudioEngine, persistMixer } from '../audio';
import { ParticleSystem, type ParticleSystemOptions } from '../fx';
import {
  createWebHost,
  createXrHost,
  type Host,
  type HostLifecycleState,
  type XrHost,
} from '../host';
import {
  type Bindings,
  createGestures,
  createInputPlayback,
  createInputRecorder,
  createPointerRouter,
  createTickClock,
  type GamepadLike,
  type Gestures,
  Input,
  type InputPlayback,
  type InputPlaybackOptions,
  type InputRecording,
  type MagnifyOptions,
  type PointerRouter,
  type TickClock,
  XrPointerSource,
} from '../input';
import {
  blockBrowserZoom,
  boot,
  type GpuContext,
  type Surface,
  type SurfaceOptions,
  watchLifecycle,
  type XrEyeView,
  XrSurface,
} from '../platform';
import { type PostSettingsPatch, PostStack } from '../post';
import {
  type Camera,
  type Frame,
  installGpuErrorLogging,
  Renderer,
  type SceneTargetAux,
} from '../render';
import {
  applyTextScale,
  createOverlay,
  followSafeArea,
  type LayoutSpec,
  type Overlay,
  PadNav,
  type ThemeOverrides,
} from '../ui';
import type { Time } from './loop';
import { GameLoop } from './loop';
import { SceneStack } from './scene';

/**
 * What `createGame` needs from a game's save: it is flushed on hide (and `host.lifecycle`
 * going to `background`) and on device loss.
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

export interface CreateGameOptions<A extends string, S extends FlushableSave | null = null> {
  /** Element the canvas and overlay mount into. */
  root: HTMLElement;
  /** The game's name, shown as the eyebrow on the fatal screens. */
  title?: string;
  /** Logical design size the renderer, surface and overlay share. Default 1920×1080. */
  design?: { width: number; height: number };
  /** Surface options other than the design size (DPR cap, pixel cap, bar colour). */
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
    bindings: Bindings<A>;
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
  /** VR (ws/xr): the reference space and session callbacks `ctx.xr.enter()` uses. */
  xr?: XrOptions;
}

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

/**
 * Everything noun-free a scene may use. `A` is the game's action names, `S` its save, `C` the
 * ctx the scene stack hands to scenes (the game's own ctx type, which extends this one) and `P`
 * what the pointer router's hits carry (`ctx.pointers`' testers' `target`s; default `any`, so
 * `EngineCtx<A>` takes a ctx whatever its `P`; `createGame` returns `unknown` unless given one).
 * A game created without `save` gets `S = null`: `ctx.save` is then typed `null`, so a client
 * cannot reach for one. The default `S` is `FlushableSave | null` (ws/api-core), so code written
 * against `EngineCtx<A>` takes a ctx with a save or without one; name the save type
 * (`EngineCtx<A, MySave>`) to read it.
 */
export interface EngineCtx<
  A extends string = string,
  S extends FlushableSave | null = FlushableSave | null,
  C = unknown,
  // biome-ignore lint/suspicious/noExplicitAny: `EngineCtx<A>` takes a ctx of any hit target type
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
 */
export async function createGame<
  A extends string,
  S extends FlushableSave | null = null,
  C = unknown,
  P = unknown,
>(opts: CreateGameOptions<A, S>): Promise<EngineCtx<A, NoInfer<S>, C, P> | null> {
  const design = { width: opts.design?.width ?? 1920, height: opts.design?.height ?? 1080 };
  // Before boot, so it holds from the first frame (and on the fatal screens too).
  if (opts.blockBrowserZoom !== false) blockBrowserZoom(opts.root.ownerDocument);
  const res = await boot(opts.root, {
    ...opts.surface,
    logicalWidth: design.width,
    logicalHeight: design.height,
    title: opts.title,
    forceUnsupported: opts.forceUnsupported,
  });
  if (!res.ok) return null;
  const { surface, gpu } = res;
  opts.onGpuReady?.(gpu);
  installGpuErrorLogging(gpu.device);

  // ── GPU ────────────────────────────────────────────────────────────────
  const renderer = new Renderer(gpu, {
    logicalWidth: design.width,
    logicalHeight: design.height,
    aux: opts.aux,
  });
  const post = new PostStack(renderer, opts.post);
  renderer.post = post;
  const particles = new ParticleSystem(renderer, opts.particles);

  // ── Host, save + overlay ───────────────────────────────────────────────
  const host = opts.host ?? createWebHost();
  // No save, no storage access: a pure client keeps nothing on the device.
  const save = (opts.save ? opts.save(host) : null) as S;
  opts.styles?.(surface.root.ownerDocument);
  // When a panel closes and its opener can't take focus back, focus returns to the canvas so
  // keys keep reaching the game.
  const ui = createOverlay({
    parent: surface.root,
    designWidth: design.width,
    designHeight: design.height,
    layout: opts.layout,
    focusHome: () => surface.canvas,
    theme: opts.theme,
    // `ui.anchors()` and `ui.floats()` without a camera follow the game's (ws/api-core).
    camera: () => renderer.camera,
  });
  if (opts.textScale !== undefined && opts.textScale !== 1) {
    applyTextScale(ui.root, opts.textScale, (t) => ui.setTheme(t));
  }
  // Input is blocked while a modal panel is up, so the pad drives panels through this.
  const padNav = new PadNav(ui.stack, { getGamepads: opts.input.getGamepads });
  // A host that knows the notch and home indicator pads the layout's regions by them.
  if (host.safeArea) followSafeArea(ui.layout, host.safeArea);
  surface.onResize(({ rect, backbuffer }) => {
    renderer.resize(backbuffer.width, backbuffer.height);
    ui.setFrame(rect);
  });

  // ── Audio ──────────────────────────────────────────────────────────────
  // Unlocks on the first gesture and pauses itself while the page is hidden (see attach).
  const audio = new AudioEngine();
  audio.attach();
  if (opts.mixerKey) persistMixer(audio, { game: opts.mixerKey, host });

  // ── Input (blocked under modal panels) ─────────────────────────────────
  const extraBlock = opts.input.blocked;
  // Gestures and pointer rays link to the input: same block, same transform, same attach,
  // advanced in `input.update()`. The rays go through whatever camera the renderer draws with:
  // the head while a VR session runs (so a head-locked `WorldPanel` faces the headset).
  // The gestures run on the game's tick clock (advanced by the loop below), so their timers
  // are game time and a replay lands them on the same ticks.
  const clock = createTickClock();
  const gestures = createGestures({ magnify: opts.input.magnify, clock });
  // While a session runs: its host (frames and the current `XRFrame`) and its surface (eyes).
  let xrHost: XrHost | null = null;
  let xrSurface: XrSurface | null = null;
  const pointers = createPointerRouter<P>({ camera: () => xrSurface?.head ?? renderer.camera });
  const input = new Input<A>(opts.input.bindings, {
    blocked: extraBlock ? () => ui.stack.hasModal || extraBlock() : () => ui.stack.hasModal,
    globalKeys: opts.input.globalKeys,
    buttonKeys: opts.input.buttonKeys,
    getGamepads: opts.input.getGamepads,
    gestures,
    pointers,
  });
  // A replay feeds the input itself: no DOM listeners, so a real key never leaks in (E-011).
  // The playback drives the game's clock (ws/input-9): each fed tick advances it by the
  // recording's tick spacing, so `playback.speed` above 1 keeps game time too.
  const playback = opts.input.replay
    ? createInputPlayback(input, opts.input.replay, { clock })
    : null;
  if (opts.input.record) createInputRecorder(input);
  // The recorded pointers are dispatched through a pointer target nothing real can reach (an
  // element outside the page that keys are read from too), so the gestures, rays and any look
  // see them on their recorded ticks and never a real pointer or key.
  const sink = surface.root.ownerDocument.createElement('div');
  const attachSink = () => input.attach({ pointerTarget: sink, keyTarget: sink });
  // Where the input lives outside a `ctx.replay`: the canvas, or the sink in replay mode.
  const attachHome = playback ? attachSink : () => input.attach({ pointerTarget: surface.canvas });
  attachHome();
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));
  /** The playback `ctx.replay` installed, until it ends or is stopped. */
  let replaying: GameReplay | null = null;
  /** Its `onEnd`, cleared by `stop()` so a stopped or replaced replay never reports an end. */
  let replayEnd: (() => void) | undefined;
  const replay = (recording: InputRecording, ropts: ReplayOptions = {}): GameReplay => {
    replaying?.stop();
    input.playback?.detach();
    // `attach` releases every key and button first, so nothing the player held leaks in.
    attachSink();
    // A live pointer source (the screen, an XR controller) is muted for the replay too: the
    // sink stops the DOM ones, the mute the rest. Its remover lifts only this mute, so a mute
    // the game set stays.
    const unmute = pointers.mute();
    const pb = createInputPlayback(input, recording, {
      speed: ropts.speed,
      tickMs: ropts.tickMs,
      clock,
    }) as GameReplay;
    const uninstall = pb.detach;
    pb.stop = pb.detach = () => {
      uninstall();
      unmute();
      if (replaying !== pb) return;
      replaying = null;
      replayEnd = undefined;
      // Releases the recording's last held keys and buttons too.
      attachHome();
    };
    replaying = pb;
    replayEnd = ropts.onEnd;
    return pb;
  };

  // ── Scenes + loop ──────────────────────────────────────────────────────
  const hooks: GameHooks = {};
  // The stack hands scenes this object on enter; the game fills in its nouns before then.
  const ctx = {} as EngineCtx<A, S, C, P>;
  const stack = new SceneStack<C, Frame, Camera>(ctx as C);
  // With `sim: false` the loop calls update once per rendered frame with the real delta.
  const fixed = opts.sim !== false;
  const loop = new GameLoop(
    {
      update: (dt: number) => {
        // A replay feeds this tick's events first: live, they arrived between the frames, while
        // the clock still read the last tick. Then the clock moves by the step, before the
        // input (and its gestures) update. A playback driving the clock has already moved it
        // for each tick it fed; once the recording is done the step moves it again. The playback
        // is read from the input each step, so one the game installs mid-session (a replay
        // started from a menu: `createInputPlayback(ctx.input, rec, { clock: ctx.clock })`) is
        // stepped here too, in the same order (ws/core-5).
        // A `ctx.replay` whose recording ran out last step gives the input back here, before
        // this step's update, so its last tick was updated with the replayed state (ws/core-6).
        const pb = input.playback;
        const fed = pb ? pb.step() : false;
        if (!fed && replaying !== null && pb === replaying) {
          const onEnd = replayEnd;
          replaying.stop();
          onEnd?.();
        }
        if (!fed || pb?.clock !== clock) clock.advance(dt * 1000);
        input.update();
        padNav.update();
        audio.update(dt);
        if (fixed) hooks.update?.(dt);
        else hooks.frame?.(dt);
        particles.update(dt);
        stack.update(dt);
      },
      render: (alpha: number, time: Time) => {
        hooks.beforeRender?.(time);
        const frame = renderer.beginFrame(time.realTime, time.frameDt);
        if (xrSurface && xrHost) {
          // The scenes record once, through the head; each eye draws the record into the
          // surface's HDR scene target and the post stack resolves it into the eye's part of
          // the layer (ws/xr-post), so the headset sees what the screen would.
          const xrFrame = xrHost.frame;
          const eyes = xrFrame ? xrSurface.views(xrFrame) : NO_EYES;
          stack.render(frame, xrSurface.head, alpha);
          for (let i = 0; i < eyes.length; i++) {
            const eye = eyes[i]!;
            const scene = xrSurface.scene!;
            renderer.render(frame, eye.camera, scene);
            renderer.resolve(scene, eye.target.color.view, eye.viewport);
          }
          renderer.endFrame({ present: false });
        } else {
          // Read each frame: `ctx.setCamera` swaps it.
          const camera = renderer.camera;
          stack.render(frame, camera, alpha);
          renderer.render(frame, camera);
          renderer.endFrame();
        }
        hooks.afterRender?.(time);
        ui.updateAnchors();
      },
    },
    { step: opts.sim ? opts.sim.step : undefined, fixed, frames: host },
  );

  // ── XR ─────────────────────────────────────────────────────────────────
  let xrSession: XRSession | null = null;
  let xrEntering: Promise<void> | null = null;
  // Restores the page host, pointers and surface; set while a session runs, idempotent.
  let leaveXr: (() => void) | null = null;
  const xr: XrControl = {
    get active() {
      return xrSession !== null;
    },
    get session() {
      return xrSession;
    },
    get surface() {
      return xrSurface;
    },
    async supported() {
      const sys = globalThis.navigator?.xr;
      if (!sys || !XrSurface.supported()) return false;
      try {
        return await sys.isSessionSupported('immersive-vr');
      } catch {
        return false;
      }
    },
    enter() {
      if (xrSession) return Promise.resolve();
      if (xrEntering) return xrEntering;
      const sys = globalThis.navigator?.xr;
      if (!sys || !XrSurface.supported()) {
        return Promise.reject(new Error('WebXR with the WebGPU binding is not available here'));
      }
      const refType = opts.xr?.referenceSpace ?? 'local-floor';
      xrEntering = (async () => {
        const session = await sys.requestSession('immersive-vr', {
          requiredFeatures: ['webgpu', refType],
          optionalFeatures: ['hand-tracking'],
        });
        let referenceSpace: XRReferenceSpace;
        try {
          referenceSpace = await session.requestReferenceSpace(refType);
        } catch (err) {
          await session.end().catch(() => {});
          throw err;
        }
        const surface = new XrSurface(session, gpu.device, {
          referenceSpace,
          scene: true,
          colorFormat: renderer.format,
        });
        const sessionHost = createXrHost(session, host);
        const source = new XrPointerSource(session, referenceSpace, () => sessionHost.frame);
        const removeSource = pointers.addSource(source);
        const onEnd = () => leaveXr?.();
        leaveXr = () => {
          leaveXr = null;
          session.removeEventListener('end', onEnd);
          removeSource();
          loop.setFrames(host);
          xrHost = null;
          xrSurface = null;
          xrSession = null;
          surface.destroy();
          opts.xr?.onExit?.();
        };
        session.addEventListener('end', onEnd);
        xrSession = session;
        xrSurface = surface;
        xrHost = sessionHost;
        loop.setFrames(sessionHost);
        opts.xr?.onEnter?.(session);
      })().finally(() => {
        xrEntering = null;
      });
      return xrEntering;
    },
    async exit() {
      const session = xrSession;
      if (!session) return;
      try {
        await session.end();
      } finally {
        // The `end` event normally restored everything; a session ending without it does here.
        leaveXr?.();
      }
    },
  };

  // Hidden, pagehide (iOS app switch) or freeze (Android): stop drawing and persist now; a
  // phone may kill a background tab without another word.
  watchLifecycle({
    onHide: (reason) => {
      loop.stop();
      hooks.hide?.(reason);
      save?.flush();
    },
    onShow: (reason) => {
      if (loop.halted) return;
      loop.start();
      hooks.show?.(reason);
    },
  });

  // ── Host lifecycle (ws/host-mobile) ────────────────────────────────────
  // A host that knows the app's state (the web host from the page's visibility, a store app's
  // from its shell): background stops frames and flushes the save, active resumes. On the web
  // host the page events above have usually done both already (the loop is then stopped, so the
  // flush is not repeated); a shell's state change without a page event does them here. Audio
  // follows the document's visibility in `audio.attach`; a shell's background state also reaches
  // it through `audio.background` (ws/audio-4), the same flag, so it is not suspended twice.
  host.lifecycle?.watch((state) => {
    audio.background(state === 'background');
    if (state === 'background') {
      if (loop.isRunning) {
        loop.stop();
        save?.flush();
      }
    } else if (!loop.halted) {
      loop.start();
    }
    hooks.lifecycle?.(state);
  });

  // Device lost: boot has shown the reload screen; stop all work behind it for good.
  res.onDeviceLost((info) => {
    loop.halt();
    hooks.deviceLost?.(info);
    void audio.halt();
    ui.caption.suspend(true);
    save?.flush();
  });

  Object.assign(ctx, {
    design,
    surface,
    gpu,
    renderer,
    camera: renderer.camera,
    setCamera: (cam: Camera) => {
      renderer.camera = cam;
    },
    post,
    particles,
    input,
    clock,
    replay,
    gestures,
    pointers,
    padNav,
    audio,
    ui,
    host,
    save,
    stack,
    loop,
    hooks,
    onDeviceLost: res.onDeviceLost,
    xr,
  } satisfies EngineCtx<A, S, C, P>);
  // `camera` follows `setCamera` (`Object.assign` copied a value).
  Object.defineProperty(ctx, 'camera', {
    get: () => renderer.camera,
    enumerable: true,
    configurable: true,
  });
  return ctx;
}

/** What the XR render step iterates when the frame has no viewer pose. */
const NO_EYES: readonly XrEyeView[] = [];
