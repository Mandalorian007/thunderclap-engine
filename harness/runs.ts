/**
 * Merged mesh runs page (ws/core-immediate): a sculpture garden of `?n=N` (default 1500)
 * distinct low-poly columns, each its own `Mesh` (a prism of 3 to 8 sides, its own height and
 * twist), drawn with `frame.mesh` under a camera circling the garden. The renderer merges the
 * stretch of distinct meshes into one run on its mesh pool: one bundle of indirect draws (or
 * one multi-draw) whatever N is. `?split` gives every column its own material so nothing merges,
 * the per-mesh path, for a pixel comparison; `?still` parks the camera.
 *
 * Nothing here is engine code beyond `boot` and the renderer.
 */
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  type Material,
  type Mesh,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessRunsState } from './runs-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const n = Math.max(1, Math.min(8192, Number(params.get('n') ?? 1500) | 0));
const split = params.has('split');
const still = params.has('still');

const state: HarnessRunsState = {
  ready: false,
  gpu: 'pending',
  meshes: n,
  split,
  frames: 0,
  gpuErrors: 0,
  runs: 0,
  drawCalls: 0,
  culled: 0,
  firstInstance: false,
  multiDraw: false,
};
window.__harnessRuns = { state };

const SHADE_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let light = 0.3 + 0.7 * max(dot(n, normalize(vec3f(0.5, 0.8, 0.2))), 0.0);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * light, 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** Seeded LCG in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A prism of `sides` sides, `height` tall, its top turned by `twist`: flat-shaded walls and a cap. */
function prism(sides: number, height: number, twist: number) {
  const verts: number[] = [];
  const idx: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    // VERTEX_LAYOUT_3D: position, normal, uv, colour (rgba).
    verts.push(x, y, z, nx, ny, nz, 0, 0, 1, 1, 1, 1);
    return verts.length / 12 - 1;
  };
  for (let s = 0; s < sides; s++) {
    const a0 = (s / sides) * Math.PI * 2;
    const a1 = ((s + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) / 2 + twist / 2;
    const nx = Math.cos(am);
    const nz = Math.sin(am);
    const b0 = push(Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5, nx, 0, nz);
    const b1 = push(Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5, nx, 0, nz);
    const t1 = push(Math.cos(a1 + twist) * 0.35, height, Math.sin(a1 + twist) * 0.35, nx, 0, nz);
    const t0 = push(Math.cos(a0 + twist) * 0.35, height, Math.sin(a0 + twist) * 0.35, nx, 0, nz);
    idx.push(b0, t0, t1, b0, t1, b1);
  }
  const centre = push(0, height, 0, 0, 1, 0);
  const ring: number[] = [];
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2 + twist;
    ring.push(push(Math.cos(a) * 0.35, height, Math.sin(a) * 0.35, 0, 1, 0));
  }
  for (let s = 0; s < sides; s++) idx.push(centre, ring[(s + 1) % sides]!, ring[s]!);
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idx) };
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Merged mesh runs' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const features = gpu.device.features as ReadonlySet<string>;
  state.firstInstance = features.has('indirect-first-instance');
  state.multiDraw = features.has('chromium-experimental-multi-draw-indirect');
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective(1.0, 16 / 9, 0.1, 300);
  camera.cull = true;
  const shared = renderer.createMaterial({ label: 'stone', blend: 'opaque', wgsl: SHADE_WGSL });
  const rand = lcg(7);
  const meshes: Mesh[] = [];
  const materials: Material[] = [];
  const places: Transform[] = [];
  const looks: InstanceParams[] = [];
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const g = prism(3 + Math.floor(rand() * 6), 0.6 + rand() * 2.4, rand() * 1.2);
    meshes.push(renderer.createMesh({ ...g, layout: VERTEX_LAYOUT_3D, label: `column${i}` }));
    materials.push(
      split
        ? renderer.createMaterial({ label: `stone${i}`, blend: 'opaque', wgsl: SHADE_WGSL })
        : shared,
    );
    places.push(
      new Transform({
        x: ((i % side) - side / 2) * 1.6 + rand() * 0.4,
        z: (Math.floor(i / side) - side / 2) * 1.6 + rand() * 0.4,
      }),
    );
    const t = 0.55 + rand() * 0.4;
    looks.push({ tint: [t, t * (0.85 + rand() * 0.15), t * (0.7 + rand() * 0.2), 1] });
  }
  state.gpu = 'ok';
  state.ready = true;

  let yaw = 0.6;
  const tick = (): void => {
    if (!still) yaw += 0.004;
    camera.setPerspective(
      1.0,
      surface.backbuffer.width / Math.max(1, surface.backbuffer.height),
      0.1,
      300,
    );
    camera.lookAt([Math.sin(yaw) * 20, 9, Math.cos(yaw) * 20], [0, 0, 0]);
    const frame = renderer.beginFrame(state.frames / 60, 1 / 60);
    frame.clear(0.08, 0.09, 0.11);
    for (let i = 0; i < n; i++) frame.mesh(meshes[i]!, materials[i]!, places[i]!, looks[i]);
    renderer.render(frame, camera);
    renderer.endFrame();
    state.frames++;
    state.runs = renderer.stats.runs;
    state.drawCalls = renderer.stats.drawCalls;
    state.culled = renderer.stats.culled;
    state.gpuErrors = gpuDiagnostics.errorCount;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((e: unknown) => {
  state.gpu = e instanceof Error ? e.message : String(e);
  state.ready = true;
});
