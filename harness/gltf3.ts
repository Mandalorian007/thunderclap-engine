/**
 * glTF extensions page (harness/gltf3.html, ws/assets-3): GLBs built in the page
 * (harness/gltf-writer.ts) through `parseGltf` and `loadGltf`, one mode per query:
 *
 * - `?quant` (the default): a `KHR_mesh_quantization` cube beside its float twin.
 * - `?meshopt`: a rock stored through `EXT_meshopt_compression`, checked against the plain file.
 * - `?lights`: a scene lit only by its own `KHR_lights_punctual` lights, seen through its own
 *   camera (`applyGltfCamera`).
 * - `?variants`: a figure cycling its three `KHR_materials_variants` each second (`setVariant`).
 * - `?cache`: ten assets loaded through `createAssetCache` into a budget of four.
 * - `?still` parks the time-driven part (the variant cycle stops on the second variant).
 *
 * Nothing here is engine code beyond the calls a game would make.
 */

import {
  type AssetReader,
  applyGltfCamera,
  createAssetCache,
  type GltfDocument,
  type GltfScene,
  loadGltf,
  parseGltf,
} from '@thunderclap-engine/engine/assets';
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  Renderer,
} from '@thunderclap-engine/engine/render';
import {
  buildCacheGlb,
  buildLightsGlb,
  buildMeshoptGlbs,
  buildQuantGlb,
  buildVariantsGlb,
  CACHE_ASSETS,
  cacheAssetX,
  LIGHTS_GROUND_HALF,
  LIGHTS_POINT_AT,
  LIGHTS_SPOT_AT,
  QUANT_CUBE_X,
  QUANT_CUBE_Y,
  ROCK_RADIUS,
  VARIANT_BODY_AT,
} from './gltf-writer';
import type { Gltf3Mode, HarnessGltf3State } from './gltf3-state';

const params = new URLSearchParams(location.search);
const MODES: readonly Gltf3Mode[] = ['quant', 'meshopt', 'lights', 'variants', 'cache'];
const MODE: Gltf3Mode = MODES.find((m) => params.has(m)) ?? 'quant';
const STILL = params.has('still');
/** `?still` parks the variant cycle here (the second variant: a swap away from the default). */
const STILL_VARIANT = 1;

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const CLEAR = [0.05, 0.07, 0.12] as const;

const state: HarnessGltf3State = {
  ready: false,
  gpu: 'pending',
  mode: MODE,
  still: STILL,
  frames: 0,
  logical: LOGICAL,
  warnings: [],
  maxError: -1,
  triangles: 0,
  match: false,
  bytes: { packed: 0, plain: 0 },
  lights: { directional: 0, points: 0, spots: 0, camera: false },
  variants: [],
  variant: null,
  materialId: null,
  seen: [],
  stats: { bytes: 0, entries: 0, hits: 0, misses: 0, evictions: 0 },
  budget: 0,
  resident: [],
  evicted: [],
  reads: 0,
  probes: {},
  clear: [CLEAR[0], CLEAR[1], CLEAR[2]],
  gpuErrors: 0,
};
window.__harnessGltf3 = { state };

type V3 = readonly [number, number, number];
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

/** World points the mode probes, refreshed into `state.probes` every frame. */
const probeAt: Record<string, V3> = {};

function parse(bytes: ArrayBuffer): GltfDocument {
  const doc = parseGltf(bytes);
  state.warnings.push(...doc.warnings);
  return doc;
}

/** World positions of a document's first primitive, through its node's 3×4 world matrix. */
function worldPositions(doc: GltfDocument, node: number): number[] {
  const n = doc.nodes[node]!;
  const m = n.world;
  const p = doc.meshes[n.mesh!]!.primitives[0]!.position;
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    for (let r = 0; r < 3; r++) {
      out.push(
        m[r * 4]! * p[i]! + m[r * 4 + 1]! * p[i + 1]! + m[r * 4 + 2]! * p[i + 2]! + m[r * 4 + 3]!,
      );
    }
  }
  return out;
}

function sameArray(a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean {
  if (!a || !b || a.length !== b.length) return a === b;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Same triangles in the same order, each up to rotation (winding kept): the meshopt index
 * codec may start a triangle at a different corner.
 */
function sameTriangles(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 3) {
    const a0 = a[i]!;
    const a1 = a[i + 1]!;
    const a2 = a[i + 2]!;
    let hit = false;
    for (let r = 0; r < 3 && !hit; r++) {
      hit = b[i + r] === a0 && b[i + ((r + 1) % 3)] === a1 && b[i + ((r + 2) % 3)] === a2;
    }
    if (!hit) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine glTF extensions demo' });
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
  renderer.camera = camera;
  const lights = new Lights();
  lights.ambient.set([0.25, 0.25, 0.28]);
  lights.sun.direction = [-0.4, -1.0, -0.6];
  lights.sun.color = [0.85, 0.85, 0.8];

  /** Scenes drawn each frame (`?cache`: the resident ones, filtered per frame). */
  const scenes: GltfScene[] = [];
  let tick: ((seconds: number) => void) | null = null;

  if (MODE === 'quant') {
    const doc = parse(buildQuantGlb());
    // Node 0 is quantized at -x, node 1 the float twin at +x: shift one onto the other and compare.
    const q = worldPositions(doc, 0);
    const f = worldPositions(doc, 1);
    let err = 0;
    for (let i = 0; i < q.length; i++) {
      const shift = i % 3 === 0 ? 2 * QUANT_CUBE_X : 0;
      err = Math.max(err, Math.abs(q[i]! + shift - f[i]!));
    }
    state.maxError = q.length === f.length ? err : Infinity;
    scenes.push(await loadGltf(renderer, doc, { label: 'quant' }));
    camera.lookAt([0, 2.2, 5], [0, QUANT_CUBE_Y, 0]);
    probeAt.quantized = [-QUANT_CUBE_X, QUANT_CUBE_Y, 0.5];
    probeAt.float = [QUANT_CUBE_X, QUANT_CUBE_Y, 0.5];
  } else if (MODE === 'meshopt') {
    const files = buildMeshoptGlbs();
    state.bytes.packed = files.packed.byteLength;
    state.bytes.plain = files.plain.byteLength;
    const plain = parse(files.plain);
    const packed = parse(files.packed);
    const a = plain.meshes[0]!.primitives[0]!;
    const b = packed.meshes[0]!.primitives[0]!;
    state.triangles = b.indices.length / 3;
    state.match =
      sameArray(a.position, b.position) &&
      sameArray(a.normal, b.normal) &&
      sameTriangles(a.indices, b.indices);
    scenes.push(await loadGltf(renderer, packed, { label: 'rock' }));
    camera.lookAt([0, 1.2, 4], [0, 0, 0]);
    probeAt.rock = [0, 0, ROCK_RADIUS * 0.75];
    probeAt.beside = [2.4, 0, 0];
  } else if (MODE === 'lights') {
    const doc = parse(buildLightsGlb());
    const scene = await loadGltf(renderer, doc, { label: 'lights' });
    scenes.push(scene);
    const l = scene.lights;
    state.lights = {
      directional: l.directional.length,
      points: l.points.length,
      spots: l.spots.length,
      camera: scene.cameras.length > 0,
    };
    // The file's lights replace the page's: a faint ambient, its directional as the sun.
    lights.ambient.set([0.03, 0.03, 0.03]);
    const sun = l.directional[0];
    lights.sun.direction = sun ? sun.direction : [0, -1, 0];
    lights.sun.color = sun ? sun.color : [0, 0, 0];
    lights.points.push(...l.points);
    lights.spots.push(...l.spots);
    const view = scene.cameras[0];
    if (view) applyGltfCamera(camera, view, LOGICAL.width / LOGICAL.height);
    probeAt.underPoint = [LIGHTS_POINT_AT[0], 0, LIGHTS_POINT_AT[2]];
    probeAt.underSpot = [LIGHTS_SPOT_AT[0], 0, LIGHTS_SPOT_AT[2]];
    probeAt.far = [0, 0, LIGHTS_GROUND_HALF * 0.75];
  } else if (MODE === 'variants') {
    const doc = parse(buildVariantsGlb());
    const scene = await loadGltf(renderer, doc, { label: 'figure' });
    scenes.push(scene);
    state.variants = [...scene.variants];
    const torso = scene.nodes.find((n) => n.node === 0)!;
    const show = (i: number) => {
      const name = scene.variants[i % scene.variants.length]!;
      if (scene.variant === name) return;
      scene.setVariant(name);
      state.variant = scene.variant;
      state.materialId = torso.materialIndex;
      if (!state.seen.includes(name)) state.seen.push(name);
    };
    show(STILL ? STILL_VARIANT : 0);
    if (!STILL) tick = (t) => show(Math.floor(t));
    camera.lookAt([0, 1.5, 4.5], [0, 1.1, 0]);
    probeAt.torso = [VARIANT_BODY_AT[0], VARIANT_BODY_AT[1], VARIANT_BODY_AT[2] + 0.25];
  } else {
    // Ten files in memory behind a game-style `read`; each is a cube at its own x.
    const files = new Map<string, ArrayBuffer>();
    for (let i = 0; i < CACHE_ASSETS; i++) files.set(`asset-${i}`, buildCacheGlb(i));
    const read: AssetReader = async (uri) => {
      state.reads++;
      const bytes = files.get(uri);
      if (!bytes) throw new Error(`no file ${uri}`);
      return bytes;
    };
    const sizeOf = (key: string) => files.get(key)!.byteLength;
    // Room for four assets: the pinned first one and the three the page holds at a time.
    const budget = Math.floor(sizeOf('asset-0') * 4.5);
    state.budget = budget;
    const cache = createAssetCache<GltfScene>({
      budgetBytes: budget,
      onEvict: (key, scene) => {
        scene.destroy();
        state.evicted.push(key);
      },
    });
    const loaded = new Map<string, GltfScene>();
    const get = (key: string) =>
      cache.acquire(
        key,
        async () => loadGltf(renderer, parse((await read(key)) as ArrayBuffer), { label: key }),
        () => sizeOf(key),
      );
    for (let i = 0; i < CACHE_ASSETS; i++) {
      const key = `asset-${i}`;
      if (i === 1) {
        // Two callers at once share one load (a hit, one read).
        const [a] = await Promise.all([get(key), get(key)]);
        cache.release(key);
        loaded.set(key, a);
      } else {
        loaded.set(key, await get(key));
      }
      if (i === 0) cache.pin(key);
      // Hold the newest three; older ones become evictable.
      if (i >= 3) cache.release(`asset-${i - 3}`);
    }
    state.stats = cache.stats;
    for (const [key, scene] of loaded) {
      if (cache.has(key)) {
        state.resident.push(key);
        scenes.push(scene);
      }
    }
    camera.lookAt([0, 2, 7], [0, 0.4, 0]);
    for (let i = 0; i < CACHE_ASSETS; i++) probeAt[`asset-${i}`] = [cacheAssetX(i), 0.4, 0.3];
    probeAt.background = [0, 2.6, 0];
  }
  for (const name of Object.keys(probeAt)) state.probes[name] = { x: 0, y: 0 };

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      tick?.(time.realTime);
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      for (const s of scenes) s.draw(frame);
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
      for (const name in probeAt) {
        const p = probeAt[name]!;
        camera.worldToScreen(p[0], p[1], p[2], probePoint);
        const out = state.probes[name]!;
        out.x = probePoint.x;
        out.y = probePoint.y;
      }
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
