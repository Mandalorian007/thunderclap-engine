/**
 * `composeGame` (ws/kit, E-041 P4): the lean composer. It always builds the core (surface and
 * GPU, renderer, host, tick clock, hooks, scene stack, loop) and wires the lifecycle and device
 * loss; every other service (post, particles, overlay, audio, input, XR) is built only when the
 * game passes it (`withPost()`, `withOverlay({ layout })`, ...), so a game that leaves one out
 * never imports its module. The root `createGame` is this composer with every service passed.
 */

import type { AudioEngine } from '../audio';
import { type CrashScreen, installCrashScreen } from '../core/crash';
import { GameLoop, type Time } from '../core/loop';
import { SceneStack } from '../core/scene';
import { createWebHost, type Host } from '../host';
import { createTickClock, type PointerRouter, type TickClock } from '../input';
import {
  type BootGpuOptions,
  type GpuContext,
  type Surface,
  type SurfaceOptions,
  watchLifecycle,
  type XrEyeView,
  type XrSurface,
} from '../platform';
import type { XRFrame } from '../platform/xr-types';
import type { Frame, Renderer, SceneTargetAux } from '../render';
import { Camera } from '../render/camera';
import type { Overlay } from '../ui';
import { bootKit } from './boot';
import { createExternalFrames } from './frames';
import type {
  CrashOptions,
  FlushableSave,
  GameHooks,
  KitCore,
  KitPart,
  KitService,
  KitStepPart,
  SimOption,
  XrControl,
} from './types';

/** `KitOptions.loop`: the fixed step, and who drives the frames. */
export interface KitLoopOptions {
  /** The fixed-step sim: default `{ step: 1 / 60 }`; `false` runs at render rate (client mode). */
  sim?: SimOption;
  /**
   * `'host'` (default): frames come from the host (`requestAnimationFrame` on the web).
   * `'external'`: the game owns the frames and calls `ctx.frame(now)` once per frame with its
   * own timestamp; the engine schedules nothing and reads no clock. Not with `xr`.
   */
  frames?: 'host' | 'external';
}

/**
 * A game's own renderer (`KitOptions.renderer`, ws/kit-fit): the kit still gives the loop, the
 * lifecycle, input and the other services, and hands each rendered frame to it.
 */
export interface KitRenderer {
  /**
   * The drawing buffer changed size (device px): called once when the renderer is taken, then on
   * every surface resize (the surface has already sized the canvas).
   */
  resize?(width: number, height: number): void;
  /**
   * Draw and present one frame: after `hooks.beforeRender`, before `hooks.afterRender`. `alpha`
   * and `time` are the loop's (`LoopCallbacks.render`).
   */
  render(alpha: number, time: Time): void;
}

/**
 * `KitOptions.renderer`: a game's own `KitRenderer`, a factory that builds one on the booted GPU
 * and surface (it may be async), or `null` for none (the game draws and presents in
 * `hooks.render`).
 */
export type KitRendererOption<R extends KitRenderer = KitRenderer> =
  | R
  | ((gpu: GpuContext, surface: Surface) => R | Promise<R>)
  | null;

/**
 * `composeGame`'s options: the core's (where to mount, the GPU, the host, the save) and one
 * field per optional service. A service left out is not built and its module is not imported.
 */
export interface KitOptions<S extends FlushableSave | null = FlushableSave | null> {
  /** Element the canvas (and overlay) mount into. Required unless `gpu` is given. */
  root?: HTMLElement;
  /** Headless: the GPU to build on instead of booting WebGPU (a fake GPU in a test). */
  gpu?: GpuContext;
  /**
   * `false`: no DOM at all, for plain Node (needs `gpu` and `host`; no `ui`). Nothing touches
   * `document` or `window`. Default true.
   */
  dom?: boolean;
  /** The page the game runs in. Default `createWebHost()`. */
  host?: Host;
  /** The game's tick clock (`ctx.clock`). Default `createTickClock()`. */
  clock?: TickClock;
  /** The game's name, the eyebrow on the fatal screens. */
  title?: string;
  /** Logical design size. Default 1920×1080. */
  design?: { width: number; height: number };
  /** Surface options other than the design size. */
  surface?: Omit<SurfaceOptions, 'logicalWidth' | 'logicalHeight'>;
  /** The renderer's scene-target aux attachments (`RendererOptions.aux`). */
  aux?: SceneTargetAux;
  /** Called once WebGPU is up, before anything else is built. */
  onGpuReady?(gpu: GpuContext): void;
  /** Stop double-tap, pinch and ctrl+wheel from zooming the page. Default true. */
  blockBrowserZoom?: boolean;
  /** Dev aid: show the unsupported screen as if WebGPU were missing. */
  forceUnsupported?: boolean;
  /**
   * What the boot asks the GPU for (`BootGpuOptions`: `xrCompatible`, `drawFeatures`,
   * `compression`, `timestamps`, `powerPreference`). Ignored with `gpu` (already booted).
   */
  gpuOptions?: BootGpuOptions;
  /**
   * Who draws (ws/kit-fit). Left out: the engine's `Renderer` (`ctx.renderer`), the scenes
   * drawn through it. A `KitRenderer` (or a factory for one): the game's own; `ctx.renderer`
   * is it, and each rendered frame calls its `render(alpha, time)`. `null`: none; each
   * rendered frame calls `hooks.render(alpha, time)` and `ctx.renderer` is null. With either,
   * the scenes still update but are not drawn (they draw through the engine's `Frame`), and
   * `post`, `particles` and `xr` (which draw through the engine's renderer) are refused.
   * `ctx.camera` is then a camera of the kit's own (`Camera.ortho2d` of the design) that
   * `setCamera` swaps; pointer rays and overlay anchors go through it.
   */
  renderer?: KitRendererOption;
  /** Builds the game's save from the host; flushed on hide, background and device loss. */
  save?(host: Host): S;
  /** The crash screen (`installCrashScreen`), as `CreateGameOptions.crash`. Default off. */
  crash?: boolean | CrashOptions;
  /** The fixed step and the frame source. */
  loop?: KitLoopOptions;
  /** `withPost(settings)`: `ctx.post`. */
  post?: KitService<object>;
  /** `withParticles(opts)`: `ctx.particles`, updated after `hooks.update`. */
  particles?: KitService<object, KitStepPart<object>>;
  /** `withOverlay(opts)`: `ctx.ui`. Needs a DOM. */
  ui?: KitService<{ readonly ui: Overlay }>;
  /** `withAudio(opts)`: `ctx.audio`. */
  audio?: KitService<{ readonly audio: AudioEngine }>;
  /** `withInput(opts)`: `ctx.input`, `gestures`, `pointers`, `padNav`, `replay`. */
  input?: KitService<{ readonly pointers: PointerRouter<unknown> }, KitInputPart>;
  /** `withXr(opts)`: `ctx.xr`. */
  xr?: KitService<{ readonly xr: XrControl }, KitXrPart>;
}

/** The input part the loop steps (see `KitInput.step`). */
interface KitInputPart extends KitPart<{ readonly pointers: PointerRouter<unknown> }> {
  step(dt: number): void;
}

/** The XR part the render step reads (see `KitXr`). */
interface KitXrPart extends KitPart<{ readonly xr: XrControl }> {
  readonly surface: XrSurface | null;
  readonly frame: XRFrame | null;
  /** False: the eyes are the core's alone (`XrOptions.immediate`). */
  readonly immediate?: boolean;
  /** Draws the eyes' core work after the renderer's frame (`XrOptions.core`). */
  drawCore?(eyes: readonly XrEyeView[]): void;
}

/** What every composed game has, whatever services it took. */
export interface KitCtx<S extends FlushableSave | null = FlushableSave | null> {
  readonly design: { readonly width: number; readonly height: number };
  readonly surface: Surface;
  readonly gpu: GpuContext;
  readonly renderer: Renderer;
  /** The camera the scenes draw through (`renderer.camera`); swap it with `setCamera`. */
  readonly camera: Camera;
  setCamera(camera: Camera): void;
  readonly host: Host;
  /** The game's save, or null without `save`. */
  readonly save: S;
  /** The tick clock: moves by the step before each update; gestures run on it. */
  readonly clock: TickClock;
  /** The scene stack; scenes typed against the game's own ctx push onto it. */
  readonly stack: SceneStack<unknown, Frame, Camera>;
  readonly loop: GameLoop;
  /** Game logic in the frame and lifecycle; see `GameHooks`. */
  readonly hooks: GameHooks;
  /** Runs `fn` after the device-lost screen and the engine's halt. Returns unsubscribe. */
  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): () => void;
}

/** `loop: { frames: 'external' }`: the game drives each frame. */
export interface KitExternalFrame {
  /**
   * Run one frame at `now` (ms, the game's own clock): update (or fixed steps) and render with
   * the delta since the last call (0 for the first after `loop.start()`). Ignored while the loop
   * is stopped or halted.
   */
  frame(now: number): void;
}

/** The ctx fields service `Key` of `K` adds, or nothing when `K` left it out. */
type FieldsOf<K, Key extends string> = K extends {
  readonly [P in Key]: { setup(core: KitCore): { readonly fields: infer F } };
}
  ? F
  : unknown;

/** The renderer `K.renderer` gives (a factory's result), or the engine's `Renderer`. */
type RendererOf<K> = K extends { readonly renderer: infer R }
  ? R extends (...args: never[]) => infer O
    ? Awaited<O>
    : R
  : Renderer;

/** `KitCtx` with `renderer` the one `K` gives. */
type CtxOf<K, S extends FlushableSave | null> = K extends { readonly renderer: unknown }
  ? Omit<KitCtx<S>, 'renderer'> & { readonly renderer: RendererOf<K> }
  : KitCtx<S>;

/** The save type `K.save` builds, or `null`. */
type SaveOf<K> = K extends { save(host: Host): infer S extends FlushableSave | null } ? S : null;

/**
 * What `composeGame(kit)` resolves to: `KitCtx` plus the fields of exactly the services `kit`
 * passed (`ctx.ui` only with `ui`, ...), plus `frame(now)` with `loop: { frames: 'external' }`.
 * With `renderer` given, `ctx.renderer` is the game's renderer (a factory's result) or `null`.
 */
export type KitGame<K extends KitOptions> = CtxOf<K, SaveOf<K>> &
  FieldsOf<K, 'post'> &
  FieldsOf<K, 'particles'> &
  FieldsOf<K, 'ui'> &
  FieldsOf<K, 'audio'> &
  FieldsOf<K, 'input'> &
  FieldsOf<K, 'xr'> &
  (K extends { readonly loop: { readonly frames: 'external' } } ? KitExternalFrame : unknown);

/**
 * Builds a game from the services passed. Resolves `null` when WebGPU is unavailable (the
 * unsupported screen is shown). Nothing runs until `ctx.loop.start()`.
 */
export async function composeGame<K extends KitOptions>(kit: K): Promise<KitGame<K> | null> {
  const crash = kitCrash(kit);
  if (!crash) return buildKit(kit, null) as Promise<KitGame<K> | null>;
  try {
    return (await buildKit(kit, crash)) as KitGame<K> | null;
  } catch (err) {
    // A boot throw: the card instead of a blank page, and the caller still sees the error.
    crash.screen.report(err, { fatal: true });
    throw err;
  }
}

/** The crash screen the kit installed, and where it learns the save once one is built. */
interface KitCrash {
  readonly screen: CrashScreen;
  setSave(save: FlushableSave | null): void;
}

function kitCrash(kit: KitOptions): KitCrash | null {
  if (!kit.crash || kit.dom === false || !kit.root) return null;
  const custom = kit.crash === true ? {} : kit.crash;
  let save: FlushableSave | null = null;
  const screen = installCrashScreen({
    root: kit.root,
    title: kit.title,
    reload: custom.reload,
    // `FlushableSave.flush` is typed void; a save that says where the write went returns a boolean.
    flush: custom.flush ?? (() => save !== null && (save.flush as () => unknown)() === true),
  });
  return {
    screen,
    setSave(s) {
      save = s;
    },
  };
}

/**
 * What the boot asks the GPU for: `gpuOptions`, with an XR-compatible adapter by default when
 * `xr` is in the kit (a headset session needs one; `xrCompatible: false` says otherwise).
 * Internal, exported for the tests.
 */
export function kitGpuOptions(kit: KitOptions): BootGpuOptions | undefined {
  if (!kit.xr) return kit.gpuOptions;
  return { ...kit.gpuOptions, xrCompatible: kit.gpuOptions?.xrCompatible ?? true };
}

async function buildKit(kit: KitOptions, crash: KitCrash | null): Promise<object | null> {
  const design = { width: kit.design?.width ?? 1920, height: kit.design?.height ?? 1080 };
  const dom = kit.dom !== false;
  const external = kit.loop?.frames === 'external';
  if (external && kit.xr) {
    throw new Error("composeGame: `xr` needs the host's frames (not `loop.frames: 'external'`)");
  }
  if (!dom && (!kit.gpu || !kit.host)) {
    throw new Error('composeGame: `dom: false` needs `gpu` and `host` (it touches no DOM)');
  }
  // `renderer` given (even `null`): the engine's renderer is not built.
  const ownMode = kit.renderer !== undefined;
  if (ownMode) {
    for (const key of ['post', 'particles', 'xr'] as const) {
      if (kit[key]) {
        throw new Error(
          `composeGame: \`${key}\` draws through the engine's renderer (not with \`renderer\`)`,
        );
      }
    }
  }
  const res = await bootKit({
    root: kit.root,
    gpu: kit.gpu,
    dom,
    design,
    surface: kit.surface,
    title: kit.title,
    blockBrowserZoom: kit.blockBrowserZoom,
    forceUnsupported: kit.forceUnsupported,
    gpuOptions: kitGpuOptions(kit),
  });
  if (!res) return null;
  const { surface, gpu } = res;
  kit.onGpuReady?.(gpu);
  // Loaded only when the engine draws: a game with its own renderer (or none) never loads it.
  const renderer = ownMode
    ? null
    : (await import('./renderer')).createKitRenderer(gpu, design, kit.aux);
  const own = typeof kit.renderer === 'function' ? await kit.renderer(gpu, surface) : kit.renderer;
  // Without the engine's renderer the kit keeps the camera itself (rays, overlay anchors).
  const kitCamera = renderer ? null : Camera.ortho2d(design.width, design.height);
  let ownCamera = kitCamera;
  const camera = (): Camera => ownCamera ?? renderer!.camera;

  // ── Core: host, save, clock, scenes, loop ──────────────────────────────
  const host = kit.host ?? createWebHost();
  // No save, no storage access: a pure client keeps nothing on the device.
  const save = kit.save ? kit.save(host) : null;
  crash?.setSave(save);
  const clock = kit.clock ?? createTickClock();
  const hooks: GameHooks = {};
  // The stack hands scenes this object on enter; the game fills in its nouns before then.
  const ctx = {} as Record<string, unknown>;
  const stack = new SceneStack<unknown, Frame, Camera>(ctx);
  const sim = kit.loop?.sim;
  // With `sim: false` the loop calls update once per rendered frame with the real delta.
  const fixed = sim !== false;
  // The services the loop steps, set as they are built below.
  let input: KitInputPart | null = null;
  let particles: KitStepPart<object> | null = null;
  let audio: AudioEngine | null = null;
  let ui: Overlay | null = null;
  let xr: KitXrPart | null = null;
  const frames = external ? createExternalFrames() : null;
  const loop = new GameLoop(
    {
      update: (dt: number) => {
        // The input steps first (a replay's feed, then the clock, then input and pad nav);
        // without one the clock just moves by the step.
        if (input) input.step(dt);
        else clock.advance(dt * 1000);
        audio?.update(dt);
        if (fixed) hooks.update?.(dt);
        else hooks.frame?.(dt);
        particles?.update(dt);
        stack.update(dt);
      },
      render: (alpha, time) => {
        hooks.beforeRender?.(time);
        if (!renderer) {
          // The game's own renderer, or none: it draws and presents.
          if (own) own.render(alpha, time);
          else hooks.render?.(alpha, time);
          hooks.afterRender?.(time);
          ui?.updateAnchors();
          return;
        }
        const frame = renderer.beginFrame(time.realTime, time.frameDt);
        const xrSurface = xr?.surface ?? null;
        if (xrSurface) {
          // The scenes record once, through the head; each eye draws the record into the
          // surface's HDR scene target and the post stack resolves it into the eye's part of
          // the layer (ws/xr-post), so the headset sees what the screen would.
          const xrFrame = xr!.frame;
          const eyes = xrFrame ? xrSurface.views(xrFrame) : NO_EYES;
          stack.render(frame, xrSurface.head, alpha);
          if (xr!.immediate !== false) {
            for (let i = 0; i < eyes.length; i++) {
              const eye = eyes[i]!;
              const scene = xrSurface.scene!;
              renderer.render(frame, eye.camera, scene);
              renderer.resolve(scene, eye.target.color.view, eye.viewport);
            }
          }
          renderer.endFrame(NO_PRESENT);
          // The render core's eyes (ws/xr-merge): one cull for the pair, a draw per eye.
          xr!.drawCore?.(eyes);
        } else {
          // Read each frame: `ctx.setCamera` swaps it.
          const camera = renderer.camera;
          stack.render(frame, camera, alpha);
          renderer.render(frame, camera);
          renderer.endFrame();
        }
        hooks.afterRender?.(time);
        ui?.updateAnchors();
      },
    },
    {
      step: sim ? sim.step : undefined,
      fixed,
      frames: frames ?? host,
      // Client mode reads no clock: the game's `frame(now)` gives the time.
      now: frames ? ZERO : undefined,
    },
  );

  // ── Services, in a fixed order ─────────────────────────────────────────
  const core: { -readonly [P in keyof KitCore]: KitCore[P] } = {
    design,
    surface,
    gpu,
    // A service that draws through the engine's renderer can't run without it.
    get renderer(): Renderer {
      if (!renderer) {
        throw new Error("composeGame: no engine renderer (`renderer` is the game's own or null)");
      }
      return renderer;
    },
    camera,
    host,
    clock,
    loop,
    hooks,
    dom,
    aux: kit.aux,
    ui: null,
    pointers: null,
    // The rays go through whatever camera the renderer draws with: the head while a VR session
    // runs (so a head-locked `WorldPanel` faces the headset).
    rayCamera: () => xr?.surface?.head ?? camera(),
  };
  const fields: object[] = [];
  const postPart = kit.post?.setup(core);
  if (postPart) fields.push(postPart.fields);
  particles = kit.particles?.setup(core) ?? null;
  if (particles) fields.push(particles.fields);
  const uiPart = kit.ui?.setup(core);
  if (uiPart) {
    ui = uiPart.fields.ui;
    core.ui = ui;
    fields.push(uiPart.fields);
  }
  surface.onResize(({ rect, backbuffer }) => {
    // Under `fit: 'fill'` the logical size follows the surface (a no-op for any other fit, whose
    // logical size is the design's): `ctx.design`, the renderer's 2D frame, the kit's camera.
    const lw = surface.logicalWidth;
    const lh = surface.logicalHeight;
    if (lw !== design.width || lh !== design.height) {
      design.width = lw;
      design.height = lh;
      renderer?.setLogicalSize(lw, lh);
      if (ownCamera === kitCamera) kitCamera?.setOrtho2d(lw, lh);
    }
    if (renderer) renderer.resize(backbuffer.width, backbuffer.height);
    else own?.resize?.(backbuffer.width, backbuffer.height);
    ui?.setFrame(rect);
  });
  const audioPart = kit.audio?.setup(core);
  if (audioPart) {
    audio = audioPart.fields.audio;
    fields.push(audioPart.fields);
  }
  input = kit.input?.setup(core) ?? null;
  if (input) {
    core.pointers = input.fields.pointers;
    fields.push(input.fields);
  }
  xr = kit.xr?.setup(core) ?? null;
  if (xr) fields.push(xr.fields);

  // ── Lifecycle ──────────────────────────────────────────────────────────
  // Hidden, pagehide (iOS app switch) or freeze (Android): stop drawing and persist now; a
  // phone may kill a background tab without another word.
  if (dom) {
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
  }
  // A host that knows the app's state (ws/host-mobile): background stops frames and flushes the
  // save, active resumes. On the web host the page events above have usually done both already
  // (the loop is then stopped, so the flush is not repeated). A shell's background state also
  // reaches the audio through `audio.background` (ws/audio-4).
  host.lifecycle?.watch((state) => {
    audio?.background(state === 'background');
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
    if (audio) void audio.halt();
    ui?.caption.suspend(true);
    save?.flush();
  });

  Object.assign(
    ctx,
    {
      design,
      surface,
      gpu,
      renderer: renderer ?? own ?? null,
      setCamera: (cam: Camera) => {
        if (renderer) renderer.camera = cam;
        else ownCamera = cam;
      },
      host,
      save,
      clock,
      stack,
      loop,
      hooks,
      onDeviceLost: res.onDeviceLost,
    } satisfies Omit<KitCtx, 'camera' | 'renderer'> & { renderer: unknown },
    ...fields,
  );
  if (frames) ctx.frame = (now: number) => frames.frame(loop, now);
  // `camera` follows `setCamera`.
  Object.defineProperty(ctx, 'camera', {
    get: camera,
    enumerable: true,
    configurable: true,
  });
  return ctx;
}

const ZERO = (): number => 0;
/** What the XR render step iterates when the frame has no viewer pose. */
const NO_EYES: readonly XrEyeView[] = [];
/** `endFrame`'s XR options, hoisted so a headset frame allocates none (ws/xr-fixes). */
const NO_PRESENT = { present: false } as const;
