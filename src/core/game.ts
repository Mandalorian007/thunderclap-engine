/**
 * `createGame` (D-041 Phase 1): the noun-free wiring every ThunderClap game starts from.
 *
 * It blocks browser zoom, boots WebGPU on a letterboxed surface and builds, in this order: renderer, post stack,
 * particles, host, the game's save, overlay and pad navigation, device mode with fill bands,
 * audio (mixer persisted through the host), input, the scene stack and the frame loop. It also
 * wires the page lifecycle (hide, pagehide and freeze stop frames and flush the save; show
 * resumes) and device loss (the reload screen, then loop, audio and captions halt for good).
 *
 * Games add their nouns by extending the returned object (`Object.assign(ctx, { ... })`): the
 * scene stack hands scenes this same object, so a scene typed against the game's own ctx sees
 * them. Game logic plugs into the frame and the lifecycle through `ctx.hooks`.
 */
import { AudioEngine, persistMixer } from '../audio';
import { ParticleSystem, type ParticleSystemOptions } from '../fx';
import { createWebHost, type Host } from '../host';
import { type Bindings, Input } from '../input';
import {
  blockBrowserZoom,
  boot,
  createDeviceMode,
  type DeviceMode,
  type FillWidthOptions,
  type GpuContext,
  PHONE_SCALE,
  type Surface,
  type SurfaceOptions,
  watchLifecycle,
} from '../platform';
import { type PostSettingsPatch, PostStack } from '../post';
import { type Frame, installGpuErrorLogging, Renderer } from '../render';
import {
  type CssChrome,
  createCssChrome,
  createOverlay,
  type FormFactor,
  type LayoutSpec,
  type Overlay,
  PadNav,
} from '../ui';
import type { Time } from './loop';
import { GameLoop } from './loop';
import { SceneStack } from './scene';

/** What `createGame` needs from a game's save: it is flushed on hide and on device loss. */
export interface FlushableSave {
  flush(): void;
}

/** Game logic plugged into the frame loop and the lifecycle. Set fields on `ctx.hooks`. */
export interface GameHooks {
  /** Each fixed step, after input and pad navigation, before particles and the scenes. */
  update?(dt: number): void;
  /** Each rendered frame, before `renderer.beginFrame`. */
  beforeRender?(time: Time): void;
  /** Each rendered frame, after `renderer.endFrame`. */
  afterRender?(time: Time): void;
  /** The page is hidden, paged out or frozen: after the loop stops, before the save flushes. */
  hide?(): void;
  /** The GPU device was lost: after the loop halts, before audio halts and the save flushes. */
  deviceLost?(info: GPUDeviceLostInfo): void;
}

export interface CreateGameOptions<A extends string, S extends FlushableSave> {
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
  /** Builds the game's save from the host's storage. */
  save(host: Host): S;
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
  };
  /**
   * Injects the game's stylesheets. Runs before the overlay adds the engine's, so the cascade
   * (engine sheets after game sheets) is the same in every game.
   */
  styles?(doc: Document): void;
  /**
   * Phones: fill bands by key (D-040). While the fill key names a band and the letterbox scale
   * is below `PHONE_SCALE`, the surface fills the width and crops top and bottom to the band.
   */
  fillBands?: Readonly<Record<string, FillWidthOptions>>;
  /**
   * A CSS-px overlay with layout regions beside the legacy scaled one (`createCssChrome`; see
   * ARCHITECTURE.md, "Two overlays"). Omit it and `ctx.chrome` is null.
   */
  overlay?: {
    /** Form factors that use the CSS-px overlay. Default: both phone form factors. */
    cssForms?: readonly FormFactor[];
    /** Region tracks per form factor (see `createLayout`). */
    layout?: LayoutSpec;
  };
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
 */
export interface EngineCtx<
  A extends string = string,
  S extends FlushableSave = FlushableSave,
  C = unknown,
> {
  readonly design: { readonly width: number; readonly height: number };
  readonly surface: Surface;
  readonly gpu: GpuContext;
  readonly renderer: Renderer;
  readonly post: PostStack;
  /** Shared GPU particle pool; updated by the loop, drawn by views. */
  readonly particles: ParticleSystem;
  readonly input: Input<A>;
  /** Drives modal panels from the pad (d-pad moves focus, A activates, B closes). */
  readonly padNav: PadNav;
  readonly audio: AudioEngine;
  readonly ui: Overlay;
  /**
   * The CSS-px overlay and its layout (`CreateGameOptions.overlay`), or null. While
   * `chrome.active`, the panels and toasts of `ui` lay out in it.
   */
  readonly chrome: CssChrome | null;
  /** The page the game runs in: links, copying, fullscreen and save storage. */
  readonly host: Host;
  /** Phone-sized screen and touch input flags (interim until Phase 2's layout). */
  readonly device: DeviceMode;
  readonly save: S;
  readonly stack: SceneStack<C, Frame>;
  readonly loop: GameLoop;
  /** Game logic in the frame and lifecycle; see `GameHooks`. */
  readonly hooks: GameHooks;
  /**
   * Selects the fill band by key (see `CreateGameOptions.fillBands`; the key starts as
   * `'boot'`) and re-fits the surface. A key with no band letterboxes.
   */
  setFill(key: string): void;
  /** Runs `fn` after the device-lost screen and the engine's halt. Returns unsubscribe. */
  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): () => void;
}

/**
 * Boots WebGPU and builds the engine ctx. Resolves `null` when WebGPU is unavailable: the
 * engine has already shown the unsupported screen and there is nothing more to do.
 *
 * Nothing runs until the game calls `ctx.loop.start()`, except the lifecycle handlers (a show
 * starts the loop) and resize, which keeps the renderer, overlay and fill in step.
 */
export async function createGame<A extends string, S extends FlushableSave, C = unknown>(
  opts: CreateGameOptions<A, S>,
): Promise<EngineCtx<A, S, C> | null> {
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
  const save = opts.save(host);
  opts.styles?.(surface.root.ownerDocument);
  // When a panel closes and its opener can't take focus back, focus returns to the canvas so
  // keys keep reaching the game.
  const ui = createOverlay({
    parent: surface.root,
    designWidth: design.width,
    designHeight: design.height,
    focusHome: () => surface.canvas,
  });
  // Input is blocked while a modal panel is up, so the pad drives panels through this.
  const padNav = new PadNav(ui.stack);
  const device = createDeviceMode(ui.root);
  const chrome = opts.overlay
    ? createCssChrome({
        parent: surface.root,
        legacy: ui,
        forms: opts.overlay.cssForms,
        layout: opts.overlay.layout,
        focusHome: () => surface.canvas,
      })
    : null;
  if (chrome) {
    // The last input's kind (`data-touch`) goes on both roots.
    const touch = () => chrome.ui.root.toggleAttribute('data-touch', device.touch);
    touch();
    device.onChange(touch);
  }

  // Fill bands (D-040): on a phone-sized letterbox a keyed scene fills the width instead.
  let fillKey = 'boot';
  const applyFill = () => {
    const band = opts.fillBands?.[fillKey];
    surface.setFill(band && surface.fitRect.scale < PHONE_SCALE ? band : null);
  };
  const applyScale = () => {
    const r = surface.rect;
    const ch = surface.root.clientHeight;
    device.setScale(ui.scale, r.x, {
      fitScale: surface.fitRect.scale,
      top: Math.max(0, -r.y),
      bottom: Math.max(0, r.y + r.height - ch),
    });
    // A filled scene that still leaves slim bars (very wide phones) fades its side edges into
    // them, so the art ends softly instead of at a hard letterbox line.
    const soft = r.height > ch + 1 && r.x > 0;
    surface.canvas.style.maskImage = soft
      ? 'linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent)'
      : '';
  };
  surface.onResize(({ rect, backbuffer }) => {
    renderer.resize(backbuffer.width, backbuffer.height);
    ui.setRect(rect);
    chrome?.resize();
    applyScale();
    applyFill();
  });

  // ── Audio ──────────────────────────────────────────────────────────────
  // Unlocks on the first gesture and pauses itself while the page is hidden (see attach).
  const audio = new AudioEngine();
  audio.attach();
  if (opts.mixerKey) persistMixer(audio, { game: opts.mixerKey, host });

  // ── Input (blocked under modal panels) ─────────────────────────────────
  const extraBlock = opts.input.blocked;
  const input = new Input<A>(opts.input.bindings, {
    blocked: extraBlock ? () => ui.stack.hasModal || extraBlock() : () => ui.stack.hasModal,
    globalKeys: opts.input.globalKeys,
    buttonKeys: opts.input.buttonKeys,
  });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  // ── Scenes + loop ──────────────────────────────────────────────────────
  const hooks: GameHooks = {};
  // The stack hands scenes this object on enter; the game fills in its nouns before then.
  const ctx = {} as EngineCtx<A, S, C>;
  const stack = new SceneStack<C, Frame>(ctx as C);
  const loop = new GameLoop({
    update: (dt: number) => {
      input.update();
      padNav.update();
      hooks.update?.(dt);
      particles.update(dt);
      stack.update(dt);
    },
    render: (alpha: number, time: Time) => {
      hooks.beforeRender?.(time);
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      stack.render(frame, alpha);
      renderer.endFrame();
      hooks.afterRender?.(time);
    },
  });

  // Hidden, pagehide (iOS app switch) or freeze (Android): stop drawing and persist now; a
  // phone may kill a background tab without another word.
  watchLifecycle({
    onHide: () => {
      loop.stop();
      hooks.hide?.();
      save.flush();
    },
    onShow: () => loop.start(),
  });

  // Device lost: boot has shown the reload screen; stop all work behind it for good.
  res.onDeviceLost((info) => {
    loop.halt();
    hooks.deviceLost?.(info);
    void audio.halt();
    ui.caption.suspend(true);
    save.flush();
  });

  Object.assign(ctx, {
    design,
    surface,
    gpu,
    renderer,
    post,
    particles,
    input,
    padNav,
    audio,
    ui,
    chrome,
    host,
    device,
    save,
    stack,
    loop,
    hooks,
    setFill(key: string) {
      fillKey = key;
      applyFill();
    },
    onDeviceLost: res.onDeviceLost,
  } satisfies EngineCtx<A, S, C>);
  return ctx;
}
