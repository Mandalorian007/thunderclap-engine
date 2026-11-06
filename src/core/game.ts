/**
 * `createGame` (D-041 Phase 1): the noun-free wiring every ThunderClap game starts from.
 *
 * It blocks browser zoom, boots WebGPU on a letterboxed surface and builds, in this order:
 * renderer, post stack, particles, host, the game's save (if any), overlay and pad navigation,
 * audio (mixer persisted through the host), input with its gestures and pointer router, the scene
 * stack and the frame loop (frames come from the host). It also wires the page lifecycle (hide, pagehide
 * and freeze stop frames and flush the save; show resumes) and device loss (the reload screen,
 * then loop, audio and captions halt for good).
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
 */
import { AudioEngine, persistMixer } from '../audio';
import { ParticleSystem, type ParticleSystemOptions } from '../fx';
import { createWebHost, type Host } from '../host';
import {
  type Bindings,
  createPointerRouter,
  Gestures,
  Input,
  type MagnifyOptions,
  type PointerRouter,
} from '../input';
import {
  blockBrowserZoom,
  boot,
  type GpuContext,
  type Surface,
  type SurfaceOptions,
  watchLifecycle,
} from '../platform';
import { type PostSettingsPatch, PostStack } from '../post';
import { type Camera, type Frame, installGpuErrorLogging, Renderer } from '../render';
import { createOverlay, type LayoutSpec, type Overlay, PadNav } from '../ui';
import type { Time } from './loop';
import { GameLoop } from './loop';
import { SceneStack } from './scene';

/** What `createGame` needs from a game's save: it is flushed on hide and on device loss. */
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
  particles?: ParticleSystemOptions;
  /** The page the game runs in. Default `createWebHost()`. */
  host?: Host;
  /**
   * Builds the game's save from the host's storage; it is flushed on hide and on device loss.
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
     * Loupe and snap for small touch targets, passed to the `Gestures` `createGame` builds
     * (`GestureOptions.magnify`); see `input/magnify.ts`. Omit for no magnify.
     */
    magnify?: MagnifyOptions;
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
  /** Called once WebGPU is up, before anything else is built (load-timing marks). */
  onGpuReady?(gpu: GpuContext): void;
  /** Stop double-tap, pinch and ctrl+wheel from zooming the page (`blockBrowserZoom`). Default true. */
  blockBrowserZoom?: boolean;
  /** Dev aid: show the unsupported screen as if WebGPU were missing. */
  forceUnsupported?: boolean;
}

/**
 * Everything noun-free a scene may use. `A` is the game's action names, `S` its save and `C`
 * the ctx the scene stack hands to scenes (the game's own ctx type, which extends this one).
 * A game created without `save` gets `S = null`: `ctx.save` is then typed `null`, and that ctx
 * is not assignable to one with a save (`EngineCtx<A>`), so a client cannot reach for one.
 */
export interface EngineCtx<
  A extends string = string,
  S extends FlushableSave | null = FlushableSave,
  C = unknown,
> {
  readonly design: { readonly width: number; readonly height: number };
  readonly surface: Surface;
  readonly gpu: GpuContext;
  readonly renderer: Renderer;
  /**
   * The camera the scenes draw through (`renderer.camera`, `Camera.ortho2d(design)` by default):
   * the loop passes it to `Scene.render(frame, camera, alpha)` and `renderer.render`. Re-aim it
   * in place (`fitRect`, `setPerspective`, `lookAt`); its identity does not change.
   */
  readonly camera: Camera;
  readonly post: PostStack;
  /** Shared GPU particle pool; updated by the loop, drawn by views. */
  readonly particles: ParticleSystem;
  readonly input: Input<A>;
  /**
   * Tap, double tap, long-press, pan, drag and pinch, linked to `input` (shared block and
   * transform, advanced in `input.update()`), so `{ gesture }` bindings work out of the box.
   * Read a gesture's position here (`gestures.tap`) when an action fires.
   */
  readonly gestures: Gestures;
  /**
   * Pointer rays through `renderer.camera` (mouse, pen, touch; a `PadCursor` when added):
   * register hit testers on it and listen for `hover`/`select`. Linked to `input`, which polls
   * it each update and shares its block and pointer transform.
   */
  readonly pointers: PointerRouter<unknown>;
  /** Drives modal panels from the pad (d-pad moves focus, A activates, B closes). */
  readonly padNav: PadNav;
  readonly audio: AudioEngine;
  /** The DOM overlay, CSS px, with its layout (`ui.layout`). */
  readonly ui: Overlay;
  /** The page the game runs in: frames, links, copying, fullscreen and save storage. */
  readonly host: Host;
  /** The game's save, or null when `createGame` was given none (`S` is then `null`). */
  readonly save: S;
  readonly stack: SceneStack<C, Frame, Camera>;
  readonly loop: GameLoop;
  /** Game logic in the frame and lifecycle; see `GameHooks`. */
  readonly hooks: GameHooks;
  /** Runs `fn` after the device-lost screen and the engine's halt. Returns unsubscribe. */
  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): () => void;
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
>(opts: CreateGameOptions<A, S>): Promise<EngineCtx<A, NoInfer<S>, C> | null> {
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
  const renderer = new Renderer(gpu, { logicalWidth: design.width, logicalHeight: design.height });
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
  });
  // Input is blocked while a modal panel is up, so the pad drives panels through this.
  const padNav = new PadNav(ui.stack);
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
  // advanced in `input.update()`. The rays go through whatever camera the renderer draws with.
  const gestures = new Gestures({ magnify: opts.input.magnify });
  const pointers = createPointerRouter({ camera: () => renderer.camera });
  const input = new Input<A>(opts.input.bindings, {
    blocked: extraBlock ? () => ui.stack.hasModal || extraBlock() : () => ui.stack.hasModal,
    globalKeys: opts.input.globalKeys,
    buttonKeys: opts.input.buttonKeys,
    gestures,
    pointers,
  });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  // ── Scenes + loop ──────────────────────────────────────────────────────
  const hooks: GameHooks = {};
  // The stack hands scenes this object on enter; the game fills in its nouns before then.
  const ctx = {} as EngineCtx<A, S, C>;
  const stack = new SceneStack<C, Frame, Camera>(ctx as C);
  const camera = renderer.camera;
  // With `sim: false` the loop calls update once per rendered frame with the real delta.
  const fixed = opts.sim !== false;
  const loop = new GameLoop(
    {
      update: (dt: number) => {
        input.update();
        padNav.update();
        if (fixed) hooks.update?.(dt);
        else hooks.frame?.(dt);
        particles.update(dt);
        stack.update(dt);
      },
      render: (alpha: number, time: Time) => {
        hooks.beforeRender?.(time);
        const frame = renderer.beginFrame(time.realTime, time.frameDt);
        stack.render(frame, camera, alpha);
        renderer.render(frame, camera);
        renderer.endFrame();
        hooks.afterRender?.(time);
        ui.updateAnchors();
      },
    },
    { step: opts.sim ? opts.sim.step : undefined, fixed, frames: host },
  );

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
    camera,
    post,
    particles,
    input,
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
  } satisfies EngineCtx<A, S, C>);
  return ctx;
}
