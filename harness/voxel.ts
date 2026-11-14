/**
 * Voxel page (ws/voxel-render, moved onto the world by ws/voxel-draw): a 4×2×4-chunk block world
 * in an engine `VoxelGrid`, fed into `createVoxelWorld` (`feedVoxelGrid`), meshed in a Worker and
 * drawn through the retained core's GPU-culled sets; a first-person walk on `Look`.
 *
 * - The centre ray (`raycastVoxels` from the eye, 8 units) picks a block every frame.
 * - Mouse: click the canvas to take the pointer lock, then the mouse looks; WASD moves; the
 *   primary button breaks the picked block, the secondary places one against its face.
 * - Touch: a finger on the left half is a move stick, one on the right half drags the view; a
 *   tap on the right half breaks. `E` places on any row.
 * - `?still` parks the sun for pixel probes.
 *
 * Block faces are textured from a 3-layer `texture_2d_array` of generated pixels (grass, dirt,
 * stone): the page's material is a fragment over `VoxelVarying` that reads the block id with
 * `decode_voxel_vertex` and samples its layer.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { Input, Look } from '@thunderclap-engine/engine/input';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  createRenderCore,
  createRenderView,
  gpuDiagnostics,
  installGpuErrorLogging,
  loadTextureArray,
  type PixelSource,
  setViewFromCamera,
  sphereInPlanes,
} from '@thunderclap-engine/engine/render';
import {
  createVoxelGrid,
  createVoxelHit,
  createVoxelWorld,
  defineBlockTable,
  defineVoxelFormat,
  feedVoxelGrid,
  raycastVoxels,
  workerMesherPort,
} from '@thunderclap-engine/engine/voxel';
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

/** The world's blocks: air, then grass, dirt and stone, all opaque. */
const format = defineVoxelFormat({
  sectionSize: CHUNK,
  blocks: defineBlockTable([
    { class: 'none' },
    { class: 'opaque' },
    { class: 'opaque' },
    { class: 'opaque' },
  ]),
});

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
  sections: 0,
  drawn: 0,
  visible: 0,
  quads: 0,
  uploads: 0,
  calls: 0,
  settled: false,
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

/** The page's look: the block's layer of the array, the sun, sky light and AO. */
const BLOCKS_FRAGMENT = /* wgsl */ `
@group(1) @binding(0) var blockSampler: sampler;
@group(1) @binding(1) var blocks: texture_2d_array<f32>;
struct Sun { direction: vec4f, color: vec4f, ambient: vec4f };
@group(1) @binding(2) var<uniform> sun: Sun;

@fragment fn fs(in: VoxelVarying) -> @location(0) vec4f {
  let v = decode_voxel_vertex(in.w0, in.w1);
  let layer = max(i32(v.id) - 1, 0);
  let albedo = textureSample(blocks, blockSampler, fract(in.uv), layer).rgb;
  let n = in.normal;
  let lit = sun.ambient.rgb * (0.5 + 0.5 * n.y) + sun.color.rgb * max(dot(n, -sun.direction.xyz), 0.0);
  let ao = mix(0.5, 1.0, in.light.x);
  return vec4f(albedo * lit * ao, 1.0);
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

/** The material's bind group 1: sampler, the block array and the sun uniform. */
function createBlockLook(device: GPUDevice) {
  const array = loadTextureArray(device, blockLayers(), { label: 'blocks' });
  const sampler = device.createSampler({
    magFilter: 'nearest',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  const sun = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: 'sun',
  });
  const layout = device.createBindGroupLayout({
    label: 'blocks',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
    ],
  });
  const group = device.createBindGroup({
    label: 'blocks',
    layout,
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: array.view },
      { binding: 2, resource: { buffer: sun } },
    ],
  });
  const data = new Float32Array(12);
  return {
    bindGroups: [{ layout, group }],
    /** Sun direction (towards the ground), colour, ambient. */
    setSun(dir: readonly number[], color: readonly number[], ambient: readonly number[]): void {
      const l = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
      data.set([dir[0]! / l, dir[1]! / l, dir[2]! / l, 0, ...color, 0, ...ambient, 0]);
      device.queue.writeBuffer(sun, 0, data);
    },
  };
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
  const core = createRenderCore(gpu);

  const camera = Camera.perspective((60 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  const view = createRenderView();
  const views = [view];

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

  const blockLook = createBlockLook(gpu.device);
  const SUN_COLOR = [0.85, 0.82, 0.74];
  const AMBIENT = [0.28, 0.3, 0.34];
  blockLook.setSun([-0.45, -1.0, -0.55], SUN_COLOR, AMBIENT);
  const worker = new Worker(new URL('./voxel-worker.ts', import.meta.url), { type: 'module' });
  const world = createVoxelWorld(core, {
    format,
    workers: [workerMesherPort(worker)],
    materials: { opaque: { fragment: BLOCKS_FRAGMENT, bindGroups: blockLook.bindGroups } },
    radius: 4,
    label: 'voxel',
  });
  const source = feedVoxelGrid(world, grid);
  world.setInterest(SIZE_X / 2, SIZE_Y / 2, SIZE_Z / 2);
  // The grid chunks' spheres, for the CPU twin of the GPU cull (`state.visible`).
  const r = (CHUNK * Math.sqrt(3)) / 2;
  const target = {
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    clear: { r: 0.5, g: 0.68, b: 0.9, a: 1 },
  };

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
        blockLook.setSun(
          [Math.sin(dayTime) * 0.6 - 0.45, -1.0, Math.cos(dayTime) * 0.6 - 0.55],
          SUN_COLOR,
          AMBIENT,
        );
      }
      source.sync();
      world.update(eye[0]!, eye[1]!, eye[2]!);
    },
    render() {
      const { width, height } = surface.backbuffer;
      camera.setPerspective((60 * Math.PI) / 180, width / Math.max(1, height), 0.1, 200);
      placeCamera(camera);
      setViewFromCamera(view, camera);
      const texture = gpu.context.getCurrentTexture();
      target.view = texture.createView();
      target.width = texture.width;
      target.height = texture.height;
      const encoder = gpu.device.createCommandEncoder();
      core.prepare(encoder, views);
      core.draw(encoder, 0, target);
      gpu.device.queue.submit([encoder.finish()]);
      state.frames++;
      const s = world.stats;
      state.chunks = grid.chunkCount;
      state.sections = s.sections;
      state.drawn = s.drawn;
      state.quads = s.opaqueQuads + s.foliageQuads + s.liquidQuads;
      state.uploads = s.uploadsTotal;
      state.settled = world.settled;
      state.calls = core.stats.calls;
      let seen = 0;
      for (let cz = 0; cz < grid.chunksZ; cz++)
        for (let cy = 0; cy < grid.chunksY; cy++)
          for (let cx = 0; cx < grid.chunksX; cx++)
            if (
              sphereInPlanes(
                view.planes,
                0,
                (cx + 0.5) * CHUNK,
                (cy + 0.5) * CHUNK,
                (cz + 0.5) * CHUNK,
                r,
              )
            )
              seen++;
      state.visible = seen;
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
