/**
 * Water demo page (STATUS "Water surface", ws/water): a pool of `Water` in a basin of `geom`
 * boxes with a sloped ramp running into it, a `Sky` behind, the sun drifting slowly. Noun-free,
 * and nothing here is engine code.
 *
 * - The opaque scene (basin, ramp, sky) renders in a first view of the camera on layer 1; the
 *   water renders in a second view of the same camera on layer 2, so its depth copy (taken in
 *   `prepare`, before that view's pass) holds this frame's opaque depth and the depth fade,
 *   shoreline alpha and foam line up with the ramp. One view would show the previous frame's
 *   depth with the water itself in it (deep everywhere; see the fx README).
 * - `?hook=1` (ws/render-hooks): one view of every layer with `water.readsDepth`; the renderer
 *   splits the scene pass at the water, copies the opaque depth and hands it to the water the
 *   same frame (`stats.passes` is 2). Default stays the two-view path.
 * - The sun circles slowly around the direction whose reflection lands on the specular probe;
 *   `?still` parks it there (E-017).
 * - State on `window.__harnessWater` (harness/water-state.ts): the wave clock, the height at a
 *   fixed point and four probe pixels e2e/water.spec.ts samples.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { Sky, Water, waterHeight } from '@thunderclap-engine/engine/fx';
import { box } from '@thunderclap-engine/engine/geom';
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
} from '@thunderclap-engine/engine/render';
import { type HarnessWaterApi, type HarnessWaterState, HEIGHT_X, HEIGHT_Z } from './water-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const STILL = query.has('still');
const HOOK = query.get('hook') === '1';

const state: HarnessWaterState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  still: STILL,
  depthHook: HOOK,
  t: 0,
  height: 0,
  probes: {
    shorelinePixel: { x: 0, y: 0 },
    deepPixel: { x: 0, y: 0 },
    foamPixel: { x: 0, y: 0 },
    specularPixel: { x: 0, y: 0 },
  },
  stats: { drawCalls: 0, drawables: 0, passes: 0 },
  gpuErrors: 0,
};

const api: HarnessWaterApi = { state };
window.__harnessWater = api;

// ------------------------------------------------------------------ the material

/** Albedo × the lighting block plus a little sky light, then fog. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  let lit = in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky);
  o.color = vec4f(engine_fog(lit, in.worldPos), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the scene

const EYE = [0, 4.5, 12] as const;
const TARGET = [0, -0.5, 0] as const;
/** Basin interior: 16 × 16 world units, floor 3 units under the water. */
const BASIN = 16;
const WALL = 0.5;
const FLOOR_Y = -3;
const WALL_TOP = 1.5;
/** The ramp: a slab tilted about x so it descends towards the camera (+z). */
const RAMP_X = 2.5;
const RAMP_W = 3;
const RAMP_T = 0.5;
const RAMP_L = 10;
const RAMP_ANGLE = (18 * Math.PI) / 180;
/** The ramp's centre height, chosen so its top surface crosses the water at z ≈ 0.5. */
const RAMP_Y = 0.445 * Math.sin(RAMP_ANGLE) - (RAMP_T / 2) * Math.cos(RAMP_ANGLE);
/** Local z along the ramp's top surface where it meets the water (y = 0). */
const RAMP_WATERLINE = (RAMP_Y + (RAMP_T / 2) * Math.cos(RAMP_ANGLE)) / Math.sin(RAMP_ANGLE);

const FOAM_DEPTH = 0.04;
const SHORELINE_DEPTH = 1.0;
const DEEP_POINT = [-3, 0, 2] as const;
/** Where the sun's reflection lands with `?still`: the mirror point of the eye through it. */
const SPECULAR_POINT = [-1, 0, -2] as const;

const SUN_COLOR = [1.0, 0.92, 0.8] as const;
const AMBIENT = [0.22, 0.24, 0.3] as const;
const FOG_COLOR = [0.6, 0.66, 0.78] as const;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const sunDir = new Float32Array(3);
const toSun = new Float32Array(3);
const rampPoint = new Float32Array(3);
const surfacePoint = new Float32Array(3);

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/** A point on the ramp's top surface, `w` along its local z, into `out` (world). */
function rampSurface(ramp: Transform, w: number, out: Float32Array): void {
  const m = ramp.world;
  const ly = RAMP_T / 2;
  out[0] = m[0]! * 0 + m[1]! * ly + m[2]! * w + m[3]!;
  out[1] = m[4]! * 0 + m[5]! * ly + m[6]! * w + m[7]!;
  out[2] = m[8]! * 0 + m[9]! * ly + m[10]! * w + m[11]!;
}

/** Where the ray from the eye to `p` (under water) crosses the surface y = 0, into `out`. */
function surfaceAbove(p: Float32Array, out: Float32Array): void {
  const k = EYE[1] / (EYE[1] - p[1]!);
  out[0] = EYE[0] + (p[0]! - EYE[0]) * k;
  out[1] = 0;
  out[2] = EYE[2] + (p[2]! - EYE[2]) * k;
}

/** The sun direction (the way light travels) whose reflection off y = 0 reaches the eye from `p`. */
function sunFor(px: number, pz: number, azimuth: number): void {
  // Mirror the eye below the surface: the reflected ray from the eye through p continues to it.
  let x = px - EYE[0];
  let z = pz - EYE[2];
  const c = Math.cos(azimuth);
  const s = Math.sin(azimuth);
  const rx = x * c - z * s;
  const rz = x * s + z * c;
  x = rx;
  z = rz;
  const y = EYE[1];
  const k = 1 / Math.hypot(x, y, z);
  toSun[0] = x * k;
  toSun[1] = y * k;
  toSun[2] = z * k;
  sunDir[0] = -toSun[0]!;
  sunDir[1] = -toSun[1]!;
  sunDir[2] = -toSun[2]!;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine water demo' });
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

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt(EYE, TARGET);
  renderer.camera = camera;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const floor = renderer.createMesh(box({ size: [BASIN + 2 * WALL, WALL, BASIN + 2 * WALL] }));
  const sideWall = renderer.createMesh(box({ size: [WALL, WALL_TOP - FLOOR_Y + WALL, BASIN] }));
  const backWall = renderer.createMesh(
    box({ size: [BASIN + 2 * WALL, WALL_TOP - FLOOR_Y + WALL, WALL] }),
  );
  const rampMesh = renderer.createMesh(box({ size: [RAMP_W, RAMP_T, RAMP_L] }));

  const wallY = (WALL_TOP + FLOOR_Y - WALL) / 2;
  const floorT = new Transform({ y: FLOOR_Y - WALL / 2 });
  const leftT = new Transform({ x: -(BASIN + WALL) / 2, y: wallY });
  const rightT = new Transform({ x: (BASIN + WALL) / 2, y: wallY });
  const backT = new Transform({ y: wallY, z: -(BASIN + WALL) / 2 });
  const rampT = new Transform({ x: RAMP_X, y: RAMP_Y, z: 0 });
  rampT.setAxisAngle(1, 0, 0, RAMP_ANGLE);
  const floorP: InstanceParams = { tint: [0.34, 0.32, 0.29, 1] };
  const wallP: InstanceParams = { tint: [0.42, 0.42, 0.45, 1] };
  const rampP: InstanceParams = { tint: [0.6, 0.54, 0.42, 1] };

  const sky = new Sky(renderer, { stars: true });
  const water = new Water(renderer, {
    size: BASIN,
    segments: 48,
    displace: 0.05,
    roughness: 0.18,
    foam: { width: 0.4 },
    readsDepth: HOOK,
  });

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.color = SUN_COLOR;
  lights.fog.color = FOG_COLOR;
  lights.fog.density = 1;
  lights.fog.near = 25;
  lights.fog.far = 90;

  let clock = 0;
  const specular = { x: SPECULAR_POINT[0] as number, z: SPECULAR_POINT[2] as number };

  function placeSun(): void {
    // The sun drifts ±0.35 rad around the parked direction over a 20 s cycle.
    const azimuth = STILL ? 0 : 0.35 * Math.sin((2 * Math.PI * clock) / 20);
    sunFor(SPECULAR_POINT[0], SPECULAR_POINT[2], azimuth);
    lights.sun.direction = sunDir;
    // The mirror point on the surface for this sun: eye + (eye.y / toSun.y) * toSun.xz.
    const k = EYE[1] / toSun[1]!;
    specular.x = EYE[0] + toSun[0]! * k;
    specular.z = EYE[2] + toSun[2]! * k;
  }

  const loop = new GameLoop({
    update(dt) {
      if (!STILL) clock += dt;
      water.update(dt);
      placeSun();
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0, 0, 0);
      frame.lights = lights;
      frame.drawable(sky, -1);
      frame.mesh(floor, lit, floorT, floorP);
      frame.mesh(sideWall, lit, leftT, wallP);
      frame.mesh(sideWall, lit, rightT, wallP);
      frame.mesh(backWall, lit, backT, wallP);
      frame.mesh(rampMesh, lit, rampT, rampP);
      frame.drawable(water, 1, 2);
      if (HOOK) {
        // One view: the renderer splits its pass at the water and hands it this frame's depth.
        camera.layers = 3;
        renderer.render(frame, camera);
      } else {
        // Opaque scene first, then the water in a second view of the same camera, so the water's
        // depth copy holds this frame's geometry.
        camera.layers = 1;
        renderer.render(frame, camera);
        camera.layers = 2;
        renderer.render(frame, camera);
      }
      renderer.endFrame();

      state.frames++;
      state.t = water.time;
      state.height = waterHeight(water, HEIGHT_X, HEIGHT_Z);
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.drawables = renderer.stats.drawables;
      state.stats.passes = renderer.stats.passes;
      state.gpuErrors = gpuDiagnostics.errorCount;

      rampSurface(rampT, RAMP_WATERLINE + FOAM_DEPTH / Math.sin(RAMP_ANGLE), rampPoint);
      surfaceAbove(rampPoint, surfacePoint);
      probe(camera, surfacePoint[0]!, 0, surfacePoint[2]!, state.probes.foamPixel);
      rampSurface(rampT, RAMP_WATERLINE + SHORELINE_DEPTH / Math.sin(RAMP_ANGLE), rampPoint);
      surfaceAbove(rampPoint, surfacePoint);
      probe(camera, surfacePoint[0]!, 0, surfacePoint[2]!, state.probes.shorelinePixel);
      probe(camera, DEEP_POINT[0], DEEP_POINT[1], DEEP_POINT[2], state.probes.deepPixel);
      probe(camera, specular.x, 0, specular.z, state.probes.specularPixel);
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
