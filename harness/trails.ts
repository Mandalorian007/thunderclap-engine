/**
 * Trails demo page: two ribbon trails (`Trail`) under a perspective camera over the clear
 * colour. Nothing here is engine code: the motion is what a game would write.
 *
 * - Arm: a point swinging on a fixed-length arm, pushed every update into a world-space,
 *   camera-facing additive trail with a width curve (fat at the tip, thin at the tail).
 *   e2e/trails.spec.ts samples the ribbon's middle point (`probes.arm`).
 * - Orbit: a point circling the arm's pivot while bobbing, pushed into a flat (`facing: 'up'`)
 *   alpha-blended trail with a colour curve that cools toward the tail.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { Trail } from '@thunderclap/engine/fx';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Renderer,
} from '@thunderclap/engine/render';
import type { HarnessTrailsApi, HarnessTrailsState } from './trails-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessTrailsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  counts: { arm: 0, orbit: 0 },
  swinging: true,
  trails: true,
  probes: { arm: { x: 0, y: 0 } },
  gpuErrors: 0,
};

/** The clear colour behind everything (linear). */
const CLEAR = [0.03, 0.035, 0.06] as const;
const EYE = [0, 4.2, 10.5] as const;
const TARGET = [0, 1.4, 0] as const;
const PIVOT = [0, 3.6, 0] as const;
const ARM_LENGTH = 2.4;
const ARM_RAD_PER_S = 2.2;
const ARM_SWING = 1.15;
const ORBIT_RADIUS = 3.1;
const ORBIT_RAD_PER_S = 1.5;
const ORBIT_Y = 0.35;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const mid = { x: 0, y: 0, z: 0 };

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine trails demo' });
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

  const arm = new Trail(renderer, {
    space: 'world',
    maxPoints: 128,
    widthCurve: [0.42, 0.3, 0.08],
    color: [1.0, 0.55, 0.18, 1],
    lifetime: 0.65,
    minDistance: 0.03,
    facing: 'camera',
    blend: 'additive',
    label: 'arm-trail',
  });
  const orbit = new Trail(renderer, {
    space: 'world',
    maxPoints: 160,
    width: 0.55,
    colorCurve: [0.35, 0.8, 1.0, 0.9, 0.2, 0.3, 0.9, 0.0],
    fade: null,
    lifetime: 1.4,
    minDistance: 0.03,
    facing: 'up',
    blend: 'alpha',
    softness: 0.8,
    label: 'orbit-trail',
  });

  const api: HarnessTrailsApi = {
    state,
    setSwinging(on) {
      state.swinging = on;
    },
    setTrails(visible) {
      state.trails = visible;
    },
    clear() {
      arm.clear();
      orbit.clear();
    },
  };
  window.__harnessTrails = api;

  let time = 0;
  const loop = new GameLoop({
    update(dt) {
      if (state.swinging) {
        time += dt;
        const a = Math.sin(time * ARM_RAD_PER_S) * ARM_SWING;
        arm.push(
          PIVOT[0] + Math.sin(a) * ARM_LENGTH,
          PIVOT[1] - Math.cos(a) * ARM_LENGTH,
          PIVOT[2],
        );
        const o = time * ORBIT_RAD_PER_S;
        orbit.push(
          Math.cos(o) * ORBIT_RADIUS,
          ORBIT_Y + 0.3 * Math.sin(time * 2.7),
          Math.sin(o) * ORBIT_RADIUS,
        );
      }
      arm.update(dt, camera);
      orbit.update(dt, camera);
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      if (state.trails) {
        orbit.draw(frame);
        arm.draw(frame);
      }
      renderer.endFrame();
      state.frames++;
      state.counts.arm = arm.count;
      state.counts.orbit = orbit.count;
      state.gpuErrors = gpuDiagnostics.errorCount;
      if (arm.pointAt(Math.floor(arm.count / 2), mid)) {
        camera.worldToScreen(mid.x, mid.y, mid.z, probePoint);
        state.probes.arm.x = probePoint.x;
        state.probes.arm.y = probePoint.y;
      }
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
