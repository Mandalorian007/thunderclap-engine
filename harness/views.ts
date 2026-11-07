/**
 * Two-views page (ws/two-views): the stereo seam without WebXR. The mesh demo's scene is drawn
 * twice per frame, once per eye, into the two halves of one surface in one
 * `beginFrame` / record / `render()` × 2 / `endFrame`. Each eye is its own `Camera.perspective`
 * offset ±`IPD / 2` on the camera's right axis, with `camera.screen` the left or right half in the
 * unit-square convention `render()` accepts and `camera.viewIndex` 0 or 1 (the `view_index` of
 * its camera block). Nothing here is engine code: the geometry and the shader are the mesh demo's
 * (copied, not imported), the eyes are what an XR host would hand a game.
 *
 * A small head-locked block 0.6 m in front of the eyes (`marker`) makes the parallax large enough
 * to sample: it lands at different places in the two halves, while the scene behind it agrees.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessViewsState, ViewsEye, ViewsProbe } from './views-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
/** Interpupillary distance, metres: the eyes sit ±0.032 on the right axis. */
const IPD = 0.064;
const MARKER_DISTANCE = 0.6;
const MARKER_SIZE = 0.03;

function eyeState(viewIndex: number, x: number): ViewsEye {
  const p = (): ViewsProbe => ({ x: 0, y: 0 });
  return {
    viewIndex,
    position: [0, 0, 0],
    screen: { x, y: 0, width: 0.5, height: 1 },
    probes: { near: p(), far: p(), ground: p(), marker: p() },
    drawCalls: 0,
  };
}

const state: HarnessViewsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  ipd: IPD,
  eyes: [eyeState(0, 0), eyeState(1, 0.5)],
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
};
window.__harnessViews = { state };

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

/** Lambert + ambient from the world normal; `params.x` > 0 draws a checker from the world position. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let l = normalize(vec3f(0.45, 1.0, 0.65));
  let diffuse = max(dot(n, l), 0.0);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  // A faint sky term from above keeps the shadowed faces readable.
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(albedo * (0.18 + 0.12 * sky + 0.8 * diffuse), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the eyes

const TARGET = [0, 0.9, 0] as const;
const ORBIT = { yaw: 0, pitch: 0.2, distance: 9 };
const UP = [0, 1, 0] as const;

/** The head: centre eye, forward, right and up (world), recomputed per frame without allocating. */
const head = {
  eye: new Float32Array(3),
  fwd: new Float32Array(3),
  right: new Float32Array(3),
  up: new Float32Array(3),
};
const eyePos = new Float32Array(3);
const eyeTarget = new Float32Array(3);
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function normalize(v: Float32Array): void {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  v[0]! /= l;
  v[1]! /= l;
  v[2]! /= l;
}

function cross(out: Float32Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  out[0] = a[1]! * b[2]! - a[2]! * b[1]!;
  out[1] = a[2]! * b[0]! - a[0]! * b[2]!;
  out[2] = a[0]! * b[1]! - a[1]! * b[0]!;
}

/** Place the head on its orbit and derive its axes: `right` is what the eyes are offset along. */
function placeHead(): void {
  const o = ORBIT;
  const cp = Math.cos(o.pitch);
  const h = head;
  h.eye[0] = TARGET[0] + o.distance * Math.sin(o.yaw) * cp;
  h.eye[1] = TARGET[1] + o.distance * Math.sin(o.pitch);
  h.eye[2] = TARGET[2] + o.distance * Math.cos(o.yaw) * cp;
  for (let k = 0; k < 3; k++) h.fwd[k] = TARGET[k]! - h.eye[k]!;
  normalize(h.fwd);
  cross(h.right, h.fwd, UP);
  normalize(h.right);
  cross(h.up, h.right, h.fwd);
}

/** Place one eye `offset` metres along the head's right axis, looking parallel to the head. */
function placeEye(camera: Camera, offset: number, out: ViewsEye): void {
  const h = head;
  for (let k = 0; k < 3; k++) {
    eyePos[k] = h.eye[k]! + h.right[k]! * offset;
    eyeTarget[k] = eyePos[k]! + h.fwd[k]!;
  }
  camera.lookAt(eyePos, eyeTarget, h.up);
  out.position[0] = eyePos[0]!;
  out.position[1] = eyePos[1]!;
  out.position[2] = eyePos[2]!;
}

function probe(camera: Camera, x: number, y: number, z: number, out: ViewsProbe): void {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine two-views demo' });
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

  // One eye per half: the aspect is the half's, `screen` is the half as a fraction of the
  // surface, `viewIndex` tells the camera blocks apart.
  const fovY = (50 * Math.PI) / 180;
  const aspect = LOGICAL.width / 2 / LOGICAL.height;
  const eyes = [0, 1].map((i) => {
    const c = Camera.perspective(fovY, aspect, 0.1, 100);
    Object.assign(c.screen, state.eyes[i as 0 | 1].screen);
    c.viewIndex = i;
    return c;
  }) as [Camera, Camera];

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });

  // The mesh demo's instances: the near block sits at z 1..2 and the far block (drawn after it)
  // fills x -1..1, y 0..3, z -1..0 right behind it. The marker is head-locked, placed per frame.
  const groundT = new Transform({ scaleX: 16, scaleY: 1, scaleZ: 16 });
  const near = new Transform({ x: 0, y: 0.5, z: 1.5 });
  const far = new Transform({ x: 0, y: 1.5, z: -0.5, scaleX: 2, scaleY: 3, scaleZ: 1 });
  const left = new Transform({ x: -3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const right = new Transform({ x: 3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const marker = new Transform({ scaleX: MARKER_SIZE, scaleY: MARKER_SIZE, scaleZ: MARKER_SIZE });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const nearP: InstanceParams = { tint: [1.0, 0.1, 0.06, 1] };
  const farP: InstanceParams = { tint: [0.08, 0.28, 1.0, 1] };
  const leftP: InstanceParams = { tint: [0.3, 0.85, 0.35, 1] };
  const rightP: InstanceParams = { tint: [0.95, 0.8, 0.2, 1] };
  const markerP: InstanceParams = { tint: [1.0, 0.12, 1.0, 1] };
  let spin = 0;

  const loop = new GameLoop({
    update(dt) {
      spin += dt;
    },
    render(_alpha, time) {
      placeHead();
      const h = head;
      marker.setPosition(
        h.eye[0]! + h.fwd[0]! * MARKER_DISTANCE,
        h.eye[1]! + h.fwd[1]! * MARKER_DISTANCE,
        h.eye[2]! + h.fwd[2]! * MARKER_DISTANCE,
      );
      left.setAxisAngle(0, 1, 0, spin * 0.6);
      right.setAxisAngle(1, 1, 0, spin * 0.4);

      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, near, nearP);
      frame.mesh(cube, lit, far, farP);
      frame.mesh(cube, lit, left, leftP);
      frame.mesh(cube, lit, right, rightP);
      frame.mesh(cube, lit, marker, markerP);
      for (let i = 0; i < 2; i++) {
        const camera = eyes[i]!;
        const eye = state.eyes[i as 0 | 1];
        placeEye(camera, (i === 0 ? -1 : 1) * (IPD / 2), eye);
        const before = renderer.stats.drawCalls;
        renderer.render(frame, camera);
        eye.drawCalls = renderer.stats.drawCalls - before;
        probe(camera, 0, 0.75, 2, eye.probes.near);
        probe(camera, 0, 2.5, 0, eye.probes.far);
        probe(camera, 1.2, 0, 3.6, eye.probes.ground);
        const m = marker.position;
        probe(camera, m.x, m.y, m.z, eye.probes.marker);
      }
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
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
