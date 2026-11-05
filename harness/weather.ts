/**
 * Weather demo page: world-space particles (`ParticleSystem` with `space: 'world'`) over the
 * mesh page's cube field under a perspective camera. Noun-free, and nothing here is engine
 * code: the emitters, the geometry and the lights are what a game would write.
 *
 * - Rain: one unlit, additive system, streaked along its velocity (`stretch`), falling over the
 *   whole field with a little wind, plus a dense narrow column against the sky that
 *   e2e/weather.spec.ts samples (`probes.rain`).
 * - Snow and dust: one lit, alpha-blended system (`lit: true`): slow flakes drifting over the
 *   field and dust motes hanging around the warm point light, lit through `engine_lambert`.
 *   Both fade with distance (`fade`) and soften where they meet the ground (`softness`).
 * - Both count their live particles on the GPU (`countAlive`) into `state.alive`.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { ParticleEmitter, ParticleSystem } from '@thunderclap/engine/fx';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type PointLight,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import type { HarnessWeatherApi, HarnessWeatherState } from './weather-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessWeatherState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  alive: { rain: -1, motes: -1 },
  particles: true,
  probes: { rain: { x: 0, y: 0 } },
  gpuErrors: 0,
};

const api: HarnessWeatherApi = {
  state,
  setParticles(visible) {
    state.particles = visible;
  },
};
window.__harnessWeather = api;

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

/** Albedo × the engine lighting block, a faint sky term, and a checker on the ground. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the scene

/** The clear sky behind everything (linear). */
const SKY = [0.05, 0.07, 0.12] as const;
const TARGET = [0, 0.9, 0] as const;
const EYE = [0, 3.3, 11.8] as const;
const LAMP_COLOR = [1.6, 0.9, 0.4] as const;
const LAMP_RADIUS = 5;
const LAMP_ORBIT = 3.2;
const LAMP_HEIGHT = 1.6;
const LAMP_RAD_PER_S = 0.5;
/** The dense rain column: falls from `COLUMN.y` to the ground at (x, z), against the sky. */
const COLUMN = { x: -3, y: 7.5, z: -6, probeY: 4.5 } as const;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine weather demo' });
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

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });
  const groundT = new Transform({ scaleX: 16, scaleY: 1, scaleZ: 16 });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const blocks: [Transform, InstanceParams][] = [
    [new Transform({ x: 0, y: 0.5, z: 1.5 }), { tint: [1.0, 0.1, 0.06, 1] }],
    [
      new Transform({ x: 0, y: 1.5, z: -0.5, scaleX: 2, scaleY: 3, scaleZ: 1 }),
      { tint: [0.08, 0.28, 1.0, 1] },
    ],
    [
      new Transform({ x: -3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
      { tint: [0.3, 0.85, 0.35, 1] },
    ],
    [
      new Transform({ x: 3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
      { tint: [0.95, 0.8, 0.2, 1] },
    ],
  ];

  const lights = new Lights();
  lights.ambient.set([0.12, 0.12, 0.15]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.45, 0.47, 0.52];
  const lampPos = new Float32Array(3);
  const lamp: PointLight = { position: lampPos, color: LAMP_COLOR, radius: LAMP_RADIUS };
  lights.points.push(lamp);

  // Rain: unlit, additive, streaked; the ground stops it.
  const rain = new ParticleSystem(renderer, {
    space: 'world',
    capacity: 8192,
    floorY: 0,
    bounce: 0,
    stretch: 0.012,
    countAlive: true,
  });
  const rainColor = [0.5, 0.6, 0.8, 0.7] as const;
  const field = new ParticleEmitter(
    rain,
    {
      x: 0,
      y: 9,
      z: -2,
      shape: { kind: 'box', width: 18, height: 1, depth: 18 },
      angle: -Math.PI / 2,
      spread: 0.05,
      speed: [7, 9],
      life: [1.1, 1.4],
      size: [0.03, 0.03],
      colorStart: rainColor,
      gravity: [0, -9.8, 0],
      wind: [1.5, -9, 0],
      drag: 0.4,
      emissive: 0,
    },
    2500,
  );
  const column = new ParticleEmitter(
    rain,
    {
      x: COLUMN.x,
      y: COLUMN.y,
      z: COLUMN.z,
      shape: { kind: 'box', width: 0.35, height: 0.5, depth: 0.35 },
      angle: -Math.PI / 2,
      spread: 0.02,
      speed: [9, 11],
      life: [0.75, 0.85],
      size: [0.12, 0.12],
      colorStart: [0.8, 0.9, 1.2, 1],
      gravity: [0, -9.8, 0],
      drag: 0,
      emissive: 0.2,
    },
    3000,
  );

  // Snow and dust: lit, alpha-blended, faded with distance, soft against the ground.
  const motes = new ParticleSystem(renderer, {
    space: 'world',
    capacity: 4096,
    blend: 'alpha',
    lit: true,
    fade: { near: 14, far: 24 },
    softness: 0.3,
    stretch: 0,
    countAlive: true,
  });
  const snow = new ParticleEmitter(
    motes,
    {
      x: 2,
      y: 7,
      z: -1,
      shape: { kind: 'box', width: 12, height: 1, depth: 12 },
      speed: [0, 0.3],
      life: [5, 7],
      size: [0.09, 0.07],
      colorStart: [1, 1, 1, 0.9],
      colorEnd: [1, 1, 1, 0.6],
      gravity: [0, -0.6, 0],
      wind: [0.4, -1.1, 0.1],
      drag: 1.5,
      emissive: 0,
    },
    300,
  );
  const dust = new ParticleEmitter(
    motes,
    {
      x: TARGET[0],
      y: LAMP_HEIGHT,
      z: TARGET[2],
      shape: { kind: 'sphere', radius: LAMP_ORBIT + 0.8 },
      speed: [0.02, 0.15],
      life: [3, 5],
      size: [0.04, 0.04],
      colorStart: [0.9, 0.85, 0.75, 0],
      colorEnd: [0.9, 0.85, 0.75, 0.8],
      gravity: [0, 0, 0],
      drag: 0.5,
      emissive: 0.05,
    },
    200,
  );
  const emitters = [field, column, snow, dust];

  let time = 0;
  const loop = new GameLoop({
    update(dt) {
      time += dt;
      // Hidden systems are not prepared, so nothing would consume their emits.
      if (state.particles) for (const e of emitters) e.update(dt);
      rain.update(dt);
      motes.update(dt);
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(SKY[0], SKY[1], SKY[2]);
      frame.lights = lights;
      lampPos[0] = TARGET[0] + LAMP_ORBIT * Math.cos(time * LAMP_RAD_PER_S);
      lampPos[1] = LAMP_HEIGHT;
      lampPos[2] = TARGET[2] + LAMP_ORBIT * Math.sin(time * LAMP_RAD_PER_S);
      frame.mesh(ground, lit, groundT, groundP);
      for (const [tr, p] of blocks) frame.mesh(cube, lit, tr, p);
      if (state.particles) {
        frame.drawable(motes, 1);
        frame.drawable(rain, 2);
      }
      renderer.endFrame();
      state.frames++;
      state.alive.rain = rain.alive;
      state.alive.motes = motes.alive;
      state.gpuErrors = gpuDiagnostics.errorCount;
      camera.worldToScreen(COLUMN.x, COLUMN.probeY, COLUMN.z, probePoint);
      state.probes.rain.x = probePoint.x;
      state.probes.rain.y = probePoint.y;
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
