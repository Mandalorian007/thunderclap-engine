/**
 * Render-core page (ws/core-retained): the retained core of `@thunderclap-engine/engine/render`
 * on its own. A block of `?sets=N` boxes (default 1500), each its own mesh in an arena of 8-byte
 * packed vertices drawn through the shared quad index, one instance each (origin, footprint,
 * height), all in one static GPU-culled draw set, under a camera circling the block. A held
 * frame is one view write, one cull dispatch and one `executeBundles`, whatever N is.
 *
 * `?still` parks the camera. `?far=D` (ws/core-views) moves the whole scene and the camera D
 * metres out on x and z (float64 on the CPU) and turns on the core's camera-relative origin
 * (`originGrid`, D1 §3.8): every slot's origin is the far corner, the view is written relative
 * to the snapped frame origin, and the shader adds `core_origin`, so the picture matches the one
 * at the origin. Nothing here is engine code beyond the core and `boot`.
 */
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  createInstanceLayout,
  createRenderCore,
  createRenderView,
  createVertexLayout,
  gpuDiagnostics,
  installGpuErrorLogging,
  setViewFromCamera,
  sphereInPlanes,
} from '@thunderclap-engine/engine/render';
import type { HarnessCoreState } from './core-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const sets = Math.max(1, Math.min(8192, Number(params.get('sets') ?? 1500) | 0));
const still = params.has('still');
/** How far out the scene sits on x and z, metres (0: at the origin). */
const far = Math.max(0, Number(params.get('far') ?? 0) || 0);

const state: HarnessCoreState = {
  ready: false,
  gpu: 'pending',
  sets,
  frames: 0,
  gpuErrors: 0,
  calls: 0,
  maxCalls: 0,
  bundles: 0,
  dispatches: 0,
  bundleBuilds: 0,
  visible: 0,
  cpuMs: 0,
  multiDraw: false,
  firstInstance: false,
  far,
  origin: [0, 0, 0],
};
window.__harnessCore = { state };

/**
 * The packed vertex: word 0 holds the corner (bits 0–2: x, y, z of the unit box) and the face
 * (bits 3–5), word 1 the colour as rgba8.
 */
const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
/** Per instance: x, z of the footprint's centre, its width and the height. */
const PLACE = createInstanceLayout({
  stride: 16,
  attributes: [{ name: 'place', format: 'float32x4', offset: 0 }],
});

/** The far page adds the slot's origin relative to the frame origin (`core_origin`). */
const LOCAL = far > 0 ? ' + in.core_origin' : '';

const SHADER = /* wgsl */ `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
};
const NORMALS = array<vec3f, 6>(
  vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
  vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0),
);
@vertex fn vs(in: VertexIn) -> Out {
  let w0 = in.packed.x;
  let corner = vec3f(f32(w0 & 1u), f32((w0 >> 1u) & 1u), f32((w0 >> 2u) & 1u));
  let n = NORMALS[(w0 >> 3u) & 7u];
  let p = vec3f(in.place.x + (corner.x - 0.5) * in.place.z, corner.y * in.place.w,
    in.place.y + (corner.z - 0.5) * in.place.z)${LOCAL};
  let c = unpack4x8unorm(in.packed.y).rgb;
  let light = 0.35 + 0.65 * max(dot(n, normalize(vec3f(0.4, 0.8, 0.3))), 0.0);
  var o: Out;
  o.clip = view.viewProj * vec4f(p, 1.0);
  o.color = c * light;
  return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f { return vec4f(in.color, 1.0); }
`;

/** The 24 corners of a box's six faces, counter-clockwise from outside, packed with `color`. */
function boxVertices(color: number): Uint32Array {
  // Each face: four corners as xyz bits, in quad order (0, 1, 2, 3 → triangles 0 1 2, 0 2 3).
  const FACES = [
    [0b001, 0b011, 0b111, 0b101], // +x
    [0b000, 0b100, 0b110, 0b010], // -x
    [0b010, 0b110, 0b111, 0b011], // +y
    [0b000, 0b001, 0b101, 0b100], // -y
    [0b100, 0b101, 0b111, 0b110], // +z
    [0b000, 0b010, 0b011, 0b001], // -z
  ];
  const out = new Uint32Array(48);
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      out[i * 2] = FACES[f]![k]! | (f << 3);
      out[i * 2 + 1] = color;
    }
  }
  return out;
}

/** A small deterministic hash in [0, 1). */
function rand(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Render core' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const core = createRenderCore(gpu, far > 0 ? { originGrid: 1024 } : {});
  state.multiDraw = core.caps.multiDraw;
  state.firstInstance = core.caps.firstInstance;

  const vertices = core.createArena({ kind: 'vertex', blockBytes: 4 << 20, label: 'boxes' });
  const instances = core.createArena({ kind: 'instance', blockBytes: 1 << 20, label: 'places' });
  const set = core.createDrawSet({
    label: 'block',
    shader: { code: SHADER },
    vertexLayout: PACKED,
    instanceLayout: PLACE,
    vertices,
    instances,
    capacity: 8192,
    kind: 'static',
    cull: 'gpu',
  });
  const side = Math.ceil(Math.sqrt(sets));
  const spacing = 6;
  const half = (side * spacing) / 2;
  const place = new Float32Array(4);
  const spheres = new Float32Array(sets * 4);
  const origin = far > 0 ? [far, 0, far] : undefined;
  for (let i = 0; i < sets; i++) {
    const x = (i % side) * spacing - half;
    const z = Math.floor(i / side) * spacing - half;
    const w = 2.5 + rand(i) * 2;
    const h = 2 + rand(i + 7919) ** 3 * 30;
    const shade = 0.45 + rand(i + 104729) * 0.5;
    const r = (shade * 200) | 0;
    const g = (shade * 190) | 0;
    const b = (shade * 170 + 40) | 0;
    const v = vertices.alloc(24 * 8, 8);
    vertices.write(v, boxVertices(r | (g << 8) | (b << 16) | (255 << 24)));
    const inst = instances.alloc(16, 16);
    place.set([x, z, w, h]);
    instances.write(inst, place);
    const radius = Math.hypot(w * 0.75, h / 2, w * 0.75);
    spheres.set([x, h / 2, z, radius], i * 4);
    set.add({
      vertices: v,
      indexCount: 36,
      instances: inst,
      bounds: spheres.subarray(i * 4, i * 4 + 4),
      origin,
    });
  }

  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.5, 2000);
  const view = createRenderView();
  const views = [view];
  /** The eye in float64, `far` out: the camera's basis is local, its position is not. */
  const eye = new Float64Array(3);
  const times: number[] = [];
  const target = {
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    clear: { r: 0.05, g: 0.06, b: 0.09, a: 1 },
  };
  state.gpu = 'ok';
  state.ready = true;
  const start = performance.now();

  const frame = () => {
    const t = still ? 0 : (performance.now() - start) / 1000;
    const { width, height } = surface.backbuffer;
    camera.setPerspective(Math.PI / 3, width / Math.max(1, height), 0.5, 2000);
    const a = t * 0.15;
    const dist = half * 0.9 + 40;
    const ex = Math.cos(a) * dist;
    const ey = 25 + half * 0.3;
    const ez = Math.sin(a) * dist;
    camera.lookAt([ex, ey, ez], [0, 0, 0]);
    eye[0] = ex + far;
    eye[1] = ey;
    eye[2] = ez + far;
    setViewFromCamera(view, camera, far > 0 ? eye : undefined);
    const texture = gpu.context.getCurrentTexture();
    target.view = texture.createView();
    target.width = texture.width;
    target.height = texture.height;
    const t0 = performance.now();
    const encoder = gpu.device.createCommandEncoder();
    core.prepare(encoder, views);
    core.draw(encoder, 0, target);
    gpu.device.queue.submit([encoder.finish()]);
    times.push(performance.now() - t0);
    if (times.length > 60) times.shift();
    const st = core.stats;
    state.calls = st.calls;
    if (state.frames > 0) state.maxCalls = Math.max(state.maxCalls, st.calls);
    state.bundles = st.bundles;
    state.dispatches = st.dispatches;
    state.bundleBuilds = st.bundleBuilds;
    state.origin[0] = core.origin[0]!;
    state.origin[1] = core.origin[1]!;
    state.origin[2] = core.origin[2]!;
    let seen = 0;
    for (let i = 0; i < sets; i++) {
      const o = i * 4;
      if (
        sphereInPlanes(
          view.planes,
          0,
          spheres[o]!,
          spheres[o + 1]!,
          spheres[o + 2]!,
          spheres[o + 3]!,
        )
      )
        seen++;
    }
    state.visible = seen;
    state.cpuMs = [...times].sort((p, q) => p - q)[times.length >> 1]!;
    state.gpuErrors = gpuDiagnostics.errorCount;
    state.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  state.gpu = e instanceof Error ? e.message : String(e);
  state.ready = true;
});
