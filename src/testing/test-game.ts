/**
 * `createTestGame` (ws/core-8): `createGame` itself, headless, on the fake GPU, the fake host
 * and the fixed clock. `step(n)` runs the game's own loop for `n` frames of one fixed step
 * each, so a test presses an action, steps and asserts state with the engine's real frame
 * order. Needs a DOM for the overlay (`// @vitest-environment happy-dom`).
 */
import type { CreateGameOptions, EngineCtx, FlushableSave } from '../core/game';
import { createGame } from '../core/game';
import type { Input } from '../input';
import type { GpuContext } from '../platform';
import {
  createFakeDevice,
  type FakeDevice,
  fakeRendererGpu,
  installGpuGlobals,
} from '../render/fake-gpu';
import { createFakeHost, type FakeHost } from './fake-host';
import { createFixedClock, type FixedClock } from './fixed-clock';

/**
 * `createTestGame` options: `createGame`'s, without `gpu`, `host` and `clock` (the kit makes
 * them; pass `host` or `device` to bring your own) and with `root` optional.
 */
export interface TestGameOptions<A extends string, S extends FlushableSave | null = null>
  extends Omit<CreateGameOptions<A, S>, 'gpu' | 'host' | 'clock' | 'root'> {
  /** Where the canvas and overlay mount. Default a new `<div>` appended to `document.body`. */
  root?: HTMLElement;
  /** The host. Default `createFakeHost()`. */
  host?: FakeHost;
  /** The fake GPU device. Default `createFakeDevice()`. */
  device?: FakeDevice;
  /**
   * The CSS px size the root reports (happy-dom lays nothing out), so the surface letterboxes
   * and pointers map as on a page of that size. Default the design size: client px are design
   * px. The root sits at the viewport's top-left.
   */
  viewport?: { width: number; height: number };
}

/** What `createTestGame` returns. */
export interface TestGame<
  A extends string,
  S extends FlushableSave | null = null,
  C = unknown,
  P = unknown,
> {
  /** The game's ctx, exactly as `createGame` built it. */
  readonly ctx: EngineCtx<A, S, C, P>;
  /** `ctx.input`. */
  readonly input: Input<A>;
  /** The fake host (`ctx.host`): storage in memory, `setState`, recorded haptics. */
  readonly host: FakeHost;
  /** `ctx.clock`: N steps read exactly N × the fixed step. */
  readonly clock: FixedClock;
  /** The fake GPU device the renderer records into. */
  readonly device: FakeDevice;
  /**
   * Run `n` frames (default 1) through the game's loop (`ctx.loop.tickOnce(step)`), each one
   * fixed update (replay, clock, input, pad navigation, `hooks.update`, particles, scenes) and
   * one render. With `sim: false` each frame updates once with the step as its delta. A halted
   * loop (device lost) runs nothing.
   */
  step(n?: number): void;
}

/**
 * `createGame` with the testing kit's fakes: a `FakeDevice` as the GPU, a `FakeHost` as the
 * host (save storage in memory) and a `FixedClock` as `ctx.clock`, on the step of `opts.sim`
 * (default 1/60 s). The loop is not started; `step(n)` drives it.
 */
export async function createTestGame<
  A extends string,
  S extends FlushableSave | null = null,
  C = unknown,
  P = unknown,
>(opts: TestGameOptions<A, S>): Promise<TestGame<A, S, C, P>> {
  const doc = globalThis.document;
  if (!doc) {
    throw new Error('createTestGame needs a DOM: add `// @vitest-environment happy-dom`');
  }
  installGpuGlobals();
  const device = opts.device ?? createFakeDevice();
  const host = opts.host ?? createFakeHost();
  const step = opts.sim ? (opts.sim.step ?? 1 / 60) : 1 / 60;
  // `step × 1000` is what the loop advances the clock by, so each fixed update is one tick.
  const clock = createFixedClock(step * 1000);
  const design = { width: opts.design?.width ?? 1920, height: opts.design?.height ?? 1080 };
  const view = opts.viewport ?? design;
  const root = opts.root ?? doc.body.appendChild(doc.createElement('div'));
  sizeElement(root, () => ({ left: 0, top: 0, width: view.width, height: view.height }));
  const gpu: GpuContext = {
    ...fakeRendererGpu(device),
    adapter: {} as GPUAdapter,
    timestamps: false,
  };
  const ctx = await createGame<A, S, C, P>({ ...opts, root, gpu, host, clock });
  if (!ctx) throw new Error('createTestGame: createGame returned null');
  // The canvas reports the box the surface gave it, so a touch zone measures as on a page.
  const surface = ctx.surface;
  sizeElement(surface.canvas, () => {
    const r = surface.rect;
    return { left: r.x, top: r.y, width: r.width, height: r.height };
  });
  return {
    ctx,
    input: ctx.input,
    host,
    clock,
    device,
    step(n = 1) {
      for (let i = 0; i < n; i++) ctx.loop.tickOnce(step);
    },
  };
}

type Box = { left: number; top: number; width: number; height: number };

/** Make `el` report `box()` as its layout box (happy-dom computes none). */
function sizeElement(el: HTMLElement, box: () => Box): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => box().width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box().height });
  el.getBoundingClientRect = () => {
    const b = box();
    return {
      x: b.left,
      y: b.top,
      left: b.left,
      top: b.top,
      width: b.width,
      height: b.height,
      right: b.left + b.width,
      bottom: b.top + b.height,
      toJSON: () => b,
    } as DOMRect;
  };
}
