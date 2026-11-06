/// <reference path="../platform/xr-types.d.ts" />
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
 *
 * VR is one call (`ctx.xr.enter()`, ws/xr): frames then come from the session through an XR
 * host, the scenes record once through the surface's head camera and the renderer draws each
 * eye into the surface's HDR scene target and resolves it through the post stack into the
 * session's layer (ws/xr-post); controllers and hands join `ctx.pointers`. Leaving (`exit()` or
 * the session ending) puts everything back; a game that never enters runs the same code as before.
 */
import { AudioEngine, persistMixer } from '../audio';
import { ParticleSystem, type ParticleSystemOptions } from '../fx';
import { createWebHost, createXrHost, type Host, type XrHost } from '../host';
import {
  type Bindings,
  createPointerRouter,
  Gestures,
  Input,
  type MagnifyOptions,
  type PointerRouter,
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
  // While a session runs: its host (frames and the current `XRFrame`) and its surface (eyes).
  let xrHost: XrHost | null = null;
  let xrSurface: XrSurface | null = null;
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
    xr,
  } satisfies EngineCtx<A, S, C>);
  return ctx;
}

/** What the XR render step iterates when the frame has no viewer pose. */
const NO_EYES: readonly XrEyeView[] = [];
