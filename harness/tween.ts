/**
 * Tween demo page: a grid with one cell per ease. Each cell draws its easing curve (sampled
 * once at setup into sprite positions; the spring's curve from a short simulation of the same
 * equation) and a sprite that `Tweens.to` moves from the cell's left to its right over
 * `RUN_SECONDS` with that ease, its height following the eased value. Nothing here is engine
 * code beyond the tween module and the 2D renderer.
 *
 * Every run is one tween per ease, no loops, so `active` returns to 0 when all have landed and
 * `samples[name]` is exactly 1 for each; `restart()` runs it again (e2e/tween.spec.ts).
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  type DrawParams,
  gpuDiagnostics,
  installGpuErrorLogging,
  Renderer,
} from '@thunderclap-engine/engine/render';
import { createTweens, type Ease, ease, type SpringEase } from '@thunderclap-engine/engine/tween';
import type { HarnessTweenApi, HarnessTweenState } from './tween-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const COLS = 8;
const ROWS = 5;
const CELL_W = LOGICAL.width / COLS;
const CELL_H = LOGICAL.height / ROWS;
const PAD_X = 28;
const PAD_Y = 52;
const CURVE_SAMPLES = 40;
const RUN_SECONDS = 1.5;
const SPRING_CURVE_SECONDS = 1.2;

const CLEAR = [0.03, 0.035, 0.06] as const;
const CURVE_TINT = [0.25, 0.45, 0.7, 1] as const;
const AXIS_TINT = [0.12, 0.14, 0.2, 1] as const;
const DOT_TINT = [1.0, 0.75, 0.3, 1] as const;

interface Entry {
  name: string;
  ease: Ease | SpringEase;
  /** Curve samples: eased value per i / (CURVE_SAMPLES - 1). */
  curve: Float32Array;
  /** The animated object: `t` is the linear position 0..1 the tween moves. */
  dot: { t: number };
  /** Reused draw params: the curve points, the two axes and the moving dot. */
  curveParams: DrawParams[];
  axisParams: DrawParams[];
  dotParams: DrawParams;
}

/** The spring's curve by simulating the same equation the tween integrates. */
function springCurve(s: SpringEase, out: Float32Array): void {
  let x = 0;
  let v = 0;
  const steps = 240;
  const h = SPRING_CURVE_SECONDS / steps;
  const per = steps / (out.length - 1);
  out[0] = 0;
  for (let i = 1; i <= steps; i++) {
    v += (s.stiffness * (1 - x) - s.damping * v) * h;
    x += v * h;
    if (i % per === 0) out[i / per] = x;
  }
}

function buildEntries(): Entry[] {
  const table: [string, Ease | SpringEase][] = [
    ['linear', ease.linear],
    ['smoothstep', ease.smoothstep],
    ['quadIn', ease.quadIn],
    ['quadOut', ease.quadOut],
    ['quadInOut', ease.quadInOut],
    ['cubicIn', ease.cubicIn],
    ['cubicOut', ease.cubicOut],
    ['cubicInOut', ease.cubicInOut],
    ['quartIn', ease.quartIn],
    ['quartOut', ease.quartOut],
    ['quartInOut', ease.quartInOut],
    ['quintIn', ease.quintIn],
    ['quintOut', ease.quintOut],
    ['quintInOut', ease.quintInOut],
    ['sineIn', ease.sineIn],
    ['sineOut', ease.sineOut],
    ['sineInOut', ease.sineInOut],
    ['expoIn', ease.expoIn],
    ['expoOut', ease.expoOut],
    ['expoInOut', ease.expoInOut],
    ['circIn', ease.circIn],
    ['circOut', ease.circOut],
    ['circInOut', ease.circInOut],
    ['backIn', ease.backIn],
    ['backOut', ease.backOut],
    ['backInOut', ease.backInOut],
    ['elasticIn', ease.elasticIn],
    ['elasticOut', ease.elasticOut],
    ['elasticInOut', ease.elasticInOut],
    ['bounceIn', ease.bounceIn],
    ['bounceOut', ease.bounceOut],
    ['bounceInOut', ease.bounceInOut],
    ['steps', ease.steps(5)],
    ['bezier', ease.cubicBezier(0.68, -0.6, 0.32, 1.6)],
    ['spring', ease.spring()],
  ];
  return table.map(([name, e], i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x0 = col * CELL_W + PAD_X;
    const x1 = (col + 1) * CELL_W - PAD_X;
    const yBottom = (row + 1) * CELL_H - PAD_Y;
    const yTop = row * CELL_H + PAD_Y;
    const span = yBottom - yTop;
    const curve = new Float32Array(CURVE_SAMPLES);
    if (typeof e === 'function') {
      for (let j = 0; j < CURVE_SAMPLES; j++) curve[j] = e(j / (CURVE_SAMPLES - 1));
    } else {
      springCurve(e, curve);
    }
    const curveParams: DrawParams[] = [];
    for (let j = 0; j < CURVE_SAMPLES; j++) {
      curveParams.push({
        x: x0 + ((x1 - x0) * j) / (CURVE_SAMPLES - 1),
        y: yBottom - span * curve[j]!,
        w: 4,
        h: 4,
        tint: CURVE_TINT,
      });
    }
    const axisParams: DrawParams[] = [
      { x: (x0 + x1) / 2, y: yBottom, w: x1 - x0, h: 2, tint: AXIS_TINT },
      { x: (x0 + x1) / 2, y: yTop, w: x1 - x0, h: 2, tint: AXIS_TINT },
    ];
    const dotParams: DrawParams = { x: x0, y: yBottom, w: 14, h: 14, tint: DOT_TINT };
    return { name, ease: e, curve, dot: { t: 0 }, curveParams, axisParams, dotParams };
  });
}

async function main(): Promise<void> {
  const entries = buildEntries();
  const state: HarnessTweenState = {
    ready: false,
    gpu: 'pending',
    frames: 0,
    logical: LOGICAL,
    eases: entries.map((e) => e.name),
    active: 0,
    elapsed: 0,
    samples: Object.fromEntries(entries.map((e) => [e.name, 0])),
    completed: 0,
    runs: 0,
    gpuErrors: 0,
  };
  const tweens = createTweens();

  function startRun(): void {
    tweens.killAll();
    state.runs++;
    state.elapsed = 0;
    state.completed = 0;
    for (const e of entries) {
      e.dot.t = 0;
      tweens.to(e.dot, { t: 1 }, RUN_SECONDS, {
        ease: e.ease,
        onComplete: () => {
          state.completed++;
        },
      });
    }
  }

  const api: HarnessTweenApi = { state, restart: startRun };
  window.__harnessTween = api;

  const res = await boot(root, { title: 'Engine tween demo' });
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

  startRun();

  const loop = new GameLoop({
    update(dt) {
      tweens.update(dt);
      state.elapsed += dt;
      state.active = tweens.active;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x0 = col * CELL_W + PAD_X;
        const x1 = (col + 1) * CELL_W - PAD_X;
        const yBottom = (row + 1) * CELL_H - PAD_Y;
        const span = CELL_H - 2 * PAD_Y;
        // The property tween moves `t` through the ease; the dot's height is the eased value and
        // its x the linear time, so the dot rides the drawn curve.
        const k = e.dot.t;
        e.dotParams.x = x0 + (x1 - x0) * progressOf(e, state.elapsed);
        e.dotParams.y = yBottom - span * k;
        state.samples[e.name] = k;
      }
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      for (const e of entries) {
        for (const p of e.axisParams) frame.sprite(null, p);
        for (const p of e.curveParams) frame.sprite(null, p);
      }
      for (const e of entries) frame.sprite(null, e.dotParams);
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

/** Linear time of an entry's tween within the run, 0..1 (a spring's runs on the curve's clock). */
function progressOf(e: Entry, elapsed: number): number {
  const seconds = typeof e.ease === 'function' ? RUN_SECONDS : SPRING_CURVE_SECONDS;
  return Math.min(1, elapsed / seconds);
}

main().catch((err) => {
  console.error('[harness]', err);
  const api = window.__harnessTween;
  if (api) {
    api.state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
    api.state.ready = true;
  }
});
