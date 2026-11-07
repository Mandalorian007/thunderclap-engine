/**
 * Skinning demo page: skinned meshes on the raw renderer. Noun-free, and nothing here is engine
 * code: the tube, its three-joint chain and the sway are what a game (or `anim`) would write.
 *
 * - Two tubes in `VERTEX_LAYOUT_SKINNED`: 24 rings along +y, 3 joints at y = 0, 1, 2, each
 *   vertex weighted linearly between the two joints it lies between (`setVertexSkin`).
 * - One `SkinPalette` (3 joints × 2 instances) bound to the lit material (`buffers`); each
 *   tube names its slot in `params.w`. The joints are `Transform`s in a parent chain, swung by
 *   hand with sines; `world × inverseBind` goes into the palette with `anim`'s `multiplyAffine`,
 *   then one `flush()` per frame.
 * - Lit by the engine lighting block; the sun casts a shadow from a static block onto the
 *   ground (the tubes pass `castShadow: false`, so the probes see only the block's shadow).
 */
import { multiplyAffine } from '@thunderclap-engine/engine/anim';
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  JOINT_FLOATS,
  Lights,
  Renderer,
  SkinPalette,
  setVertexSkin,
  Transform,
  VERTEX_LAYOUT_3D,
  VERTEX_LAYOUT_SKINNED,
  VERTEX_SKINNED_FLOATS,
} from '@thunderclap-engine/engine/render';
import type { HarnessSkinApi, HarnessSkinState } from './skin-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessSkinState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  time: 0,
  sway: 0,
  logical: LOGICAL,
  probes: { tip: { x: 0, y: 0 }, base: { x: 0, y: 0 }, ground: { x: 0, y: 0 } },
  tipWorld: [0, 0, 0],
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
  skin: { joints: 0, instances: 0, tubes: 0 },
  shadow: { enabled: false, size: 0 },
};
const api: HarnessSkinApi = { state };
window.__harnessSkin = api;

// ------------------------------------------------------------------ geometry

const RINGS = 24;
const SEGMENTS = 16;
const JOINTS = 3;
const TUBE_HEIGHT = 3;
const TUBE_RADIUS = 0.4;
/** Height of the probe along the tube: just under the top ring, inside the body. */
const TIP_Y = 2.8;

/**
 * A tube along +y, `RINGS` rings of `SEGMENTS` vertices in the skinned layout, closed by a cap
 * at each end: outward normals, uv around and up, white. Joints sit at y = 0, 1, 2; a vertex
 * between joints j and j + 1 is weighted linearly between them, and above the last joint it
 * follows that joint.
 */
function tubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array((RINGS * SEGMENTS + 2) * VERTEX_SKINNED_FLOATS);
  const bytes = new Uint8Array(vertices.buffer);
  const indices = new Uint16Array((RINGS - 1) * SEGMENTS * 6 + 2 * SEGMENTS * 3);
  let v = 0;
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number) => {
    const o = v * VERTEX_SKINNED_FLOATS;
    vertices[o] = x;
    vertices[o + 1] = y;
    vertices[o + 2] = z;
    vertices[o + 3] = nx;
    vertices[o + 4] = ny;
    vertices[o + 5] = nz;
    vertices[o + 6] = u;
    vertices[o + 7] = y / TUBE_HEIGHT;
    vertices[o + 8] = vertices[o + 9] = vertices[o + 10] = vertices[o + 11] = 1;
    const j = Math.min(JOINTS - 1, Math.floor(y));
    const t = j === JOINTS - 1 ? 0 : y - j;
    setVertexSkin(bytes, v, [j, Math.min(JOINTS - 1, j + 1)], [1 - t, t]);
    v++;
  };
  for (let r = 0; r < RINGS; r++) {
    const y = (r / (RINGS - 1)) * TUBE_HEIGHT;
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      put(nx * TUBE_RADIUS, y, nz * TUBE_RADIUS, nx, 0, nz, s / SEGMENTS);
    }
  }
  const bottom = v;
  put(0, 0, 0, 0, -1, 0, 0.5);
  const top = v;
  put(0, TUBE_HEIGHT, 0, 0, 1, 0, 0.5);
  let i = 0;
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = r * SEGMENTS + s;
      const b = r * SEGMENTS + ((s + 1) % SEGMENTS);
      const c = a + SEGMENTS;
      const d = b + SEGMENTS;
      indices.set([a, b, d, a, d, c], i);
      i += 6;
    }
  }
  const last = (RINGS - 1) * SEGMENTS;
  for (let s = 0; s < SEGMENTS; s++) {
    const n = (s + 1) % SEGMENTS;
    indices.set([bottom, n, s], i);
    indices.set([top, last + s, last + n], i + 3);
    i += 6;
  }
  return { vertices, indices };
}

/** A unit cube centred on the origin (3D layout): 24 vertices, 36 indices, white. */
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

/** A unit quad in the XZ plane (y = 0) facing +y, white (3D layout). */
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

/** Albedo × the lighting block (`engine_lambert`) plus a faint sky term; `params.x` checkers. */
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
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.15 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const AMBIENT = [0.2, 0.2, 0.22] as const;
const SUN_DIR = [-0.45, -1.0, -0.65] as const;
const SUN_COLOR = [0.85, 0.85, 0.8] as const;
const SHADOW_EXTENT = 16;
const SHADOW_SIZE = 2048;

// ------------------------------------------------------------------ the joint chain

/**
 * Bend per joint in radians, and the sway rates (Hz). The main sway, in x, is an eighth of a
 * cycle per second: a tube seen upright is a second later most of the way to full bend
 * (e2e/skin.spec.ts waits for that). A smaller sway in z keeps it from being a flat pendulum.
 */
const BEND = 0.28;
const SWAY_X_HZ = 0.125;
const SWAY_Z_HZ = 0.19;
const SWAY_Z_SCALE = 0.4;

/** One tube's rig: three joints in a chain, bound at y = 0, 1, 2 along the tube. */
class Rig {
  readonly joints: Transform[] = [];
  /** `world × inverseBind` for every joint, 12 floats each: what the palette slot takes. */
  readonly matrices = new Float32Array(JOINTS * JOINT_FLOATS);
  private readonly inverseBind: Float32Array[] = [];
  private readonly axis = new Float32Array(3);

  constructor(readonly transform: Transform) {
    for (let j = 0; j < JOINTS; j++) {
      const parent = j === 0 ? null : this.joints[j - 1]!;
      this.joints.push(new Transform({ y: j === 0 ? 0 : 1, parent }));
      // Bind pose: joint j at (0, j, 0) with no rotation, so the inverse is a translation by -j.
      this.inverseBind.push(new Float32Array([1, 0, 0, 0, 0, 1, 0, -j, 0, 0, 1, 0]));
    }
  }

  /** The normalised x sway (-1..1) of the last `pose`. */
  sway = 0;

  /**
   * Bend every joint by the same angle about a direction that itself turns with time. The
   * tubes share the x sway (so they never lean into each other) and differ in z.
   */
  pose(time: number, phaseZ: number): void {
    const ax = Math.sin(2 * Math.PI * SWAY_X_HZ * time);
    const az = SWAY_Z_SCALE * Math.sin(2 * Math.PI * SWAY_Z_HZ * time + phaseZ);
    this.sway = ax;
    const len = Math.hypot(ax, az) || 1;
    const a = this.axis;
    a[0] = az / len;
    a[1] = 0;
    a[2] = -ax / len;
    const angle = BEND * len;
    for (let j = 0; j < JOINTS; j++) {
      this.joints[j]!.setAxisAngle(a[0]!, 0, a[2]!, angle);
      multiplyAffine(
        this.matrices,
        j * JOINT_FLOATS,
        this.joints[j]!.world,
        0,
        this.inverseBind[j]!,
        0,
      );
    }
  }

  /** World position of a point at height `y` on the tube's axis, after skinning. */
  pointAt(y: number, out: Float32Array): void {
    // The same weights the vertices carry: linear between joints j and j + 1, the last alone.
    const j = Math.min(JOINTS - 1, Math.floor(y));
    const w1 = j === JOINTS - 1 ? 0 : y - j;
    const w0 = 1 - w1;
    const m = this.matrices;
    const o0 = j * JOINT_FLOATS;
    const o1 = Math.min(JOINTS - 1, j + 1) * JOINT_FLOATS;
    const t = this.transform.world;
    // Skin the axis point (0, y, 0), then the instance matrix.
    const sx = w0 * (m[o0 + 1]! * y + m[o0 + 3]!) + w1 * (m[o1 + 1]! * y + m[o1 + 3]!);
    const sy = w0 * (m[o0 + 5]! * y + m[o0 + 7]!) + w1 * (m[o1 + 5]! * y + m[o1 + 7]!);
    const sz = w0 * (m[o0 + 9]! * y + m[o0 + 11]!) + w1 * (m[o1 + 9]! * y + m[o1 + 11]!);
    out[0] = t[0]! * sx + t[1]! * sy + t[2]! * sz + t[3]!;
    out[1] = t[4]! * sx + t[5]! * sy + t[6]! * sz + t[7]!;
    out[2] = t[8]! * sx + t[9]! * sy + t[10]! * sz + t[11]!;
  }
}

// ------------------------------------------------------------------ the scene

const EYE = [0, 2.2, 9] as const;
const TARGET = [0, 1.6, 0] as const;
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const tipWorld = new Float32Array(3);
const baseWorld = new Float32Array(3);

function probe(camera: Camera, p: ArrayLike<number>, out: { x: number; y: number }) {
  camera.worldToScreen(p[0]!, p[1]!, p[2]!, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine skinning demo' });
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

  const palette = new SkinPalette(renderer.device, {
    joints: JOINTS,
    instances: 2,
    label: 'tubes',
  });
  const skinned = renderer.createMaterial({
    label: 'lit-skinned',
    blend: 'opaque',
    wgsl: LIT_WGSL,
    buffers: [palette.buffer],
  });
  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const tube = renderer.createMesh({
    ...tubeGeometry(),
    layout: VERTEX_LAYOUT_SKINNED,
    label: 'tube',
  });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });

  const groundT = new Transform({ scaleX: 14, scaleY: 1, scaleZ: 14 });
  const blockT = new Transform({ x: 4.2, y: 0.5, z: 1.2 });
  const rigs = [new Rig(new Transform({ x: -1.6 })), new Rig(new Transform({ x: 1.6 }))];
  const groundP: InstanceParams = { tint: [0.4, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const blockP: InstanceParams = { tint: [0.1, 0.3, 1, 1] };
  // The palette slot rides in params.w; the tubes do not cast (see the header comment).
  const tubeP: InstanceParams[] = [
    { tint: [1, 0.45, 0.08, 1], params: [0, 0, 0, 0], castShadow: false },
    { tint: [0.95, 0.85, 0.2, 1], params: [0, 0, 0, 1], castShadow: false },
  ];

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.direction = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  lights.sun.shadow = { extent: SHADOW_EXTENT, size: SHADOW_SIZE };

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const t = time.realTime;
      for (let i = 0; i < rigs.length; i++) {
        rigs[i]!.pose(t, i * 2.4);
        palette.set(i, rigs[i]!.matrices);
      }
      palette.flush();
      const frame = renderer.beginFrame(t, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, blockT, blockP);
      for (let i = 0; i < rigs.length; i++) frame.mesh(tube, skinned, rigs[i]!.transform, tubeP[i]);
      renderer.endFrame();
      state.frames++;
      state.time = t;
      state.sway = rigs[0]!.sway;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      state.skin.joints = palette.joints;
      state.skin.instances = palette.instances;
      state.skin.tubes = rigs.length;
      rigs[0]!.pointAt(TIP_Y, tipWorld);
      rigs[0]!.pointAt(0.1, baseWorld);
      state.tipWorld[0] = tipWorld[0]!;
      state.tipWorld[1] = tipWorld[1]!;
      state.tipWorld[2] = tipWorld[2]!;
      probe(camera, tipWorld, state.probes.tip);
      probe(camera, baseWorld, state.probes.base);
      probe(camera, [-3.5, 0, 3.5], state.probes.ground);
      const sh = frame.lights.sun.shadow;
      state.shadow.enabled = sh !== null;
      state.shadow.size = sh?.size ?? 0;
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
