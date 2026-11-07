/**
 * Depth post page (ws/post-depth): the mesh page's scene, held still, through a `PostStack`
 * with ambient occlusion and depth of field on and everything else off. `?ao=0` and `?dof=0`
 * switch each pass off; with both off the stack reproduces the built-in present (Reinhard,
 * display encoding), so e2e/depth-post.spec.ts can compare its probes with mesh.html's.
 *
 * The page publishes which post passes ran (it wraps the command encoder the stack records
 * into) and the probes the spec samples: a ground crease at the foot of the far block, a pair
 * of far-ground patches across a checker edge, and the mesh page's near and far blocks.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { boot } from '@thunderclap/engine/platform';
import { PostStack } from '@thunderclap/engine/post';
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
import type { HarnessDepthPostApi, HarnessDepthPostState } from './depth-post-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const AO_ON = query.get('ao') !== '0';
const DOF_ON = query.get('dof') !== '0';

const state: HarnessDepthPostState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  aoEnabled: false,
  dofEnabled: false,
  passes: [],
  depth: false,
  probes: {
    near: { x: 0, y: 0 },
    far: { x: 0, y: 0 },
    crease: { x: 0, y: 0 },
    farGroundA: { x: 0, y: 0 },
    farGroundB: { x: 0, y: 0 },
    ground: { x: 0, y: 0 },
  },
  gpuErrors: 0,
};
const api: HarnessDepthPostApi = { state };
window.__harnessDepthPost = api;

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

// ------------------------------------------------------------------ the material (mesh.ts's)

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

const AMBIENT = [0.18, 0.18, 0.2] as const;
const SUN_DIR = [-0.45, -1.0, -0.65] as const;
const SUN_COLOR = [0.8, 0.8, 0.78] as const;
const LAMP_COLOR = [1.6, 0.9, 0.4] as const;
const LAMP_RADIUS = 5;
const LAMP_ORBIT = 3.2;
const LAMP_HEIGHT = 1.6;
const SHADOW_EXTENT = 20;
const SHADOW_SIZE = 2048;
const FOG_COLOR = [0.6, 0.65, 0.75] as const;
const FOG_NEAR = 6;
const FOG_FAR = 24;

// ------------------------------------------------------------------ the scene (mesh.ts's, still)

const TARGET = [0, 0.9, 0] as const;
const ORBIT = { yaw: 0, pitch: 0.2, distance: 9 };
/** The eye is about 8.8 units from the near block's front face: in focus; the far ground is not. */
const FOCUS_DISTANCE = 7;
const FOCUS_RANGE = 3;
const MAX_BLUR = 24;
const AO_RADIUS = 0.6;
const AO_INTENSITY = 2.5;

const eye = new Float32Array(3);
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function placeCamera(camera: Camera): void {
  const cp = Math.cos(ORBIT.pitch);
  eye[0] = TARGET[0] + ORBIT.distance * Math.sin(ORBIT.yaw) * cp;
  eye[1] = TARGET[1] + ORBIT.distance * Math.sin(ORBIT.pitch);
  eye[2] = TARGET[2] + ORBIT.distance * Math.cos(ORBIT.yaw) * cp;
  camera.lookAt(eye, TARGET);
}

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/**
 * Wraps the stack to publish what it recorded: whether it was given depth, and the labels of
 * the render passes it began (through a proxy over the command encoder).
 */
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
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    this.inner.encode(proxy, inputs, output, viewport);
    state.depth = inputs.depth !== null;
    state.passes = labels.slice();
  }
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine depth post demo' });
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

  // Everything but the depth passes off; the grade reproduces the built-in present.
  const post = new PostStack(renderer, {
    bloom: { enabled: false },
    mist: { enabled: false },
    godRays: { enabled: false },
    vignette: { enabled: false },
    grade: { tonemap: 'reinhard', saturation: 1, contrast: 1, dither: false },
    ao: { enabled: AO_ON, radius: AO_RADIUS, intensity: AO_INTENSITY },
    dof: {
      enabled: DOF_ON,
      focusDistance: FOCUS_DISTANCE,
      focusRange: FOCUS_RANGE,
      maxBlur: MAX_BLUR,
    },
  });
  renderer.post = new RecordingPost(post);

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

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.direction = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  // The lamp where mesh.ts starts it (spin 0), and left there.
  const lampPos = new Float32Array([TARGET[0] + LAMP_ORBIT, LAMP_HEIGHT, TARGET[2]]);
  lights.points.push({ position: lampPos, color: LAMP_COLOR, radius: LAMP_RADIUS });
  lights.sun.shadow = { extent: SHADOW_EXTENT, size: SHADOW_SIZE };
  lights.fog.color = FOG_COLOR;
  lights.fog.density = 1;
  lights.fog.near = FOG_NEAR;
  lights.fog.far = FOG_FAR;

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, near, nearP);
      frame.mesh(cube, lit, far, farP);
      frame.mesh(cube, lit, left, leftP);
      frame.mesh(cube, lit, right, rightP);
      renderer.endFrame();
      state.frames++;
      state.aoEnabled = post.settings.ao.enabled;
      state.dofEnabled = post.settings.dof.enabled;
      state.gpuErrors = gpuDiagnostics.errorCount;
      probe(camera, 0, 0.75, 2, state.probes.near);
      probe(camera, 0, 2.5, 0, state.probes.far);
      // Ground just in front of the far block's face (z = 0, x -1..1), clear of the near block.
      probe(camera, 0.8, 0, 0.12, state.probes.crease);
      // Far ground across the checker edge at x = -3 (floor(x) changes), mid-tile in z, 12 units out.
      probe(camera, -3.15, 0, -3.5, state.probes.farGroundA);
      probe(camera, -2.85, 0, -3.5, state.probes.farGroundB);
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
