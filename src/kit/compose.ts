/**
 * `composeGame` (ws/kit, E-041 P4): the lean composer. It always builds the core (surface and
 * GPU, renderer, host, tick clock, hooks, scene stack, loop) and wires the lifecycle and device
 * loss; every other service (post, particles, overlay, audio, input, XR) is built only when the
 * game passes it (`withPost()`, `withOverlay({ layout })`, ...), so a game that leaves one out
 * never imports its module. The root `createGame` is this composer with every service passed.
 */

import type { AudioEngine } from '../audio';
import { type CrashScreen, installCrashScreen } from '../core/crash';
import { GameLoop } from '../core/loop';
import { SceneStack } from '../core/scene';
import { createWebHost, type Host } from '../host';
import { createTickClock, type PointerRouter, type TickClock } from '../input';
import {
  type GpuContext,
  type Surface,
  type SurfaceOptions,
  watchLifecycle,
  type XrEyeView,
  type XrSurface,
} from '../platform';
import type { XRFrame } from '../platform/xr-types';
import type { Camera, Frame, Renderer, SceneTargetAux } from '../render';
import type { Overlay } from '../ui';
import { bootKit, createKitRenderer } from './boot';
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

/** The save type `K.save` builds, or `null`. */
type SaveOf<K> = K extends { save(host: Host): infer S extends FlushableSave | null } ? S : null;

/**
 * What `composeGame(kit)` resolves to: `KitCtx` plus the fields of exactly the services `kit`
 * passed (`ctx.ui` only with `ui`, ...), plus `frame(now)` with `loop: { frames: 'external' }`.
 */
export type KitGame<K extends KitOptions> = KitCtx<SaveOf<K>> &
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
  const res = await bootKit({
    root: kit.root,
    gpu: kit.gpu,
    dom,
    design,
    surface: kit.surface,
    title: kit.title,
    blockBrowserZoom: kit.blockBrowserZoom,
    forceUnsupported: kit.forceUnsupported,
  });
  if (!res) return null;
  const { surface, gpu } = res;
  kit.onGpuReady?.(gpu);
  const renderer = createKitRenderer(gpu, design, kit.aux);

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
        const frame = renderer.beginFrame(time.realTime, time.frameDt);
        const xrSurface = xr?.surface ?? null;
        if (xrSurface) {
          // The scenes record once, through the head; each eye draws the record into the
          // surface's HDR scene target and the post stack resolves it into the eye's part of
          // the layer (ws/xr-post), so the headset sees what the screen would.
          const xrFrame = xr!.frame;
          const eyes = xrFrame ? xrSurface.views(xrFrame) : NO_EYES;
          stack.render(frame, xrSurface.head, alpha);
          for (let i = 0; i < eyes.length; i++) {
            const eye = eyes[i]!;
            const scene = xrSurface.scene!;
            renderer.render(frame, eye.camera, scene);
            renderer.resolve(scene, eye.target.color.view, eye.viewport);
          }
          renderer.endFrame(NO_PRESENT);
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
    renderer,
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
    rayCamera: () => xr?.surface?.head ?? renderer.camera,
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
    renderer.resize(backbuffer.width, backbuffer.height);
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
      renderer,
      setCamera: (cam: Camera) => {
        renderer.camera = cam;
      },
      host,
      save,
      clock,
      stack,
      loop,
      hooks,
      onDeviceLost: res.onDeviceLost,
    } satisfies Omit<KitCtx, 'camera'>,
    ...fields,
  );
  if (frames) ctx.frame = (now: number) => frames.frame(loop, now);
  // `camera` follows `setCamera`.
  Object.defineProperty(ctx, 'camera', {
    get: () => renderer.camera,
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
