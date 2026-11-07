/**
 * Finishing post page (ws/post-2): a hard-edged, flat-shaded cube tilted over a gradient
 * backdrop, held still, through a `PostStack` with everything off. `?pass=fxaa|lut|grain|
 * aberration|sharpen|outline` switches one finishing pass on (strongly, so a screenshot shows
 * it); without it the page is the baseline e2e/post2.spec.ts compares each pass against.
 *
 * The page publishes which post passes ran (it wraps the command encoder the stack records
 * into) and where to measure: the cube's right silhouette and the centre of its brighter face.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { boot } from '@thunderclap/engine/platform';
import { createLutTexture, type PostSettingsPatch, PostStack } from '@thunderclap/engine/post';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  type PostInputs,
  type PostProcessor,
  Renderer,
  type SceneTargetViewport,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import type { HarnessPost2Api, HarnessPost2State, Post2Pass } from './post2-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const PASSES: Post2Pass[] = ['none', 'fxaa', 'lut', 'grain', 'aberration', 'sharpen', 'outline'];
const wanted = new URLSearchParams(location.search).get('pass') ?? 'none';
const PASS: Post2Pass = (PASSES as string[]).includes(wanted) ? (wanted as Post2Pass) : 'none';

const state: HarnessPost2State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  pass: PASS,
  passes: [],
  depth: false,
  probes: {
    edge: { top: { x: 0, y: 0 }, bottom: { x: 0, y: 0 } },
    face: { x: 0, y: 0 },
    faceHalf: 0,
  },
  gpuErrors: 0,
};
const api: HarnessPost2Api = { state };
window.__harnessPost2 = api;

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

/** A unit quad in the XY plane (z = 0) facing +z, white; uv.y runs 0 at the top. */
function backdropGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array([
    ...[-0.5, -0.5, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1],
    ...[0.5, -0.5, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0.5, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0.5, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

// ------------------------------------------------------------------ materials (unlit, no fog)

/** The tint, shaded a little by the face normal against a fixed direction so faces differ. */
const FLAT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let k = 0.7 + 0.3 * max(dot(n, normalize(vec3f(0.4, 0.6, 1.0))), 0.0);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * k, 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** A vertical gradient between the instance tint (top) and `params.rgb` (bottom). */
const GRADIENT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = vec4f(mix(in.color.rgb, in.params.rgb, in.uv.y), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the scene, still

const CUBE_POS = [1.1, 0.1, 0] as const;
const CUBE_SCALE = 2.2;
/** Yaw with a tilt: every silhouette edge is diagonal, so FXAA and sharpen have steps to work on. */
const AXIS = [0.22, 1, 0.12] as const;
const ANGLE = Math.PI / 4;
const EYE = [0, 0, 7] as const;
const BACKDROP_Z = -6;
const BACKDROP_SIZE = 40;
const FACE_TINT = [0.95, 0.85, 0.3] as const;
const BACK_TOP = [0.05, 0.1, 0.35] as const;
const BACK_BOTTOM = [0.18, 0.3, 0.6] as const;

/** `?pass=` → the one section it switches on. */
const PATCHES: Record<Post2Pass, PostSettingsPatch> = {
  none: {},
  fxaa: { fxaa: { enabled: true, subpixel: 1, edgeThreshold: 0.063 } },
  lut: { lut: { size: 16, intensity: 1 } },
  grain: { grain: { intensity: 0.5, size: 2, luminanceResponse: 0, animated: false } },
  aberration: { aberration: { intensity: 8, radialOnly: false } },
  sharpen: { sharpen: { amount: 2 } },
  outline: {
    outline: {
      enabled: true,
      color: [0, 0, 0],
      thickness: 3,
      depthThreshold: 0.02,
      normalThreshold: 0.3,
      intensity: 1,
    },
  },
};

const q = { x: 0, y: 0, z: 0, w: 1 };
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
const world = new Float32Array(3);

function setAxis(): void {
  const len = Math.hypot(AXIS[0], AXIS[1], AXIS[2]);
  const s = Math.sin(ANGLE / 2);
  q.x = (AXIS[0] / len) * s;
  q.y = (AXIS[1] / len) * s;
  q.z = (AXIS[2] / len) * s;
  q.w = Math.cos(ANGLE / 2);
}

/** Screen position of the cube's local point (unit cube coordinates) after its transform. */
function cubePoint(
  camera: Camera,
  lx: number,
  ly: number,
  lz: number,
  out: { x: number; y: number },
) {
  // v' = v + 2w (q × v) + 2 q × (q × v)
  const x = lx * CUBE_SCALE;
  const y = ly * CUBE_SCALE;
  const z = lz * CUBE_SCALE;
  const cx = q.y * z - q.z * y;
  const cy = q.z * x - q.x * z;
  const cz = q.x * y - q.y * x;
  const ccx = q.y * cz - q.z * cy;
  const ccy = q.z * cx - q.x * cz;
  const ccz = q.x * cy - q.y * cx;
  world[0] = x + 2 * (q.w * cx + ccx) + CUBE_POS[0];
  world[1] = y + 2 * (q.w * cy + ccy) + CUBE_POS[1];
  world[2] = z + 2 * (q.w * cz + ccz) + CUBE_POS[2];
  camera.worldToScreen(world[0], world[1], world[2], probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

/** Wraps the stack to publish the labels of the render passes it began. */
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
  const res = await boot(root, { title: 'Engine finishing post demo' });
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

  // Everything off but the one pass asked for; no tonemap so the flat colours stay flat.
  const post = new PostStack(renderer, {
    bloom: { enabled: false },
    mist: { enabled: false },
    godRays: { enabled: false },
    vignette: { enabled: false },
    grade: { tonemap: 'none', saturation: 1, contrast: 1, dither: false },
    ...PATCHES[PASS],
  });
  if (PASS === 'lut') {
    // Red and blue swapped: the yellow face turns cyan-blue.
    post.set({ lut: { texture: createLutTexture(gpu.device, 16, (r, g, b) => [b, g, r]) } });
  }
  renderer.post = new RecordingPost(post);

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  camera.lookAt(EYE, [0, 0, 0]);

  const flat = renderer.createMaterial({ label: 'flat', blend: 'opaque', wgsl: FLAT_WGSL });
  const gradient = renderer.createMaterial({
    label: 'gradient',
    blend: 'opaque',
    wgsl: GRADIENT_WGSL,
  });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const backdrop = renderer.createMesh({
    ...backdropGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'backdrop',
  });

  setAxis();
  const cubeT = new Transform({ x: CUBE_POS[0], y: CUBE_POS[1], z: CUBE_POS[2] });
  cubeT.setScale(CUBE_SCALE, CUBE_SCALE, CUBE_SCALE);
  cubeT.setQuaternion(q.x, q.y, q.z, q.w);
  const backT = new Transform({ z: BACKDROP_Z, scaleX: BACKDROP_SIZE, scaleY: BACKDROP_SIZE });
  const cubeP: InstanceParams = { tint: [...FACE_TINT, 1] };
  const backP: InstanceParams = { tint: [...BACK_TOP, 1], params: [...BACK_BOTTOM, 0] };

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.1, 0.35);
      frame.mesh(backdrop, gradient, backT, backP);
      frame.mesh(cube, flat, cubeT, cubeP);
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
      // The right silhouette: the +x/+z vertical edge of the yawed cube, top to bottom.
      cubePoint(camera, 0.5, 0.5, 0.5, state.probes.edge.top);
      cubePoint(camera, 0.5, -0.5, 0.5, state.probes.edge.bottom);
      // The centre of the +z face, the brighter of the two visible ones.
      cubePoint(camera, 0, 0, 0.5, state.probes.face);
      state.probes.faceHalf = 40;
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
