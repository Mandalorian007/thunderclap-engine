/**
 * Debug-draw demo page: every `DebugDraw` shape under a perspective camera over the clear
 * colour, in one `'line-list'` draw per frame. Nothing here is engine code: the motion is what
 * a game would write.
 *
 * - `axes` at the origin (x red, y green, z blue) over a grey `grid` offset by half a step so
 *   no grid line runs along an axis. e2e/debug.spec.ts samples a point on the +x axis.
 * - A wire `box` spinning on two axes and a `wireSphere` bobbing beside it; an `arrow` riding a
 *   sine path and pointing along it; a `path(...)` from a static array (the same sine, sampled
 *   once); a `circle` under the sphere.
 * - `?still` parks the motion for specs that read pixels (E-017).
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { createDebugDraw } from '@thunderclap-engine/engine/fx';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Renderer,
  Transform,
} from '@thunderclap-engine/engine/render';
import type { HarnessDebugApi, HarnessDebugState } from './debug-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const still = new URLSearchParams(location.search).has('still');

const state: HarnessDebugState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  segments: 0,
  uploads: 0,
  capacity: 0,
  shapes: true,
  spinning: !still,
  probes: { axis: { x: 0, y: 0 } },
  gpuErrors: 0,
};

/** The clear colour behind everything (linear). */
const CLEAR = [0.03, 0.035, 0.06] as const;
const EYE = [6, 4.5, 8] as const;
const TARGET = [0, 0.8, 0] as const;
const AXES_SIZE = 3;
/** On the +x axis, between the grid lines at x = 1.5 and 2.5. */
const AXIS_PROBE = [2, 0, 0] as const;
const GRID_CENTER = [0.5, 0, 0.5] as const;
const GRID = 0x5a6070ff;
const BOX_CENTER = [-2.5, 1, 0] as const;
const BOX_HALF = [0.8, 0.5, 0.6] as const;
const SPHERE_CENTER = [2.5, 1.2, -1] as const;
const SPHERE_RADIUS = 0.8;
const SINE_FROM = -3;
const SINE_TO = 3;
const SINE_Z = 2.5;
const SINE_AMP = 0.6;
const SINE_FREQ = 1.6;
const PATH_POINTS = 48;
const ARROW_PER_S = 0.5;

function sineY(x: number): number {
  return 1 + SINE_AMP * Math.sin(x * SINE_FREQ);
}

/** The static polyline the `path` call reads: x, y, z per point along the sine. */
const sinePath = new Float32Array(PATH_POINTS * 3);
for (let i = 0; i < PATH_POINTS; i++) {
  const x = SINE_FROM + ((SINE_TO - SINE_FROM) * i) / (PATH_POINTS - 1);
  sinePath[i * 3] = x;
  sinePath[i * 3 + 1] = sineY(x);
  sinePath[i * 3 + 2] = SINE_Z;
}

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const arrowFrom = [0, 0, SINE_Z];
const arrowTo = [0, 0, SINE_Z];
const sphereAt: number[] = [SPHERE_CENTER[0], SPHERE_CENTER[1], SPHERE_CENTER[2]];

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine debug-draw demo' });
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

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt(EYE, TARGET);
  renderer.camera = camera;

  const debug = createDebugDraw(renderer, { label: 'harness-debug' });
  const origin = new Transform();
  const boxT = new Transform({ x: BOX_CENTER[0], y: BOX_CENTER[1], z: BOX_CENTER[2] });

  const api: HarnessDebugApi = {
    state,
    setShapes(on) {
      state.shapes = on;
    },
    setSpinning(on) {
      state.spinning = on;
    },
    clear() {
      debug.clear();
    },
  };
  window.__harnessDebug = api;

  let time = 0;
  const loop = new GameLoop({
    update(dt) {
      if (state.spinning) time += dt;
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      if (state.shapes) {
        debug.grid(GRID_CENTER, 10, 1, GRID);
        debug.axes(origin, AXES_SIZE);
        boxT.setAxisAngle(0.3, 1, 0.2, time * 0.9);
        debug.box(boxT.position, BOX_HALF, 0xffb020ff, boxT.quaternion);
        debug.axes(boxT, 0.6);
        sphereAt[1] = SPHERE_CENTER[1] + 0.3 * Math.sin(time * 1.7);
        debug.wireSphere(sphereAt, SPHERE_RADIUS, 0x40c0ffff);
        debug.circle(
          [SPHERE_CENTER[0], 0.01, SPHERE_CENTER[2]],
          [0, 1, 0],
          SPHERE_RADIUS,
          0x40c0ff80,
        );
        debug.path(sinePath, 0xc0ffc0ff);
        // The arrow slides along the sine and points along its tangent.
        const u = (Math.sin(time * ARROW_PER_S) + 1) / 2;
        const x = SINE_FROM + (SINE_TO - SINE_FROM) * u;
        arrowFrom[0] = x;
        arrowFrom[1] = sineY(x);
        const dx = 0.8;
        arrowTo[0] = x + dx;
        arrowTo[1] = sineY(x) + dx * SINE_AMP * SINE_FREQ * Math.cos(x * SINE_FREQ);
        debug.arrow(arrowFrom, arrowTo, 0xff60a0ff, 0.25);
        debug.ray([0, 2.5, 0], [0, -1, 0], 2.5, 0xffffff60);
      }
      state.segments = debug.count;
      frame.drawable(debug);
      renderer.endFrame();
      state.frames++;
      state.uploads = debug.uploads;
      state.capacity = debug.capacity;
      state.gpuErrors = gpuDiagnostics.errorCount;
      camera.worldToScreen(AXIS_PROBE[0], AXIS_PROBE[1], AXIS_PROBE[2], probePoint);
      state.probes.axis.x = probePoint.x;
      state.probes.axis.y = probePoint.y;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
