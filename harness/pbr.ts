/**
 * PBR demo page (E-015, ws/pbr): the standard material on the raw renderer. Noun-free, and
 * nothing here is engine code beyond `createStandardMaterial`: the geometry, the lights and the
 * orbit are what a game would write.
 *
 * - A 5×5 grid of spheres, metallic 0..1 across and roughness 0..1 down, drawn through one
 *   standard material: a 5×5 metallic-roughness texture (G roughness, B metallic) that each
 *   sphere samples at its own texel through a collapsed instance `uv` rect, so the whole grid
 *   is one instanced draw with one tint.
 * - A standing tile with a procedural normal map (the bumps of a cosine height field, made on
 *   the GPU with `textureFromShader`) on a flat quad with no tangents: the material builds its
 *   tangent frame from screen-space derivatives.
 * - A ground plane in the same material (rough dielectric), the engine's sun with a shadow map,
 *   fog and one warm point light; the orbit camera of `mesh.html` (drag, pinch, wheel).
 * - Probes for e2e/pbr.spec.ts: the rough dielectric sphere's centre, the specular highlight
 *   on a metal sphere, and the lit and unlit slopes of a bump on the tile.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { Gestures, Input } from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  createStandardMaterial,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type PointLight,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import { createPerfMonitor, createPerfOverlay } from '@thunderclap/engine/ui';
import type { HarnessPbrApi, HarnessPbrState } from './pbr-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const COLS = 5;
const ROWS = 5;

const state: HarnessPbrState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  camera: { yaw: 0, pitch: 0, distance: 0, eye: [0, 0, 0] },
  grid: { cols: COLS, rows: ROWS },
  probes: {
    rough: { x: 0, y: 0 },
    highlight: { x: 0, y: 0 },
    tileLit: { x: 0, y: 0 },
    tileDark: { x: 0, y: 0 },
  },
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
  perf: null,
  lights: { sun: false, points: 0, shadow: false, fog: false },
  materials: 0,
};

const api: HarnessPbrApi = { state };
window.__harnessPbr = api;

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit-radius UV sphere: normals are positions, u around, v from the top, white. */
function sphereGeometry(rings: number, segments: number) {
  const vertices = new Float32Array((rings + 1) * (segments + 1) * 12);
  const indices = new Uint16Array(rings * segments * 6);
  let v = 0;
  for (let r = 0; r <= rings; r++) {
    const theta = (r / rings) * Math.PI;
    const y = Math.cos(theta);
    const s = Math.sin(theta);
    for (let c = 0; c <= segments; c++) {
      const phi = (c / segments) * Math.PI * 2;
      const x = s * Math.sin(phi);
      const z = s * Math.cos(phi);
      vertices[v++] = x;
      vertices[v++] = y;
      vertices[v++] = z;
      vertices[v++] = x;
      vertices[v++] = y;
      vertices[v++] = z;
      vertices[v++] = c / segments;
      vertices[v++] = r / rings;
      vertices[v++] = vertices[v++] = vertices[v++] = vertices[v++] = 1;
    }
  }
  let i = 0;
  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < segments; c++) {
      const a = r * (segments + 1) + c;
      const b = a + segments + 1;
      indices.set([a, b, a + 1, a + 1, b, b + 1], i);
      i += 6;
    }
  }
  return { vertices, indices };
}

/** A unit quad in the XY plane facing +z; u runs +x, v runs down (-y), white. */
function wallGeometry() {
  // x, y, z, nx, ny, nz, u, v, r, g, b, a
  const vertices = new Float32Array([
    ...[-0.5, 0.5, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1],
    ...[0.5, 0.5, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1],
    ...[0.5, -0.5, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1],
    ...[-0.5, -0.5, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 2, 1, 0, 3, 2]) };
}

/** A unit quad in the XZ plane (y = 0) facing +y, white. */
function groundGeometry() {
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

// ------------------------------------------------------------------ textures

/**
 * The tile's normal map: the bumps of `h(u, v) = A cos(2πu) cos(2πv)` (a peak at the centre),
 * as a tangent-space normal with +Y up in the image (so `+v` down is `-Y`), encoded 0..1.
 */
const BUMP_AMPLITUDE = 0.2;
const NORMAL_MAP_WGSL = /* wgsl */ `
const TAU: f32 = 6.28318530718;
fn shade(uv: vec2f) -> vec4f {
  let a = ${BUMP_AMPLITUDE.toFixed(3)};
  let hu = -a * TAU * sin(TAU * uv.x) * cos(TAU * uv.y);
  let hv = -a * TAU * cos(TAU * uv.x) * sin(TAU * uv.y);
  let n = normalize(vec3f(-hu, hv, 1.0));
  return vec4f(n * 0.5 + 0.5, 1.0);
}`;

/** The lights: a sun from up-right-front (the direction it travels) and a warm still lamp. */
const AMBIENT = [0.18, 0.18, 0.2] as const;
const SUN_DIR = [-0.45, -1.0, -0.65] as const;
const SUN_COLOR = [0.8, 0.8, 0.78] as const;
const LAMP_COLOR = [1.4, 0.8, 0.35] as const;
const LAMP_POS = [6.5, 0.9, 3.0] as const;
const LAMP_RADIUS = 6;
const SHADOW_EXTENT = 20;
const SHADOW_SIZE = 2048;
const FOG_COLOR = [0.6, 0.65, 0.75] as const;
const FOG_NEAR = 12;
const FOG_FAR = 40;

// ------------------------------------------------------------------ the scene

const SPHERE_RADIUS = 0.48;
const SPACING = 1.1;
const GRID_CENTRE = [0, 2.9, 0] as const;
const TILE_SIZE = 2.6;
const TILE_CENTRE = [4.3, 2.9, 0] as const;
/** uv offset from the bump's peak at which the slope is probed. */
const PROBE_DELTA = 0.15;
const SPHERE_TINT = [0.55, 0.2, 0.16, 1] as const;

const TARGET = [1.0, 2.9, 0] as const;
const orbit = { yaw: 0, pitch: 0.12, distance: 9.5 };
const ORBIT_PER_PX = 0.005;
const ZOOM_PER_TICK = 0.03;
const PITCH_MIN = -0.6;
const PITCH_MAX = 1.35;
const DISTANCE_MIN = 3;
const DISTANCE_MAX = 30;

const eye = new Float32Array(3);
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

type Action = 'zoomIn' | 'zoomOut';
const bindings = { zoomIn: [{ wheel: -1 }], zoomOut: [{ wheel: 1 }] } as const;

function placeCamera(camera: Camera): void {
  const o = orbit;
  o.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, o.pitch));
  o.distance = Math.min(DISTANCE_MAX, Math.max(DISTANCE_MIN, o.distance));
  const cp = Math.cos(o.pitch);
  eye[0] = TARGET[0] + o.distance * Math.sin(o.yaw) * cp;
  eye[1] = TARGET[1] + o.distance * Math.sin(o.pitch);
  eye[2] = TARGET[2] + o.distance * Math.cos(o.yaw) * cp;
  camera.lookAt(eye, TARGET);
  const c = state.camera;
  c.yaw = o.yaw;
  c.pitch = o.pitch;
  c.distance = o.distance;
  c.eye[0] = eye[0]!;
  c.eye[1] = eye[1]!;
  c.eye[2] = eye[2]!;
}

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/** World centre of the sphere at grid (col, row): metallic across, roughness down. */
function sphereCentre(col: number, row: number): [number, number, number] {
  return [
    GRID_CENTRE[0] + (col - (COLS - 1) / 2) * SPACING,
    GRID_CENTRE[1] + ((ROWS - 1) / 2 - row) * SPACING,
    GRID_CENTRE[2],
  ];
}

const sunToLight = new Float32Array(3);
{
  const len = Math.hypot(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
  sunToLight[0] = -SUN_DIR[0] / len;
  sunToLight[1] = -SUN_DIR[1] / len;
  sunToLight[2] = -SUN_DIR[2] / len;
}

/** The point on a sphere whose normal halves the sun and eye directions: the highlight. */
function highlightPoint(c: readonly number[], out: Float32Array): void {
  let vx = eye[0]! - c[0]!;
  let vy = eye[1]! - c[1]!;
  let vz = eye[2]! - c[2]!;
  const vl = Math.hypot(vx, vy, vz);
  vx /= vl;
  vy /= vl;
  vz /= vl;
  let hx = vx + sunToLight[0]!;
  let hy = vy + sunToLight[1]!;
  let hz = vz + sunToLight[2]!;
  const hl = Math.hypot(hx, hy, hz);
  hx /= hl;
  hy /= hl;
  hz /= hl;
  out[0] = c[0]! + SPHERE_RADIUS * hx;
  out[1] = c[1]! + SPHERE_RADIUS * hy;
  out[2] = c[2]! + SPHERE_RADIUS * hz;
}

/** The point on a sphere nearest the eye. */
function facingPoint(c: readonly number[], out: Float32Array): void {
  const vx = eye[0]! - c[0]!;
  const vy = eye[1]! - c[1]!;
  const vz = eye[2]! - c[2]!;
  const vl = Math.hypot(vx, vy, vz);
  out[0] = c[0]! + (SPHERE_RADIUS * vx) / vl;
  out[1] = c[1]! + (SPHERE_RADIUS * vy) / vl;
  out[2] = c[2]! + (SPHERE_RADIUS * vz) / vl;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine PBR demo' });
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
  placeCamera(camera);

  // The grid's metallic-roughness map: one texel per sphere, G roughness (down), B metallic.
  const mr = new Uint8Array(COLS * ROWS * 4);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const o = (row * COLS + col) * 4;
      mr[o] = 0;
      mr[o + 1] = Math.round((row / (ROWS - 1)) * 255);
      mr[o + 2] = Math.round((col / (COLS - 1)) * 255);
      mr[o + 3] = 255;
    }
  }
  const mrTex = renderer.textureFromPixels({ width: COLS, height: ROWS, data: mr, label: 'mr' });
  const normalTex = renderer.textureFromShader({
    width: 256,
    height: 256,
    wgsl: NORMAL_MAP_WGSL,
    format: 'rgba8unorm',
    label: 'bumps',
  });

  const spheresMat = createStandardMaterial(renderer, {
    label: 'spheres',
    metallicRoughness: mrTex,
    metallic: 1,
    roughness: 1,
  });
  const tileMat = createStandardMaterial(renderer, {
    label: 'tile',
    normal: normalTex,
    metallic: 0,
    roughness: 0.4,
  });
  const groundMat = createStandardMaterial(renderer, {
    label: 'ground',
    metallic: 0,
    roughness: 0.9,
  });
  state.materials = 3;

  const sphere = renderer.createMesh({
    ...sphereGeometry(24, 36),
    layout: VERTEX_LAYOUT_3D,
    label: 'sphere',
  });
  const wall = renderer.createMesh({ ...wallGeometry(), layout: VERTEX_LAYOUT_3D, label: 'wall' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });

  // Instances: one transform and one params object per sphere, reused every frame.
  const sphereT: Transform[] = [];
  const sphereP: InstanceParams[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const [x, y, z] = sphereCentre(col, row);
      sphereT.push(
        new Transform({
          x,
          y,
          z,
          scaleX: SPHERE_RADIUS,
          scaleY: SPHERE_RADIUS,
          scaleZ: SPHERE_RADIUS,
        }),
      );
      const u = (col + 0.5) / COLS;
      const v = (row + 0.5) / ROWS;
      sphereP.push({ tint: SPHERE_TINT, uv: [u, v, u, v] });
    }
  }
  const tileT = new Transform({
    x: TILE_CENTRE[0],
    y: TILE_CENTRE[1],
    z: TILE_CENTRE[2],
    scaleX: TILE_SIZE,
    scaleY: TILE_SIZE,
    scaleZ: 1,
  });
  const tileP: InstanceParams = { tint: [0.62, 0.6, 0.58, 1] };
  const groundT = new Transform({ scaleX: 60, scaleY: 1, scaleZ: 60 });
  const groundP: InstanceParams = { tint: [0.34, 0.37, 0.3, 1] };

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.dir = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  const lamp: PointLight = { position: LAMP_POS, color: LAMP_COLOR, radius: LAMP_RADIUS };
  lights.points.push(lamp);
  lights.sun.shadow = { extent: SHADOW_EXTENT, size: SHADOW_SIZE };
  lights.fog.color = FOG_COLOR;
  lights.fog.density = 1;
  lights.fog.near = FOG_NEAR;
  lights.fog.far = FOG_FAR;

  const gestures = new Gestures();
  const input = new Input<Action>(bindings, { gestures });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  const roughCentre = sphereCentre(0, ROWS - 1);
  const metalCentre = sphereCentre(COLS - 1, (ROWS - 1) / 2);
  const point = new Float32Array(3);
  // The tile's bump peaks at uv (0.5, 0.5); u runs +x and v runs -y across it.
  const tileLit = [
    TILE_CENTRE[0] + PROBE_DELTA * TILE_SIZE,
    TILE_CENTRE[1] + PROBE_DELTA * TILE_SIZE,
    TILE_CENTRE[2],
  ] as const;
  const tileDark = [
    TILE_CENTRE[0] - PROBE_DELTA * TILE_SIZE,
    TILE_CENTRE[1] - PROBE_DELTA * TILE_SIZE,
    TILE_CENTRE[2],
  ] as const;

  // ws/perf-overlay: the frame-cost readout, shown with `?perf` (the monitor always samples).
  const perf = createPerfMonitor();
  const perfHud = new URLSearchParams(location.search).has('perf')
    ? createPerfOverlay(perf, { parent: root })
    : null;

  const loop = new GameLoop({
    update() {
      input.update();
      const pan = gestures.pan;
      if (pan && pan.pointers === 1 && (pan.phase === 'start' || pan.phase === 'move')) {
        orbit.yaw -= pan.dx * ORBIT_PER_PX;
        orbit.pitch += pan.dy * ORBIT_PER_PX;
      }
      const pinch = gestures.pinch;
      if (pinch && (pinch.phase === 'start' || pinch.phase === 'move') && pinch.delta > 0) {
        orbit.distance /= pinch.delta;
      }
      orbit.distance *= 1 + (input.value('zoomOut') - input.value('zoomIn')) * ZOOM_PER_TICK;
      placeCamera(camera);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, groundMat, groundT, groundP);
      for (let i = 0; i < sphereT.length; i++) {
        frame.mesh(sphere, spheresMat, sphereT[i]!, sphereP[i]!);
      }
      frame.mesh(wall, tileMat, tileT, tileP);
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      state.perf = perf.sample(renderer);
      perfHud?.update();
      const ls = state.lights;
      ls.sun = frame.lights.sun.color[0]! > 0;
      ls.points = frame.lights.points.length;
      ls.shadow = frame.lights.sun.shadow !== null;
      ls.fog = frame.lights.fog.density > 0;
      facingPoint(roughCentre, point);
      probe(camera, point[0]!, point[1]!, point[2]!, state.probes.rough);
      highlightPoint(metalCentre, point);
      probe(camera, point[0]!, point[1]!, point[2]!, state.probes.highlight);
      probe(camera, tileLit[0], tileLit[1], tileLit[2], state.probes.tileLit);
      probe(camera, tileDark[0], tileDark[1], tileDark[2], state.probes.tileDark);
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
