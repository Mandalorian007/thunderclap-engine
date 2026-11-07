/**
 * Core-2 page (ws/core-2): the deterministic utilities in `@thunderclap-engine/engine/core`, one mode per
 * query flag.
 *
 * - `?random` (default): 2000 points scattered by two streams forked from one seed, the left half
 *   from `fork('left')`, the right from `fork('right')`; `checksum` and `forkChecksum` pin the
 *   sequences.
 * - `?noise`: a 128 × 72 fbm field of `perlin3` over the canvas, drifting in z; `min`, `max` and
 *   `checksum` describe the field at time 0.
 * - `?timer`: a scheduler on the loop's `dt` blinking eight cells at different periods, a one-shot
 *   chain re-arming itself, and a cooldown bar used every 2 s (`useCooldown()` from the spec).
 * - `?preload`: `createGame`; a first scene runs, then a second is pushed whose `preload` takes 1 s
 *   on a scheduler while `ui.loading` shows (driven from `stack.onTransition`).
 * - `?still` parks every mode (the scheduler paused, the field at time 0).
 *
 * Nothing here is engine code beyond the core module, the 2D renderer and `createGame`.
 */
import { createGame, type EngineCtx } from '@thunderclap-engine/engine';
import {
  createNoise,
  createRandom,
  createScheduler,
  GameLoop,
  type Random,
  type Scene,
} from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  type Camera,
  type DrawParams,
  type Frame,
  gpuDiagnostics,
  installGpuErrorLogging,
  Renderer,
} from '@thunderclap-engine/engine/render';
import type { Core2Mode, HarnessCore2Api, HarnessCore2State } from './core2-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const MODES: Core2Mode[] = ['random', 'noise', 'timer', 'preload'];
const mode: Core2Mode = MODES.find((m) => params.has(m)) ?? 'random';
const still = params.has('still');
const LOGICAL = { width: 1920, height: 1080 };
const CLEAR = [0.03, 0.035, 0.06] as const;

const state: HarnessCore2State = {
  ready: false,
  gpu: 'pending',
  mode,
  still,
  frames: 0,
  gpuErrors: 0,
  points: 0,
  checksum: 0,
  forkChecksum: 0,
  min: 0,
  max: 0,
  cells: 0,
  fires: 0,
  cooldownReady: true,
  cooldownUses: 0,
  readyTransitions: 0,
  cooldownProgress: 1,
  timerTime: 0,
  phase: 'boot',
  oldSceneFrames: 0,
  preloadSeconds: 0,
  pushResolved: false,
  loadingShown: false,
};
let useCooldown = () => false;
let resetCooldown = () => {};
const api: HarnessCore2Api = {
  state,
  useCooldown: () => useCooldown(),
  resetCooldown: () => resetCooldown(),
};
window.__harnessCore2 = api;

/** FNV-1a over a sequence of 32-bit integers. */
function fnv(values: Iterable<number>): number {
  let h = 0x811c9dc5;
  for (const v of values) h = Math.imul(h ^ v, 0x01000193);
  return h >>> 0;
}

function* firstU32(r: Random, n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield Math.floor(r.next() * 4294967296);
}

/** A mode's draws: `update(dt)` on the fixed step, `draw(frame)` per rendered frame. */
interface Page {
  update(dt: number): void;
  draw(frame: Frame): void;
}

function randomPage(): Page {
  state.checksum = fnv(firstU32(createRandom('core2'), 100));
  state.forkChecksum = fnv(firstU32(createRandom('core2').fork('left'), 100));
  const seed = createRandom('core2');
  const halves: [Random, number, readonly [number, number, number, number]][] = [
    [seed.fork('left'), 0, [1, 0.6, 0.25, 1]],
    [seed.fork('right'), LOGICAL.width / 2, [0.3, 0.7, 1, 1]],
  ];
  const dots: DrawParams[] = [];
  const v = new Float32Array(2);
  for (const [r, x0, tint] of halves) {
    for (let i = 0; i < 1000; i++) {
      // Every other point is a gaussian splash around the half's centre, the rest uniform.
      let x: number;
      let y: number;
      if (i % 2 === 0) {
        x = r.float(x0 + 40, x0 + LOGICAL.width / 2 - 40);
        y = r.float(40, LOGICAL.height - 40);
      } else {
        r.unitVec2(v);
        const d = Math.abs(r.gaussian(0, 160));
        x = x0 + LOGICAL.width / 4 + v[0]! * d;
        y = LOGICAL.height / 2 + v[1]! * d;
      }
      const s = r.int(3, 7);
      dots.push({ x, y, w: s, h: s, tint });
    }
  }
  state.points = dots.length;
  const divider: DrawParams = {
    x: LOGICAL.width / 2,
    y: LOGICAL.height / 2,
    w: 2,
    h: LOGICAL.height,
    tint: [0.2, 0.22, 0.3, 1],
  };
  return {
    update() {},
    draw(frame) {
      frame.sprite(null, divider);
      for (let i = 0; i < dots.length; i++) frame.sprite(null, dots[i]!);
    },
  };
}

function noisePage(): Page {
  const COLS = 128;
  const ROWS = 72;
  const CELL = LOGICAL.width / COLS;
  const SCALE = 1 / 16;
  const FBM = { octaves: 5, lacunarity: 2, gain: 0.5 };
  const noise = createNoise('core2');
  const cells: DrawParams[] = [];
  const tints: [number, number, number, number][] = [];
  let min = Infinity;
  let max = -Infinity;
  const quantised: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = noise.fbm(noise.perlin3, (c + 0.5) * SCALE, (r + 0.5) * SCALE, 0, FBM);
      if (v < min) min = v;
      if (v > max) max = v;
      quantised.push(Math.round(v * 1e4) | 0);
      const tint: [number, number, number, number] = [0, 0, 0, 1];
      tints.push(tint);
      cells.push({ x: (c + 0.5) * CELL, y: (r + 0.5) * CELL, w: CELL, h: CELL, tint });
    }
  }
  state.min = min;
  state.max = max;
  state.checksum = fnv(quantised);
  state.cells = cells.length;
  let z = 0;
  let tick = 0;
  const shade = () => {
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = noise.fbm(noise.perlin3, (c + 0.5) * SCALE, (r + 0.5) * SCALE, z, FBM);
        const k = 0.5 + 0.5 * v;
        const t = tints[i++]!;
        t[0] = 0.1 + 0.5 * k * k;
        t[1] = 0.15 + 0.7 * k;
        t[2] = 0.25 + 0.6 * (1 - k) * k * 2;
      }
    }
  };
  shade();
  return {
    update(dt) {
      if (still) return;
      z += dt * 0.15;
      if (++tick % 3 === 0) shade();
    },
    draw(frame) {
      for (let i = 0; i < cells.length; i++) frame.sprite(null, cells[i]!);
    },
  };
}

function timerPage(): Page {
  const scheduler = createScheduler();
  if (still) scheduler.pause();
  const on = new Uint8Array(8);
  const blinks: DrawParams[] = [];
  const OFF: readonly [number, number, number, number] = [0.12, 0.14, 0.2, 1];
  const ON: readonly [number, number, number, number] = [1, 0.8, 0.3, 1];
  for (let i = 0; i < 8; i++) {
    blinks.push({ x: 240 + i * 205, y: 380, w: 150, h: 150, tint: OFF });
    const period = 0.2 + i * 0.1;
    scheduler.every(period, () => {
      state.fires++;
      on[i] = on[i] ? 0 : 1;
      blinks[i]!.tint = on[i] ? ON : OFF;
    });
  }
  // A one-shot that re-arms itself: a dot stepping along a row.
  const chainDot: DrawParams = { x: 120, y: 620, w: 40, h: 40, tint: [0.4, 0.9, 0.6, 1] };
  let step = 0;
  const hop = () => {
    state.fires++;
    step = (step + 1) % 16;
    chainDot.x = 120 + step * 110;
    scheduler.after(0.35, hop);
  };
  scheduler.after(0.35, hop);
  // The cooldown: used every 2 s, 1.2 s long, so it is ready for 0.8 s of each cycle.
  const cd = scheduler.cooldown('pulse', 1.2);
  scheduler.every(2, () => {
    state.fires++;
    if (cd.use()) state.cooldownUses++;
  });
  useCooldown = () => cd.use();
  resetCooldown = () => cd.reset();
  let wasReady = cd.ready;
  const BAR_W = 1200;
  const track: DrawParams = { x: 960, y: 820, w: BAR_W, h: 36, tint: [0.12, 0.14, 0.2, 1] };
  const fill: DrawParams = { x: 360, y: 820, w: 0, h: 36, tint: [0.3, 0.7, 1, 1] };
  const sync = () => {
    if (cd.ready && !wasReady) state.readyTransitions++;
    wasReady = cd.ready;
    state.cooldownReady = cd.ready;
    state.cooldownProgress = cd.progress;
    state.timerTime = scheduler.time;
    fill.w = BAR_W * cd.progress;
    fill.x = 360 + fill.w / 2;
    fill.tint = cd.ready ? [0.4, 0.9, 0.6, 1] : [0.3, 0.7, 1, 1];
  };
  sync();
  return {
    update(dt) {
      scheduler.update(dt);
      sync();
    },
    draw(frame) {
      for (let i = 0; i < blinks.length; i++) frame.sprite(null, blinks[i]!);
      frame.sprite(null, chainDot);
      frame.sprite(null, track);
      frame.sprite(null, fill);
    },
  };
}

async function bootRenderer(page: () => Page): Promise<void> {
  const res = await boot(root, { title: 'Engine core-2 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));
  const p = page();
  const loop = new GameLoop({
    update: (dt) => p.update(dt),
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      p.draw(frame);
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

type Ctx = EngineCtx<'tap', null>;

/** A scene that draws one sliding square in `tint`. */
function slider(name: string, tint: readonly [number, number, number, number], y: number) {
  const sq: DrawParams = { x: 200, y, w: 120, h: 120, tint };
  let t = 0;
  const scene: Scene<Ctx, Frame, Camera> = {
    name,
    update(dt) {
      t += dt;
      sq.x = 960 + Math.sin(t * 2) * 700;
    },
    render(frame) {
      frame.sprite(null, sq);
    },
  };
  return scene;
}

async function bootPreload(): Promise<void> {
  const ctx = await createGame({
    root,
    title: 'Engine core-2 demo',
    sim: false,
    input: { bindings: { tap: [{ mouse: 0 }] } },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  // `?still` does not park this mode: the preload runs on this scheduler.
  const scheduler = createScheduler();
  ctx.hooks.frame = (dt) => scheduler.update(dt);
  ctx.hooks.afterRender = () => {
    state.frames++;
    state.gpuErrors = gpuDiagnostics.errorCount;
  };

  const old = slider('old', [1, 0.6, 0.25, 1], 400);
  const oldUpdate = old.update!;
  old.update = (dt) => {
    oldUpdate(dt);
    if (ctx.stack.transitioning) state.oldSceneFrames++;
  };
  const next = slider('next', [0.3, 0.7, 1, 1], 700);
  let started = 0;
  next.preload = () =>
    new Promise<void>((resolve) => {
      started = scheduler.time;
      scheduler.after(1, () => {
        state.preloadSeconds = scheduler.time - started;
        resolve();
      });
    });

  let loading: ReturnType<Ctx['ui']['loading']> | null = null;
  let progress = 0;
  ctx.stack.onTransition((_from, to, phase) => {
    if (to !== next) return;
    if (phase === 'preload') {
      state.phase = 'preload';
      loading = ctx.ui.loading({ title: 'Loading', tip: 'A one-second preload on the scheduler' });
      state.loadingShown = loading.visible;
      const h = scheduler.every(0.1, () => {
        progress = Math.min(1, progress + 0.1);
        loading?.set(progress);
        if (progress >= 1) scheduler.cancel(h);
      });
    } else if (phase === 'enter') {
      state.phase = 'enter';
      const l = loading;
      loading = null;
      void l?.done().then(() => {
        state.phase = 'done';
      });
    }
  });

  ctx.loop.start();
  await ctx.stack.push(old);
  state.phase = 'old';
  // Let the old scene run a beat, then push the loading one.
  scheduler.after(0.3, () => {
    void ctx.stack.push(next).then(() => {
      state.pushResolved = ctx.stack.top === next;
    });
  });
  state.gpu = 'ok';
  state.ready = true;
}

const MODE_PAGES: Record<Exclude<Core2Mode, 'preload'>, () => Page> = {
  random: randomPage,
  noise: noisePage,
  timer: timerPage,
};
const run = mode === 'preload' ? bootPreload() : bootRenderer(MODE_PAGES[mode]);

run.catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
