/**
 * Post 3 page (ws/post-3): a lit scene, a dark mirror floor with a checker, a grey block, a
 * bright sky patch (HDR colour and emissive, so it blooms and reflects) over a dark backdrop
 * and side wall, through a `PostStack` with bloom on and the post-3 passes off unless asked:
 *
 * - `?taa`      temporal anti-aliasing (sharpen 0 so only the blend shows);
 * - `?ssr`      screen-space reflections: the floor under the sky patch lights up;
 * - `?autoexp`  auto exposure: `exposure` moves from 0 and settles;
 * - `?wb=3200`  white balance toward that kelvin (warms the grey block);
 * - `?mblur`    camera motion blur;
 * - `?dirt`     a procedural lens-dirt texture on the bloom;
 * - `?still`    parks the camera orbit and the floor spin (the specs read this).
 *
 * The page publishes the stack's pass labels (render and compute, through a proxy over the
 * command encoder), the current EV and the probes e2e/post3.spec.ts samples.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { boot } from '@thunderclap/engine/platform';
import { createLensDirtTexture, type PostSettingsPatch, PostStack } from '@thunderclap/engine/post';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type PostInputs,
  type PostProcessor,
  Renderer,
  type SceneTargetViewport,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import type { HarnessPost3Api, HarnessPost3State, Post3Flags } from './post3-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const flags: Post3Flags = {
  taa: query.has('taa'),
  ssr: query.has('ssr'),
  autoexp: query.has('autoexp'),
  wb: Number(query.get('wb') ?? 0) || 0,
  mblur: query.has('mblur'),
  dirt: query.has('dirt'),
  still: query.has('still'),
};

const state: HarnessPost3State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  flags,
  exposure: 0,
  taaActive: false,
  ssrActive: false,
  historyResets: 0,
  passes: [],
  frameMs: 0,
  probes: {
    edge: { top: { x: 0, y: 0 }, bottom: { x: 0, y: 0 } },
    floor: { x: 0, y: 0 },
    grey: { x: 0, y: 0 },
    greyHalf: 30,
    bloom: { x: 0, y: 0 },
    bloomHalf: 80,
  },
  gpuErrors: 0,
};
const api: HarnessPost3Api = { state };
window.__harnessPost3 = api;

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

/** A unit quad with the given normal and tangent frame, centred on the origin, white. */
function quadGeometry(
  n: readonly [number, number, number],
  r: readonly [number, number, number],
  u: readonly [number, number, number],
): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array(4 * 12);
  let v = 0;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    for (let k = 0; k < 3; k++) vertices[v + k] = (sx * r[k]! + sy * u[k]!) * 0.5;
    vertices[v + 3] = n[0];
    vertices[v + 4] = n[1];
    vertices[v + 5] = n[2];
    vertices[v + 6] = (sx + 1) / 2;
    vertices[v + 7] = (1 - sy) / 2;
    vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
    v += 12;
  }
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

// ------------------------------------------------------------------ materials

/** Lambert with a checker when `params.x` is set (the floor), no fog. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  var o: FragOut;
  o.color = vec4f(albedo * engine_lambert(n, in.worldPos), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** The tint as HDR colour and, scaled by `params.x`, as emissive: the sky patch. */
const GLOW_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = vec4f(in.color.rgb, 1.0);
  o.emissive = vec4f(in.color.rgb * in.params.x, 1.0);
  return o;
}`;

/** A vertical gradient between the tint (top) and `params.rgb` (bottom): the dark walls. */
const WALL_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = vec4f(mix(in.color.rgb, in.params.rgb, in.uv.y), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the scene

const TARGET = [0, 1, 0] as const;
const ORBIT = { pitch: 0.34, distance: 9.5, swing: 0.25, rate: 0.4 };
const FLOOR_SPIN = 0.15;
const FLOOR_SIZE = 40;
const FLOOR_TINT = [0.12, 0.12, 0.14] as const;
const BLOCK_POS = [2.6, 1.0, 1.4] as const;
const BLOCK_SCALE = 2;
/** Yaw with a tilt so the silhouette edges are diagonal (steps for TAA to smooth). */
const BLOCK_AXIS = [0.2, 1, 0.1] as const;
const BLOCK_ANGLE = 0.35;
const BLOCK_TINT = [0.62, 0.62, 0.62] as const;
const WALL_Z = -10;
const WALL_X = -9;
const WALL_SIZE = 60;
const WALL_TOP = [0.015, 0.02, 0.035] as const;
const WALL_BOTTOM = [0.05, 0.065, 0.1] as const;
const SKY_POS = [0, 5, -9.9] as const;
const SKY_SIZE = [6, 3] as const;
const SKY_TINT = [3, 3, 2.7] as const;
const AMBIENT = [0.22, 0.22, 0.25] as const;
const SUN_DIR = [-0.4, -1.0, -0.5] as const;
const SUN_COLOR = [0.9, 0.9, 0.85] as const;
/** The floor point whose mirror ray from the parked eye lands on the sky patch. */
const FLOOR_PROBE = [0, 0, 0.2] as const;
/** On the backdrop beside the sky patch, inside its bloom halo. */
const BLOOM_PROBE = [4.6, 4.2, -9.95] as const;

const eye = new Float32Array(3);
const q = { x: 0, y: 0, z: 0, w: 1 };
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const world = new Float32Array(3);

function setAxis(): void {
  const len = Math.hypot(BLOCK_AXIS[0], BLOCK_AXIS[1], BLOCK_AXIS[2]);
  const s = Math.sin(BLOCK_ANGLE / 2);
  q.x = (BLOCK_AXIS[0] / len) * s;
  q.y = (BLOCK_AXIS[1] / len) * s;
  q.z = (BLOCK_AXIS[2] / len) * s;
  q.w = Math.cos(BLOCK_ANGLE / 2);
}

function placeCamera(camera: Camera, t: number): void {
  const yaw = flags.still ? 0 : ORBIT.swing * Math.sin(ORBIT.rate * t);
  const cp = Math.cos(ORBIT.pitch);
  eye[0] = TARGET[0] + ORBIT.distance * Math.sin(yaw) * cp;
  eye[1] = TARGET[1] + ORBIT.distance * Math.sin(ORBIT.pitch);
  eye[2] = TARGET[2] + ORBIT.distance * Math.cos(yaw) * cp;
  camera.lookAt(eye, TARGET);
}

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/** Screen position of the block's local point (unit cube coordinates) after its transform. */
function blockPoint(
  camera: Camera,
  lx: number,
  ly: number,
  lz: number,
  out: { x: number; y: number },
) {
  // v' = v + 2w (q × v) + 2 q × (q × v)
  const x = lx * BLOCK_SCALE;
  const y = ly * BLOCK_SCALE;
  const z = lz * BLOCK_SCALE;
  const cx = q.y * z - q.z * y;
  const cy = q.z * x - q.x * z;
  const cz = q.x * y - q.y * x;
  const ccx = q.y * cz - q.z * cy;
  const ccy = q.z * cx - q.x * cz;
  const ccz = q.x * cy - q.y * cx;
  world[0] = x + 2 * (q.w * cx + ccx) + BLOCK_POS[0];
  world[1] = y + 2 * (q.w * cy + ccy) + BLOCK_POS[1];
  world[2] = z + 2 * (q.w * cz + ccz) + BLOCK_POS[2];
  probe(camera, world[0], world[1], world[2], out);
}

/** Wraps the stack to publish the labels of the render and compute passes it began. */
class RecordingPost implements PostProcessor {
  private readonly labels: string[] = [];
  constructor(private readonly inner: PostStack) {}
  resize(width: number, height: number): void {
    this.inner.resize(width, height);
  }
  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void {
    const labels = this.labels;
    labels.length = 0;
    const proxy = new Proxy(encoder, {
      get(target, prop) {
        if (prop === 'beginRenderPass') {
          return (desc: GPURenderPassDescriptor) => {
            labels.push(String(desc.label ?? '').replace(/^pass:/, ''));
            return target.beginRenderPass(desc);
          };
        }
        if (prop === 'beginComputePass') {
          return (desc?: GPUComputePassDescriptor) => {
            labels.push(String(desc?.label ?? '').replace(/^pass:/, ''));
            return target.beginComputePass(desc);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    this.inner.encode(proxy, inputs, output, viewport);
    state.passes = labels.slice();
  }
}

function patchFor(): PostSettingsPatch {
  const patch: PostSettingsPatch = {
    fog: { enabled: false },
    godRays: { enabled: false },
    vignette: { enabled: false },
    grade: { dither: false },
  };
  if (flags.taa) patch.taa = { enabled: true, sharpen: 0 };
  if (flags.ssr) patch.ssr = { enabled: true, maxSteps: 48, maxDistance: 24, intensity: 1 };
  if (flags.autoexp) patch.exposure = { mode: 'auto' };
  if (flags.wb > 0) patch.whiteBalance = { temperature: flags.wb };
  if (flags.mblur) patch.motionBlur = { enabled: true };
  return patch;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine post 3 demo' });
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

  const post = new PostStack(renderer, patchFor());
  if (flags.dirt) {
    post.set({
      bloom: { dirt: { texture: createLensDirtTexture(gpu.device, 256, 7), intensity: 3 } },
    });
  }
  renderer.post = new RecordingPost(post);

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  placeCamera(camera, 0);

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const glow = renderer.createMaterial({ label: 'glow', blend: 'opaque', wgsl: GLOW_WGSL });
  const wall = renderer.createMaterial({ label: 'wall', blend: 'opaque', wgsl: WALL_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const floorMesh = renderer.createMesh({
    ...quadGeometry([0, 1, 0], [1, 0, 0], [0, 0, -1]),
    layout: VERTEX_LAYOUT_3D,
    label: 'floor',
  });
  const backMesh = renderer.createMesh({
    ...quadGeometry([0, 0, 1], [1, 0, 0], [0, 1, 0]),
    layout: VERTEX_LAYOUT_3D,
    label: 'backdrop',
  });
  const sideMesh = renderer.createMesh({
    ...quadGeometry([1, 0, 0], [0, 0, -1], [0, 1, 0]),
    layout: VERTEX_LAYOUT_3D,
    label: 'side',
  });

  setAxis();
  const floorT = new Transform({ scaleX: FLOOR_SIZE, scaleY: 1, scaleZ: FLOOR_SIZE });
  const blockT = new Transform({ x: BLOCK_POS[0], y: BLOCK_POS[1], z: BLOCK_POS[2] });
  blockT.setScale(BLOCK_SCALE, BLOCK_SCALE, BLOCK_SCALE);
  blockT.setQuaternion(q.x, q.y, q.z, q.w);
  const backT = new Transform({ y: 10, z: WALL_Z, scaleX: WALL_SIZE, scaleY: WALL_SIZE });
  const sideT = new Transform({ x: WALL_X, y: 10, scaleY: WALL_SIZE, scaleZ: WALL_SIZE });
  const skyT = new Transform({
    x: SKY_POS[0],
    y: SKY_POS[1],
    z: SKY_POS[2],
    scaleX: SKY_SIZE[0],
    scaleY: SKY_SIZE[1],
  });
  const floorP: InstanceParams = { tint: [...FLOOR_TINT, 1], params: [1, 0, 0, 0] };
  const blockP: InstanceParams = { tint: [...BLOCK_TINT, 1] };
  const wallP: InstanceParams = { tint: [...WALL_TOP, 1], params: [...WALL_BOTTOM, 0] };
  const skyP: InstanceParams = { tint: [...SKY_TINT, 1], params: [1, 0, 0, 0] };

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.dir = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  lights.fog.density = 0;

  const spin = { x: 0, y: 0, z: 0, w: 1 };
  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const t = flags.still ? 0 : time.realTime;
      placeCamera(camera, t);
      const half = (FLOOR_SPIN * t) / 2;
      spin.y = Math.sin(half);
      spin.w = Math.cos(half);
      floorT.setQuaternion(spin.x, spin.y, spin.z, spin.w);
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(WALL_TOP[0], WALL_TOP[1], WALL_TOP[2]);
      frame.lights = lights;
      frame.mesh(backMesh, wall, backT, wallP);
      frame.mesh(sideMesh, wall, sideT, wallP);
      frame.mesh(floorMesh, lit, floorT, floorP);
      frame.mesh(cube, lit, blockT, blockP);
      frame.mesh(cube, glow, skyT, skyP);
      renderer.endFrame();
      state.frames++;
      state.frameMs = time.frameDt * 1000;
      state.exposure = post.exposure;
      state.taaActive = post.taaActive;
      state.ssrActive = post.ssrActive;
      state.historyResets = post.historyResets;
      state.gpuErrors = gpuDiagnostics.errorCount;
      // The block's right silhouette: its +x/+z vertical edge, top to bottom.
      blockPoint(camera, 0.5, 0.5, 0.5, state.probes.edge.top);
      blockPoint(camera, 0.5, -0.5, 0.5, state.probes.edge.bottom);
      // The centre of the block's +z face.
      blockPoint(camera, 0, 0, 0.5, state.probes.grey);
      probe(camera, FLOOR_PROBE[0], FLOOR_PROBE[1], FLOOR_PROBE[2], state.probes.floor);
      probe(camera, BLOOM_PROBE[0], BLOOM_PROBE[1], BLOOM_PROBE[2], state.probes.bloom);
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
