/**
 * Mesh streaming page (ws/mesh-stream; VISION: Forgewilds' chunk meshes from Workers). Nothing
 * here is engine code: the mesher, the chunk grid and the lighting are what a game would write.
 *
 * - A grid of chunk `Mesh`es in `VERTEX_LAYOUT_3D`, each created with a capacity and filled by
 *   `mesh.update()` from an `ArrayBuffer` a Worker (harness/stream-worker.ts) built and
 *   transferred: the views hand the Worker's buffer straight to `queue.writeBuffer`, so the
 *   main thread copies nothing. The buffer then goes back to the Worker for the next re-mesh.
 * - One chunk is re-meshed per frame, round-robin, with a phase that moves its columns, so
 *   vertex counts change while the meshes keep their buffers (`growths` stays 0: the capacity
 *   is a full chunk).
 * - A fixed perspective camera; the HUD and `state.uploaded` show vertices uploaded per frame.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  type Mesh,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import {
  type HarnessStreamApi,
  type HarnessStreamState,
  STREAM_BUFFER_BYTES,
  STREAM_COLUMNS,
  STREAM_GRID,
  STREAM_INDEX_OFFSET,
  STREAM_MAX_INDICES,
  STREAM_MAX_VERTICES,
  STREAM_VERTEX_FLOATS,
  type StreamReply,
  type StreamRequest,
} from './stream-state';

const root = document.getElementById('root') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const CHUNKS = STREAM_GRID * STREAM_GRID;
/** A full chunk: every re-mesh fits, so the buffers are never reallocated (`growths` stays 0). */
const CAPACITY = { vertices: STREAM_MAX_VERTICES, indices: STREAM_MAX_INDICES };
const PHASE_PER_S = 1.5;

const state: HarnessStreamState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  chunks: CHUNKS,
  updates: 0,
  changed: 0,
  growths: 0,
  uploaded: { vertices: 0, indices: 0, peakVertices: 0 },
  vertexCounts: Array.from({ length: CHUNKS }, () => 0),
  probes: { ground: { x: 0, y: 0 }, sky: { x: 0, y: 0 } },
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
};
const api: HarnessStreamApi = { state };
window.__harnessStream = api;

/** Lambert + ambient from the world normal and the vertex colour. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let l = normalize(vec3f(0.45, 1.0, 0.65));
  let diffuse = max(dot(n, l), 0.0);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (0.18 + 0.12 * sky + 0.8 * diffuse), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const EYE = [0, 26, 30] as const;
const TARGET = [0, 0, 0] as const;
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine mesh streaming' });
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
  camera.lookAt(EYE, TARGET);
  renderer.camera = camera;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const meshes: Mesh[] = [];
  const transforms: Transform[] = [];
  const half = (STREAM_GRID * STREAM_COLUMNS) / 2;
  for (let c = 0; c < CHUNKS; c++) {
    meshes.push(
      renderer.createMesh({
        label: `chunk-${c}`,
        layout: VERTEX_LAYOUT_3D,
        capacity: CAPACITY,
      }),
    );
    transforms.push(
      new Transform({
        x: (c % STREAM_GRID) * STREAM_COLUMNS - half + STREAM_COLUMNS / 2,
        y: 0,
        z: Math.floor(c / STREAM_GRID) * STREAM_COLUMNS - half + STREAM_COLUMNS / 2,
      }),
    );
  }

  // The Worker and the chunk buffers. A buffer is either in flight (with the Worker) or in
  // `ready`, waiting to carry the next re-mesh request. Replies are applied as they arrive.
  const worker = new Worker(new URL('./stream-worker.ts', import.meta.url), { type: 'module' });
  const ready: StreamRequest[] = [];
  let next = 0;
  let phase = 0;
  let pendingVertices = 0;
  let pendingIndices = 0;
  worker.addEventListener('message', (e: MessageEvent<StreamReply>) => {
    const { chunk, buffer, vertexCount, indexCount } = e.data;
    const mesh = meshes[chunk]!;
    // Views over the transferred buffer: the upload reads them in place.
    mesh.update({
      vertices: new Float32Array(buffer, 0, vertexCount * STREAM_VERTEX_FLOATS),
      indices: new Uint16Array(buffer, STREAM_INDEX_OFFSET, indexCount),
      vertexCount,
      indexCount,
    });
    state.growths = meshes.reduce((n, m) => n + m.growths, 0);
    if (state.vertexCounts[chunk] !== vertexCount && state.updates >= CHUNKS) state.changed++;
    state.vertexCounts[chunk] = vertexCount;
    state.updates++;
    pendingVertices += vertexCount;
    pendingIndices += indexCount;
    ready.push({ chunk: next, phase, buffer });
    next = (next + 1) % CHUNKS;
  });
  for (let c = 0; c < CHUNKS; c++) {
    ready.push({ chunk: c, phase, buffer: new ArrayBuffer(STREAM_BUFFER_BYTES) });
  }
  next = 0;

  /** Send one re-mesh per frame; the queue holds a buffer whenever the Worker is idle. */
  function stream(): void {
    const req = ready.shift();
    if (!req) return;
    req.phase = phase;
    worker.postMessage(req, [req.buffer]);
  }

  // The first frame fills every chunk at once so the scene is complete from the start.
  while (ready.length > 0) stream();

  const loop = new GameLoop({
    update(dt) {
      phase += dt * PHASE_PER_S;
    },
    render(_alpha, time) {
      stream();
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      for (let c = 0; c < CHUNKS; c++) {
        // A chunk not yet meshed has nothing to draw (the renderer would issue an empty draw).
        if (meshes[c]!.indexCount > 0) frame.mesh(meshes[c]!, lit, transforms[c]!);
      }
      renderer.endFrame();
      state.frames++;
      state.uploaded.vertices = pendingVertices;
      state.uploaded.indices = pendingIndices;
      state.uploaded.peakVertices = Math.max(state.uploaded.peakVertices, pendingVertices);
      pendingVertices = 0;
      pendingIndices = 0;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      probe(camera, 0, 0, 0, state.probes.ground);
      probe(camera, 0, 0, -40, state.probes.sky);
      hud.textContent =
        `uploaded/frame: ${state.uploaded.vertices} vertices, ${state.uploaded.indices} indices\n` +
        `updates: ${state.updates}  growths: ${state.growths}  chunks: ${CHUNKS}`;
    },
  });
  res.onDeviceLost(() => {
    loop.stop();
    worker.terminate();
  });
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
