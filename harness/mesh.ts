/**
 * Mesh demo page (`?demo=mesh` in STATUS; E-001 "seams + demos"): the Phase 3 seams working
 * together on the raw renderer. Noun-free, and nothing here is engine code: the geometry, the
 * lighting and the orbit are what a game would write.
 *
 * - `Camera.perspective` placed with `lookAt`, orbiting a target: drag with any pointer (a one
 *   pointer `pan` gesture) or the right stick; zoom with the wheel, a pinch or the triggers.
 * - A depth buffer: the camera preset turns `depthTest`/`depthWrite` on and the renderer sorts
 *   opaque draws front-to-back. A tall block behind the near one is drawn after it and must stay
 *   behind it (e2e/mesh.spec.ts samples both).
 * - A lit `Mesh` in `VERTEX_LAYOUT_3D` (a cube and a ground quad) drawn through `Transform`s.
 *   The light comes from the engine's lighting block (`frame.lights`: ambient, a sun and one
 *   warm point light circling the blocks); the fragment shader written here reads it through
 *   `engine_lambert(normal, world_pos)` from the material prelude.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { type GamepadLike, Gestures, Input } from '@thunderclap/engine/input';
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
import type { HarnessMeshApi, HarnessMeshState } from './mesh-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessMeshState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  camera: { yaw: 0, pitch: 0, distance: 0, eye: [0, 0, 0] },
  depth: { test: false, write: false },
  probes: { near: { x: 0, y: 0 }, far: { x: 0, y: 0 }, ground: { x: 0, y: 0 } },
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
  zoom: { in: 0, out: 0 },
  lights: { sun: false, points: 0, lamp: [0, 0, 0] },
};

/** A fake gamepad the spec installs; `null` reads the real ones. */
let fakePad: GamepadLike | null = null;

const api: HarnessMeshApi = {
  state,
  setPad(axes, pressed) {
    fakePad = {
      axes,
      buttons: Array.from({ length: 8 }, (_, i) => ({
        pressed: pressed.includes(i),
        value: pressed.includes(i) ? 1 : 0,
      })),
    };
  },
};
window.__harnessMesh = api;

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
 * Albedo × the engine lighting block (`engine_lambert`: ambient + sun + point lights) plus a
 * faint sky term from above; `params.x` > 0 draws a checker from the world position.
 */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  // A faint sky term from above keeps the shadowed faces readable.
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** The lights: a sun from up-right-front (the direction it travels) and a warm circling lamp. */
const AMBIENT = [0.18, 0.18, 0.2] as const;
const SUN_DIR = [-0.45, -1.0, -0.65] as const;
const SUN_COLOR = [0.8, 0.8, 0.78] as const;
const LAMP_COLOR = [1.6, 0.9, 0.4] as const;
const LAMP_RADIUS = 5;
const LAMP_ORBIT = 3.2;
const LAMP_HEIGHT = 1.6;
const LAMP_RAD_PER_S = 0.9;

// ------------------------------------------------------------------ the scene

const TARGET = [0, 0.9, 0] as const;
const orbit = { yaw: 0, pitch: 0.2, distance: 9 };
const ORBIT_PER_PX = 0.005;
const STICK_RAD_PER_S = 2.2;
const ZOOM_PER_TICK = 0.03;
const PITCH_MIN = 0.05;
const PITCH_MAX = 1.35;
const DISTANCE_MIN = 3;
const DISTANCE_MAX = 30;

const eye = new Float32Array(3);
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

type Action = 'zoomIn' | 'zoomOut' | 'stickLeft' | 'stickRight' | 'stickUp' | 'stickDown';
const bindings = {
  zoomIn: [{ wheel: -1 }, { padButton: 7 }],
  zoomOut: [{ wheel: 1 }, { padButton: 6 }],
  stickLeft: [{ padAxis: 2, dir: -1, threshold: 0.15 }],
  stickRight: [{ padAxis: 2, dir: 1, threshold: 0.15 }],
  stickUp: [{ padAxis: 3, dir: -1, threshold: 0.15 }],
  stickDown: [{ padAxis: 3, dir: 1, threshold: 0.15 }],
} as const;

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

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine mesh demo' });
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

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });

  // Instances. The near block sits at z 1..2; the far block (drawn after it) fills x -1..1,
  // y 0..3, z -1..0 right behind it, so from the default view it would paint over the near block
  // without a depth test.
  const groundT = new Transform({ scaleX: 16, scaleY: 1, scaleZ: 16 });
  const near = new Transform({ x: 0, y: 0.5, z: 1.5 });
  const far = new Transform({ x: 0, y: 1.5, z: -0.5, scaleX: 2, scaleY: 3, scaleZ: 1 });
  const left = new Transform({ x: -3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const right = new Transform({ x: 3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const nearP: InstanceParams = { tint: [1.0, 0.1, 0.06, 1] };
  const farP: InstanceParams = { tint: [0.08, 0.28, 1.0, 1] };
  const leftP: InstanceParams = { tint: [0.3, 0.85, 0.35, 1] };
  const rightP: InstanceParams = { tint: [0.95, 0.8, 0.2, 1] };
  let spin = 0;

  // The lights: set once, mutated per frame (the lamp's position), uploaded by the renderer.
  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.dir = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  const lampPos = new Float32Array(3);
  const lamp: PointLight = { position: lampPos, color: LAMP_COLOR, radius: LAMP_RADIUS };
  lights.points.push(lamp);

  const gestures = new Gestures();
  const input = new Input<Action>(bindings, {
    gestures,
    getGamepads: () => (fakePad ? [fakePad] : (navigator.getGamepads?.() ?? [])),
  });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  const loop = new GameLoop({
    update(dt) {
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
      const sx = input.value('stickRight') - input.value('stickLeft');
      const sy = input.value('stickDown') - input.value('stickUp');
      orbit.yaw -= sx * STICK_RAD_PER_S * dt;
      orbit.pitch += sy * STICK_RAD_PER_S * dt;
      const zi = input.value('zoomIn');
      const zo = input.value('zoomOut');
      if (zi > 0) state.zoom.in++;
      if (zo > 0) state.zoom.out++;
      orbit.distance *= 1 + (zo - zi) * ZOOM_PER_TICK;
      placeCamera(camera);
      spin += dt;
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      lampPos[0] = TARGET[0] + LAMP_ORBIT * Math.cos(spin * LAMP_RAD_PER_S);
      lampPos[1] = LAMP_HEIGHT;
      lampPos[2] = TARGET[2] + LAMP_ORBIT * Math.sin(spin * LAMP_RAD_PER_S);
      left.setAxisAngle(0, 1, 0, spin * 0.6);
      right.setAxisAngle(1, 1, 0, spin * 0.4);
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, near, nearP);
      frame.mesh(cube, lit, far, farP);
      frame.mesh(cube, lit, left, leftP);
      frame.mesh(cube, lit, right, rightP);
      renderer.endFrame();
      state.frames++;
      state.depth.test = camera.depthTest;
      state.depth.write = camera.depthWrite;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      const ls = state.lights;
      ls.sun = frame.lights.sun.color[0]! > 0;
      ls.points = frame.lights.points.length;
      ls.lamp[0] = lampPos[0]!;
      ls.lamp[1] = lampPos[1]!;
      ls.lamp[2] = lampPos[2]!;
      probe(camera, 0, 0.75, 2, state.probes.near);
      probe(camera, 0, 2.5, 0, state.probes.far);
      probe(camera, 1.2, 0, 3.6, state.probes.ground);
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
