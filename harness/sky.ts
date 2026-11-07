/**
 * Sky demo page (STATUS "Sky", ws/sky): the mesh page's ground and two blocks under a `Sky`
 * drawable from `@thunderclap-engine/engine/fx`. Noun-free, and nothing here is engine code.
 *
 * - `Sky` draws one fullscreen triangle at the far plane with depth test on and depth write
 *   off, so it fills wherever the ground and blocks did not write depth, whatever the order.
 * - The sun (`lights.sun`) arcs through a 40 s day: up to 25° at noon, below the horizon for
 *   the night half, warming towards the horizon. The disc and glow follow it; at night the
 *   dome darkens and the stars come out. `?still` parks it at noon (E-017).
 * - Fog is on (`lights.fog`): the distant ground fades to the fog colour and the sky's
 *   horizon haze meets it.
 * - State on `window.__harnessSky` (harness/sky-state.ts): the sun's elevation and four probe
 *   points e2e/sky.spec.ts samples.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { Sky } from '@thunderclap-engine/engine/fx';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessSkyApi, HarnessSkyState } from './sky-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const STILL = query.has('still');

const state: HarnessSkyState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  still: STILL,
  sunElevation: 0,
  probes: {
    zenith: { x: 0, y: 0 },
    horizon: { x: 0, y: 0 },
    sunDisc: { x: 0, y: 0 },
    ground: { x: 0, y: 0 },
  },
  stats: { drawCalls: 0, drawables: 0 },
  gpuErrors: 0,
};

const api: HarnessSkyApi = { state };
window.__harnessSky = api;

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
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
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

// ------------------------------------------------------------------ the material

/** Albedo × the lighting block, then fog; `params.x` > 0 draws a checker from the world position. */
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
  let lit = albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky);
  o.color = vec4f(engine_fog(lit, in.worldPos), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the day

/** One day in seconds; the sun peaks at `NOON_ELEVATION` a quarter of the way through. */
const DAY_SECONDS = 40;
const NOON_ELEVATION = (25 * Math.PI) / 180;
const SUN_NOON = [0.95, 0.92, 0.85] as const;
const SUN_LOW = [1.0, 0.55, 0.3] as const;
const AMBIENT_DAY = [0.22, 0.24, 0.3] as const;
const AMBIENT_NIGHT = [0.03, 0.035, 0.05] as const;
const SHADOW_EXTENT = 20;
const SHADOW_SIZE = 2048;
const FOG_COLOR = [0.6, 0.65, 0.75] as const;
const FOG_NEAR = 6;
const FOG_FAR = 24;

const EYE = [0, 1.6, 9] as const;
const TARGET = [0, 3, 0] as const;
/** A far point along a direction, for the sky probes. */
const FAR = 1000;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const sunDir = new Float32Array(3);
const sunColor = new Float32Array(3);
const ambient = new Float32Array(3);

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/** A sky probe: the pixel looking from the eye at `azimuth` (radians, 0 = -z) and `elevation`. */
function skyProbe(
  camera: Camera,
  azimuth: number,
  elevation: number,
  out: { x: number; y: number },
) {
  const c = Math.cos(elevation);
  probe(
    camera,
    EYE[0] + FAR * Math.sin(azimuth) * c,
    EYE[1] + FAR * Math.sin(elevation),
    EYE[2] - FAR * Math.cos(azimuth) * c,
    out,
  );
}

function mix3(out: Float32Array, a: readonly number[], b: readonly number[], t: number): void {
  out[0] = a[0]! + (b[0]! - a[0]!) * t;
  out[1] = a[1]! + (b[1]! - a[1]!) * t;
  out[2] = a[2]! + (b[2]! - a[2]!) * t;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine sky demo' });
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
  const sky = new Sky(renderer, { stars: true });

  const groundT = new Transform({ scaleX: 80, scaleY: 1, scaleZ: 80 });
  const left = new Transform({ x: -2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const right = new Transform({ x: 2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const groundP: InstanceParams = { tint: [0.38, 0.5, 0.3, 1], params: [1, 0, 0, 0] };
  const leftP: InstanceParams = { tint: [1.0, 0.1, 0.06, 1] };
  const rightP: InstanceParams = { tint: [0.08, 0.28, 1.0, 1] };

  const lights = new Lights();
  lights.sun.shadow = { extent: SHADOW_EXTENT, size: SHADOW_SIZE };
  lights.fog.color = FOG_COLOR;
  lights.fog.density = 1;
  lights.fog.near = FOG_NEAR;
  lights.fog.far = FOG_FAR;

  // Noon is a quarter of the way through the day; `?still` stays there.
  let clock = DAY_SECONDS / 4;

  function placeSun(): void {
    const elevation = NOON_ELEVATION * Math.sin((2 * Math.PI * clock) / DAY_SECONDS);
    state.sunElevation = elevation;
    // The sun sits towards -z; `sun.dir` is the direction its light travels.
    sunDir[0] = 0;
    sunDir[1] = -Math.sin(elevation);
    sunDir[2] = Math.cos(elevation);
    const high = smooth(0, NOON_ELEVATION * 0.6, elevation);
    mix3(sunColor, SUN_LOW, SUN_NOON, high);
    mix3(ambient, AMBIENT_NIGHT, AMBIENT_DAY, smooth(-0.1, 0.1, elevation));
    lights.sun.direction = sunDir;
    lights.sun.color = sunColor;
    lights.ambient.set(ambient);
  }

  const loop = new GameLoop({
    update(dt) {
      if (!STILL) clock += dt;
      placeSun();
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0, 0, 0);
      frame.lights = lights;
      frame.drawable(sky);
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, left, leftP);
      frame.mesh(cube, lit, right, rightP);
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.drawables = renderer.stats.drawables;
      state.gpuErrors = gpuDiagnostics.errorCount;
      skyProbe(camera, -0.5, 0.5, state.probes.zenith);
      skyProbe(camera, 0.5, 0.03, state.probes.horizon);
      probe(
        camera,
        EYE[0] - FAR * sunDir[0]!,
        EYE[1] - FAR * sunDir[1]!,
        EYE[2] - FAR * sunDir[2]!,
        state.probes.sunDisc,
      );
      probe(camera, 0, 0, 0.5, state.probes.ground);
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
