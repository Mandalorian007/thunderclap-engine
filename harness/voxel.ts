/**
 * Voxel page (ws/voxel-render): a 4×2×4-chunk procedural block world through
 * `@thunderclap/engine/voxel`, meshed in a Worker and drawn one chunk mesh at a time after a
 * frustum test; a first-person walk on `Look`.
 *
 * - The centre ray (`raycastVoxels` from the eye, 8 units) picks a block every frame.
 * - Mouse: click the canvas to take the pointer lock, then the mouse looks; WASD moves; the
 *   primary button breaks the picked block, the secondary places one against its face.
 * - Touch: a finger on the left half is a move stick, one on the right half drags the view; a
 *   tap on the right half breaks. `E` places on any row.
 * - `?still` parks the sun for pixel probes.
 *
 * Block faces are textured from a 3-layer `texture_2d_array` of generated pixels (grass, dirt,
 * stone), the layer read from the vertex colour's alpha through the `VOXEL_WGSL` prelude.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { Input, Look } from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  loadTextureArray,
  type Material,
  type PixelSource,
  Renderer,
} from '@thunderclap/engine/render';
import {
  createVoxelChunks,
  createVoxelGrid,
  createVoxelHit,
  createVoxelMesher,
  raycastVoxels,
  VOXEL_WGSL,
} from '@thunderclap/engine/voxel';
import type { HarnessVoxelApi, HarnessVoxelState } from './voxel-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const STILL = query.has('still');

const SIZE_X = 64;
const SIZE_Y = 32;
const SIZE_Z = 64;
const CHUNK = 16;
const GRASS = 1;
const DIRT = 2;
const STONE = 3;
const EYE_HEIGHT = 1.7;
const REACH = 8;
const WALK_PER_S = 4;
const PITCH_LIMIT = 1.4;
const TAP_MS = 250;

const state: HarnessVoxelState = {
  ready: false,
  still: STILL,
  gpu: 'pending',
  frames: 0,
  yaw: 0,
  pitch: -0.45,
  position: [32.5, 0, 36.5],
  locked: false,
  chunks: 0,
  drawn: 0,
  culled: 0,
  triangles: 0,
  growths: 0,
  remeshes: 0,
  remeshMs: 0,
  hit: null,
  broken: 0,
  placed: 0,
  gpuErrors: 0,
};

/** The terrain height at a column: rolling hills between 8 and 16, deterministic. */
function terrainHeight(x: number, z: number): number {
  const h =
    12 +
    2.5 * Math.sin(x * 0.21) +
    2 * Math.cos(z * 0.17 + x * 0.05) +
    1.2 * Math.sin((x + z) * 0.37);
  return Math.max(2, Math.min(SIZE_Y - 4, Math.round(h)));
}

const BLOCKS_WGSL = /* wgsl */ `
${VOXEL_WGSL}
@group(1) @binding(1) var blockSampler: sampler;
@group(1) @binding(2) var blocks: texture_2d_array<f32>;

@fragment fn fs_main(in: VSOut) -> FragOut {
  let albedo = textureSample(blocks, blockSampler, voxel_uv_wrap(in.uv), voxel_layer(in.color)).rgb;
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  let lit = engine_lambert(n, in.worldPos) + 0.15 * sky;
  var o: FragOut;
  o.color = vec4f(albedo * lit * voxel_ao(in.color), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** sRGB base colours of the block layers, in `layerOf` order (block − 1): grass, dirt, stone. */
const LAYER_COLOURS = [
  [112, 186, 84],
  [150, 108, 70],
  [128, 130, 136],
] as const;
const LAYER_SIZE = 16;

/** The block faces as generated pixels: a jittered 16×16 layer per colour with a darker rim. */
function blockLayers(): PixelSource[] {
  return LAYER_COLOURS.map((rgb, layer) => {
    const data = new Uint8Array(LAYER_SIZE * LAYER_SIZE * 4);
    for (let y = 0; y < LAYER_SIZE; y++) {
      for (let x = 0; x < LAYER_SIZE; x++) {
        const h = Math.sin(x * 12.9898 + y * 78.233 + layer * 37.719) * 43758.5453;
        const rim = x === 0 || y === 0 || x === LAYER_SIZE - 1 || y === LAYER_SIZE - 1;
        const k = rim ? 0.8 : 0.86 + 0.14 * (h - Math.floor(h));
        const o = (y * LAYER_SIZE + x) * 4;
        data[o] = rgb[0] * k;
        data[o + 1] = rgb[1] * k;
        data[o + 2] = rgb[2] * k;
        data[o + 3] = 255;
      }
    }
    return { width: LAYER_SIZE, height: LAYER_SIZE, data };
  });
}

function createBlockMaterial(renderer: Renderer): Material {
  const array = loadTextureArray(renderer.device, blockLayers(), { label: 'blocks' });
  const material = renderer.createMaterial({
    label: 'blocks',
    blend: 'opaque',
    wgsl: BLOCKS_WGSL,
    textures: 1,
    viewDimension: '2d-array',
    sampler: 'nearest-mip-repeat',
  });
  material.setTexture(0, array);
  return material;
}

const look = new Look({
  keys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
});

const eye = new Float32Array(3);
const target = new Float32Array(3);
const forward = new Float32Array(3);

function placeCamera(camera: Camera): void {
  const cp = Math.cos(state.pitch);
  eye[0] = state.position[0];
  eye[1] = state.position[1];
  eye[2] = state.position[2];
  // Yaw 0 looks down -z; positive yaw turns right (towards +x).
  forward[0] = Math.sin(state.yaw) * cp;
  forward[1] = Math.sin(state.pitch);
  forward[2] = -Math.cos(state.yaw) * cp;
  target[0] = eye[0] + forward[0];
  target[1] = eye[1] + forward[1];
  target[2] = eye[2] + forward[2];
  camera.lookAt(eye, target);
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine voxel demo' });
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

  const camera = Camera.perspective((60 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;

  // The world: a grid of 4 × 2 × 4 chunks, hills of stone under dirt under a grass top.
  const grid = createVoxelGrid({ sizeX: SIZE_X, sizeY: SIZE_Y, sizeZ: SIZE_Z, chunk: CHUNK });
  grid.fill((x, y, z) => {
    const h = terrainHeight(x, z);
    if (y >= h) return 0;
    if (y === h - 1) return GRASS;
    return y >= h - 4 ? DIRT : STONE;
  });
  state.position[1] = terrainHeight(32, 36) + EYE_HEIGHT;
  placeCamera(camera);

  const material = createBlockMaterial(renderer);
  const worker = new Worker(new URL('./voxel-worker.ts', import.meta.url), { type: 'module' });
  const mesher = createVoxelMesher(grid, { worker });
  const chunks = createVoxelChunks(renderer, grid, { material, mesher, slack: 1.5 });

  const lights = new Lights();
  lights.ambient.set([0.28, 0.3, 0.34]);
  lights.sun.direction = [-0.45, -1.0, -0.55];
  lights.sun.color = [0.85, 0.82, 0.74];

  const hit = createVoxelHit();
  const hitCell: [number, number, number] = [0, 0, 0];
  let hitOk = false;

  const breakBlock = (): boolean => {
    if (!hitOk) return false;
    if (!grid.set(hit.x, hit.y, hit.z, 0)) return false;
    state.broken++;
    return true;
  };
  const placeBlock = (): boolean => {
    if (!hitOk || (hit.nx === 0 && hit.ny === 0 && hit.nz === 0)) return false;
    // Not into the cell the eye stands in, nor the one under it.
    const ex = Math.floor(eye[0]);
    const ez = Math.floor(eye[2]);
    const ey = Math.floor(eye[1]);
    if (hit.px === ex && hit.pz === ez && (hit.py === ey || hit.py === ey - 1)) return false;
    if (!grid.set(hit.px, hit.py, hit.pz, DIRT)) return false;
    state.placed++;
    return true;
  };

  const api: HarnessVoxelApi = {
    state,
    aim: (yaw, pitch) => {
      state.yaw = yaw;
      state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    },
    break: breakBlock,
    place: placeBlock,
  };
  window.__harnessVoxel = api;

  const input = new Input({}, { look });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  // Mouse: the first click takes the pointer lock (a gesture is required), every primary
  // click breaks, the secondary places. Touch: a tap (no drag) on the right half breaks.
  let tapStart = 0;
  let tapX = 0;
  let tapY = 0;
  surface.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  surface.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') {
      if (!look.locked) void look.request();
      if (e.button === 0) breakBlock();
      else if (e.button === 2) placeBlock();
      return;
    }
    tapStart = performance.now();
    tapX = e.clientX;
    tapY = e.clientY;
  });
  surface.canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    const moved = Math.hypot(e.clientX - tapX, e.clientY - tapY);
    const half = surface.canvas.getBoundingClientRect();
    const right = e.clientX - half.left > half.width / 2;
    if (right && moved < 12 && performance.now() - tapStart < TAP_MS) breakBlock();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE' && !e.repeat) placeBlock();
  });

  let dayTime = 0;
  const loop = new GameLoop({
    update(dt) {
      input.update();
      state.yaw += look.look.dx;
      state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch + look.look.dy));
      const fx = Math.sin(state.yaw);
      const fz = -Math.cos(state.yaw);
      const step = WALK_PER_S * dt;
      state.position[0] += (fx * look.move.y + -fz * look.move.x) * step;
      state.position[2] += (fz * look.move.y + fx * look.move.x) * step;
      state.locked = look.locked;
      placeCamera(camera);
      hitOk = raycastVoxels(
        grid,
        eye[0]!,
        eye[1]!,
        eye[2]!,
        forward[0]!,
        forward[1]!,
        forward[2]!,
        REACH,
        hit,
      );
      if (hitOk) {
        hitCell[0] = hit.x;
        hitCell[1] = hit.y;
        hitCell[2] = hit.z;
        state.hit = hitCell;
      } else {
        state.hit = null;
      }
      if (!STILL) {
        dayTime += dt * 0.05;
        lights.sun.direction = [
          Math.sin(dayTime) * 0.6 - 0.45,
          -1.0,
          Math.cos(dayTime) * 0.6 - 0.55,
        ];
      }
      chunks.update();
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.5, 0.68, 0.9);
      frame.lights = lights;
      chunks.draw(frame, camera);
      renderer.endFrame();
      state.frames++;
      const s = chunks.stats;
      state.chunks = s.chunks;
      state.drawn = s.drawn;
      state.culled = s.culled;
      state.triangles = s.triangles;
      state.growths = s.growths;
      state.remeshes = s.remeshes;
      state.remeshMs = s.remeshMs;
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
