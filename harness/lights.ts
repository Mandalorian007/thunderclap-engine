/**
 * Lights demo page (ws/spot-lights): spot lights and per-light layer masks from the engine's
 * lighting block, on the raw renderer. Noun-free, and nothing here is engine code: the
 * geometry and the material are what a game would write.
 *
 * - A ground plane and two identical cubes on different layers (`InstanceParams.layers` 1 and
 *   2). A point light masked to layer 1 (`PointLight.layers`) lights the ground and the left
 *   cube and skips the right one, so the right cube shows only the ambient.
 * - A `SpotLight` above the ground sweeps its aim point round a circle. The material reads the
 *   block through `engine_lambert_layers(n, p, engine_instance_layers(in.flags))`, so both the
 *   cone and the masks come from the prelude.
 * - e2e/lights.spec.ts samples the ground under the spot against ground outside the cone, and
 *   the lit cube against the masked one; `setSweep(false)` holds the spot still for the sample.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type PointLight,
  Renderer,
  type SpotLight,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import { createPerfMonitor, createPerfOverlay } from '@thunderclap-engine/engine/ui';
import type { HarnessLightsApi, HarnessLightsState } from './lights-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

/** The two cubes' layer masks: the point light is masked to `LIT_LAYER`. */
const LIT_LAYER = 1;
const MASKED_LAYER = 2;

const state: HarnessLightsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  probes: {
    spotIn: { x: 0, y: 0 },
    spotOut: { x: 0, y: 0 },
    litCube: { x: 0, y: 0 },
    maskedCube: { x: 0, y: 0 },
  },
  spotAim: [0, 0, 0],
  sweeping: true,
  lights: { points: 0, spots: 0, lampLayers: 0, cubeLayers: [LIT_LAYER, MASKED_LAYER] },
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
  perf: null,
};

const api: HarnessLightsApi = {
  state,
  setSweep(on) {
    state.sweeping = on;
  },
};
window.__harnessLights = api;

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  // Each face: normal, then the tangent pair that spans it (right, up).
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const [n, r, u] of faces) {
    const base = v / 12;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (n[k]! + sx * r[k]! + sy * u[k]!) * 0.5;
      vertices[v + 3] = n[0]!;
      vertices[v + 4] = n[1]!;
      vertices[v + 5] = n[2]!;
      vertices[v + 6] = (sx + 1) / 2;
      vertices[v + 7] = (1 - sy) / 2;
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += 12;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
    i += 6;
  }
  return { vertices, indices };
}

/** A unit quad in the XZ plane (y = 0) facing +y, white. */
function groundGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  // x, y, z, nx, ny, nz, u, v, r, g, b, a
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

// ------------------------------------------------------------------ the material

/**
 * Albedo × the engine lighting block against this instance's layers: ambient + the sun, point
 * and spot lights whose `layers` share a bit with the instance's (`engine_instance_layers`).
 */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let light = engine_lambert_layers(n, in.worldPos, engine_instance_layers(in.flags));
  var o: FragOut;
  o.color = vec4f(in.color.rgb * light, 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** Low ambient, no sun: the point light and the spot are the only lights. */
const AMBIENT = [0.08, 0.08, 0.1] as const;
/** The masked lamp: above the gap between the cubes, reaching only `LIT_LAYER`. */
const LAMP_POS = [0, 3, -1] as const;
const LAMP_COLOR = [2.4, 2.0, 1.5] as const;
const LAMP_RADIUS = 7;
/** The spot: high over the front of the ground, aiming round a circle on it. */
const SPOT_POS = [0, 5, 3.5] as const;
const SPOT_COLOR = [3.0, 2.6, 1.8] as const;
const SPOT_RADIUS = 12;
const SPOT_INNER = 0.18;
const SPOT_OUTER = 0.3;
const SWEEP_CENTER = [0, 0, 3.5] as const;
const SWEEP_RADIUS = 2.2;
const SWEEP_RAD_PER_S = 0.5;

// ------------------------------------------------------------------ the scene

const EYE = [0, 7, 11] as const;
const TARGET = [0, 0.5, 0] as const;
const CUBE_X = 2.5;
const CUBE_Z = -1;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine lights demo' });
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
  renderer.camera = camera;
  camera.lookAt(EYE, TARGET);

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });

  const groundT = new Transform({ scaleX: 20, scaleY: 1, scaleZ: 20 });
  const litT = new Transform({ x: -CUBE_X, y: 0.5, z: CUBE_Z });
  const maskedT = new Transform({ x: CUBE_X, y: 0.5, z: CUBE_Z });
  const groundP: InstanceParams = { tint: [0.5, 0.5, 0.5, 1], layers: LIT_LAYER };
  const litP: InstanceParams = { tint: [0.85, 0.85, 0.85, 1], layers: LIT_LAYER };
  const maskedP: InstanceParams = { tint: [0.85, 0.85, 0.85, 1], layers: MASKED_LAYER };

  // The lights: set once, mutated per frame (the spot's direction), uploaded by the renderer.
  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.color = [0, 0, 0];
  const lamp: PointLight = {
    position: LAMP_POS,
    color: LAMP_COLOR,
    radius: LAMP_RADIUS,
    layers: LIT_LAYER,
  };
  lights.points.push(lamp);
  const spotDir = new Float32Array(3);
  const spot: SpotLight = {
    position: SPOT_POS,
    direction: spotDir,
    color: SPOT_COLOR,
    radius: SPOT_RADIUS,
    innerAngle: SPOT_INNER,
    outerAngle: SPOT_OUTER,
  };
  lights.spots.push(spot);

  let sweep = 0;
  const aim = state.spotAim;
  // ws/perf-overlay: the frame-cost readout, shown with `?perf` (the monitor always samples).
  const perf = createPerfMonitor();
  const perfHud = new URLSearchParams(location.search).has('perf')
    ? createPerfOverlay(perf, { parent: root })
    : null;

  const loop = new GameLoop({
    update(dt) {
      if (state.sweeping) sweep += dt * SWEEP_RAD_PER_S;
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.03, 0.04, 0.07);
      frame.lights = lights;
      const ax = SWEEP_CENTER[0] + SWEEP_RADIUS * Math.cos(sweep);
      const az = SWEEP_CENTER[2] + SWEEP_RADIUS * Math.sin(sweep);
      aim[0] = ax;
      aim[1] = 0;
      aim[2] = az;
      spotDir[0] = ax - SPOT_POS[0];
      spotDir[1] = -SPOT_POS[1];
      spotDir[2] = az - SPOT_POS[2];
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, litT, litP);
      frame.mesh(cube, lit, maskedT, maskedP);
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      state.perf = perf.sample(renderer);
      perfHud?.update();
      state.lights.points = lights.points.length;
      state.lights.spots = lights.spots.length;
      state.lights.lampLayers = lamp.layers ?? 0;
      probe(camera, ax, 0, az, state.probes.spotIn);
      probe(camera, 2 * SWEEP_CENTER[0] - ax, 0, 2 * SWEEP_CENTER[2] - az, state.probes.spotOut);
      probe(camera, -CUBE_X, 1, CUBE_Z, state.probes.litCube);
      probe(camera, CUBE_X, 1, CUBE_Z, state.probes.maskedCube);
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
