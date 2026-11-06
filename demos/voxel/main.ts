/**
 * Voxel demo: a small Forgewilds-class world, the voxel path end to end with the mesher in the
 * game.
 *
 * - 8×8 columns of 16³ chunks, 64 high (256 chunks), generated from 2D value noise with caves
 *   and trees in the mesher Worker (`mesher.worker.ts`), which greedy-meshes every chunk into
 *   `VERTEX_LAYOUT_3D` with baked per-vertex ambient occlusion and transfers the buffers back.
 *   The page hands them to `Mesh.update` and draws each chunk under its own `Transform`.
 * - One material over a texture array of eight canvas-painted block textures, sampled by the
 *   per-vertex layer (the vertex colour's alpha; the AO rides in its rgb), lit by `engine_lambert`
 *   with the sun's shadow on the near chunks, fogged by `engine_fog`. Glowstone is emissive and
 *   flickers (`flicker`) into the bloom.
 * - A day cycle drives the sun and `Sky`; `Water` sits at sea level in a second view of the
 *   same camera so its shoreline reads this frame's depth.
 * - First person: WASD + mouse look under the pointer lock, Bedrock-style touch (left half is
 *   the move stick, the right half looks, tap breaks, long-press places), pad sticks and
 *   triggers. A DDA voxel ray from the eye picks the block under the reticle; break and place
 *   re-mesh the touched chunk and its boundary neighbours.
 *
 * Nothing here is engine code: the grid, noise, mesher, ray and chunk bookkeeping are what a
 * voxel game writes (VISION rule 5). `?still` parks the day cycle, `?time=0.25` sets it.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { flicker, Sky, Water } from '@thunderclap/engine/fx';
import { Gestures, Input, Look } from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import { PostStack } from '@thunderclap/engine/post';
import {
  Camera,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  loadTextureArray,
  type Mesh,
  type MeshBounds,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import { createOverlay } from '@thunderclap/engine/ui';
import { blockIcon, paintBlockTextures } from './textures';
import {
  Block,
  blockAt,
  blockLayer,
  CHUNK,
  CHUNK_COUNT,
  CHUNK_RADIUS,
  chunkCoords,
  chunksTouching,
  HOTBAR,
  inWorld,
  type MesherReply,
  type MesherRequest,
  REACH,
  raycastVoxels,
  SEED,
  spawnColumn,
  type VoxelDemoApi,
  type VoxelDemoState,
  type VoxelHit,
  voxelIndex,
  WATER_HEIGHT,
  WORLD_ORIGIN,
  WORLD_X,
  WORLD_Z,
} from './world';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const params = new URLSearchParams(location.search);
const STILL = params.has('still');
const START_TIME = params.has('time') ? Number(params.get('time')) : 0.22;

/** Seconds per day. */
const DAY_SECONDS = 180;
const PITCH_LIMIT = 1.5;
/** The player: a box `2 × HALF` wide and `HEIGHT` tall standing on its feet, eye `EYE_HEIGHT` up. */
const HALF = 0.3;
const HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const GRAVITY = 24;
const JUMP_SPEED = 8.4;
const WALK_SPEED = 4.4;
const SWIM_SPEED = 2.2;
const SKIN = 1e-3;
/** The sun's shadow box, centred on the camera: the near chunks. */
const SHADOW = { extent: 40, size: 2048 as const, bias: 0.002 };
const FOG_NEAR = 44;
const FOG_FAR = 128;
/** Bounding sphere of every chunk mesh, in chunk space. */
const CHUNK_BOUNDS: MeshBounds = {
  center: [CHUNK / 2, CHUNK / 2, CHUNK / 2],
  radius: CHUNK_RADIUS,
};

const state: VoxelDemoState = {
  ready: false,
  gpu: 'pending',
  frame: 0,
  fps: 0,
  stats: { drawCalls: 0, instances: 0, culled: 0, shadowDraws: 0 },
  chunks: 0,
  chunksDrawn: 0,
  chunksCulled: 0,
  chunksSolid: 0,
  drawCalls: 0,
  triangles: 0,
  remeshMs: -1,
  edits: 0,
  growths: 0,
  playerPos: [0, 48, 0],
  yaw: 0,
  pitch: 0,
  selectedBlock: HOTBAR[0]!,
  selectedSlot: 0,
  lookingAt: null,
  timeOfDay: Number.isFinite(START_TIME) ? ((START_TIME % 1) + 1) % 1 : 0.22,
  still: STILL,
  locked: false,
  gpuErrors: 0,
};

/**
 * The block material. The layer is a whole number in the vertex colour's alpha (the engine's
 * texture-array convention), the baked AO in its rgb. The sampler kinds offer no nearest +
 * mips + repeat, so the uv (block units, so textures tile across a merged quad) is wrapped by
 * hand and the mip level comes from the unwrapped uv's derivatives.
 */
const BLOCKS_WGSL = /* wgsl */ `
struct VoxelParams { glow: vec4f };
@group(1) @binding(0) var<uniform> u: VoxelParams;
@group(1) @binding(1) var blockSampler: sampler;
@group(1) @binding(2) var blocks: texture_2d_array<f32>;

@fragment fn fs_main(in: VSOut) -> FragOut {
  let layer = u32(round(in.color.a));
  let wrapped = fract(in.uv);
  let albedo = textureSampleGrad(blocks, blockSampler, wrapped, layer, dpdx(in.uv), dpdy(in.uv)).rgb;
  let ao = in.color.r;
  let n = normalize(in.normal);
  let lit = engine_lambert(n, in.worldPos) * ao;
  var color = albedo * lit;
  var emissive = vec3f(0.0);
  if (layer == 7u) {
    // Glowstone: self-lit, and its glow (flickering through u.glow.x) goes to the bloom.
    color = albedo * (0.55 + 0.45 * u.glow.x) + color * 0.25;
    emissive = albedo * u.glow.x;
  }
  var o: FragOut;
  o.color = vec4f(engine_fog(color, in.worldPos), 1.0);
  o.emissive = vec4f(emissive, 0.0);
  return o;
}`;

/** One chunk: its mesh (made on the first reply), its placement and what its mesh holds. */
interface ChunkRecord {
  mesh: Mesh | null;
  transform: Transform;
  indexCount: number;
  /** World centre of the chunk, for the frustum test. */
  cx: number;
  cy: number;
  cz: number;
}

const smooth01 = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
const mix3 = (out: Float32Array, a: readonly number[], b: readonly number[], t: number) => {
  out[0] = a[0]! + (b[0]! - a[0]!) * t;
  out[1] = a[1]! + (b[1]! - a[1]!) * t;
  out[2] = a[2]! + (b[2]! - a[2]!) * t;
};

const SUN_NOON = [1.0, 0.96, 0.88];
const SUN_LOW = [1.0, 0.45, 0.18];
const AMBIENT_DAY = [0.36, 0.4, 0.48];
const AMBIENT_NIGHT = [0.05, 0.06, 0.1];
const FOG_DAY = [0.62, 0.72, 0.9];
const FOG_LOW = [0.75, 0.5, 0.42];
const FOG_NIGHT = [0.02, 0.025, 0.05];

async function main(): Promise<void> {
  const res = await boot(root, { title: 'ThunderClap demo: voxel' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);

  const camera = Camera.perspective((75 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;

  // Post: bloom for the glowstone and the sun's glint on the water; the engine's own fog is in
  // the material (`engine_fog`), so the post fog and god rays stay off.
  const post = new PostStack(renderer, {
    bloom: { enabled: true, intensity: 0.55, threshold: 1.0, knee: 0.5, emissiveWeight: 1.4 },
    fog: { enabled: false },
    godRays: { enabled: false },
    vignette: { enabled: true, intensity: 0.22 },
    grade: { enabled: true, tonemap: 'aces', exposure: 1.0 },
  });
  renderer.post = post;

  // The overlay: a reticle, the hotbar and a toast with the controls.
  const ui = createOverlay({ parent: root });
  ui.setFrame(surface.rect);
  surface.onResize(({ backbuffer, rect }) => {
    renderer.resize(backbuffer.width, backbuffer.height);
    ui.setFrame(rect);
  });
  const reticle = ui.reticle({ style: 'cross', size: 18, gap: 4, color: '#fff' });
  reticle.el.id = 'reticle';
  const textures = paintBlockTextures();
  const hotbar = ui.slots({
    count: HOTBAR.length,
    hints: HOTBAR.map((_, i) => String(i + 1)),
    selected: 0,
    size: 56,
    label: 'Blocks',
  });
  hotbar.el.id = 'hotbar';
  HOTBAR.forEach((block, i) => {
    hotbar.setContent(i, blockIcon(textures[blockLayer(block, 0)]!, 48));
  });
  function selectSlot(i: number): void {
    hotbar.select(i);
    state.selectedSlot = hotbar.selected;
    state.selectedBlock = HOTBAR[hotbar.selected]!;
  }

  // The block textures as one array with GPU mips; the material samples them by layer.
  const blockArray = loadTextureArray(gpu.device, textures, { label: 'blocks', mips: true });
  const material = renderer.createMaterial({
    label: 'blocks',
    blend: 'opaque',
    wgsl: BLOCKS_WGSL,
    textures: 1,
    viewDimension: '2d-array',
    sampler: 'nearest-mip-clamp',
    uniformBytes: 16,
  });
  material.setTexture(0, blockArray);
  const glow = new Float32Array(4);

  const sky = new Sky(renderer, { stars: true });
  const water = new Water(renderer, {
    size: WORLD_X,
    segments: 32,
    level: WATER_HEIGHT,
    displace: 0.06,
    roughness: 0.14,
    depthFade: 5,
    foam: { width: 0.35 },
  });

  const lights = new Lights();
  const sunDir = new Float32Array(3);
  const sunColor = new Float32Array(3);
  const ambient = new Float32Array(3);
  lights.sun.dir = sunDir;
  lights.sun.color = sunColor;
  const fogColor = new Float32Array(3);
  lights.fog.color = fogColor;
  lights.fog.density = 1;
  lights.fog.near = FOG_NEAR;
  lights.fog.far = FOG_FAR;

  /** Place the sun, the ambient and the fog for `state.timeOfDay`. */
  function placeSun(): void {
    const phi = 2 * Math.PI * state.timeOfDay;
    // The sun rises at +x, passes a little south (+z) of overhead and sets at -x.
    const sx = Math.cos(phi) * 0.9;
    const sy = Math.sin(phi);
    const sz = 0.4 * Math.cos(phi) + 0.35;
    const len = Math.hypot(sx, sy, sz);
    sunDir[0] = -sx / len;
    sunDir[1] = -sy / len;
    sunDir[2] = -sz / len;
    const elevation = sy / len;
    const daylight = smooth01((elevation + 0.08) / 0.3);
    const high = smooth01(elevation / 0.6);
    mix3(sunColor, SUN_LOW, SUN_NOON, high);
    sunColor[0]! *= 1.3 * daylight;
    sunColor[1]! *= 1.3 * daylight;
    sunColor[2]! *= 1.3 * daylight;
    mix3(ambient, AMBIENT_NIGHT, AMBIENT_DAY, daylight);
    lights.ambient.set(ambient);
    const dusk = smooth01(1 - Math.abs(elevation) / 0.25);
    mix3(fogColor, FOG_NIGHT, FOG_DAY, daylight);
    fogColor[0]! += (FOG_LOW[0]! - fogColor[0]!) * dusk * 0.6;
    fogColor[1]! += (FOG_LOW[1]! - fogColor[1]!) * dusk * 0.6;
    fogColor[2]! += (FOG_LOW[2]! - fogColor[2]!) * dusk * 0.6;
    // No shadow once the sun is down: a map from under the ground would be wrong.
    lights.sun.shadow = elevation > 0.03 ? SHADOW : null;
  }

  // The chunks: a record each, the mesh made on the first reply (sized to its first contents,
  // `Mesh.update` grows it 1.5× if an edit needs more).
  const chunks: ChunkRecord[] = [];
  const cc: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < CHUNK_COUNT; c++) {
    chunkCoords(c, cc);
    const x = cc[0] * CHUNK + WORLD_ORIGIN;
    const y = cc[1] * CHUNK;
    const z = cc[2] * CHUNK + WORLD_ORIGIN;
    chunks.push({
      mesh: null,
      transform: new Transform({ x, y, z }),
      indexCount: 0,
      cx: x + CHUNK / 2,
      cy: y + CHUNK / 2,
      cz: z + CHUNK / 2,
    });
  }
  const meshed = new Uint8Array(CHUNK_COUNT);

  // The Worker owns the authoritative grid; the page keeps a copy for collision, picking and
  // the edits it applies ahead of the Worker's re-mesh.
  let grid: Uint8Array | null = null;
  const worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
  const send = (req: MesherRequest) => worker.postMessage(req);
  let token = 0;
  let editStart = 0;
  const pendingChunks = new Set<number>();
  const touched: number[] = [];

  worker.addEventListener('message', (e: MessageEvent<MesherReply>) => {
    const reply = e.data;
    if (reply.type === 'world') {
      grid = reply.grid;
      spawn();
      return;
    }
    const rec = chunks[reply.chunk]!;
    // The first reply makes the mesh at exactly its size; later ones write in place and grow
    // only when an edit exposes more faces than the chunk ever had.
    if (!rec.mesh) {
      rec.mesh = renderer.createMesh({
        label: `chunk-${reply.chunk}`,
        layout: VERTEX_LAYOUT_3D,
        capacity: {
          vertices: Math.max(4, reply.vertexCount),
          indices: Math.max(6, reply.indexCount),
        },
        indexFormat: 'uint32',
        bounds: CHUNK_BOUNDS,
        autoBounds: false,
      });
    }
    rec.mesh.update({
      vertices: reply.vertices,
      indices: reply.indices,
      vertexCount: reply.vertexCount,
      indexCount: reply.indexCount,
      bounds: CHUNK_BOUNDS,
    });
    rec.indexCount = reply.indexCount;
    if (!meshed[reply.chunk]) {
      meshed[reply.chunk] = 1;
      state.chunks++;
    }
    let growths = 0;
    let solid = 0;
    for (const c of chunks) {
      if (c.mesh) growths += c.mesh.growths;
      if (c.indexCount > 0) solid++;
    }
    state.growths = growths;
    state.chunksSolid = solid;
    if (reply.token === token && pendingChunks.delete(reply.chunk) && pendingChunks.size === 0) {
      state.remeshMs = performance.now() - editStart;
    }
  });
  send({ type: 'init', seed: SEED });

  // ─── the player ───────────────────────────────────────────────────────────
  const pos = state.playerPos;
  const vel = [0, 0, 0];
  let onGround = false;
  let inWater = false;
  let spawned = false;
  const aimDir = [0, 0, -1];
  const eye = new Float32Array(3);
  const lookTarget = new Float32Array(3);

  function blockAtWorld(x: number, y: number, z: number): number {
    if (!grid) return Block.Air;
    return blockAt(grid, Math.floor(x) - WORLD_ORIGIN, Math.floor(y), Math.floor(z) - WORLD_ORIGIN);
  }
  const solidAt = (x: number, y: number, z: number) => blockAtWorld(x, y, z) !== Block.Air;

  /** Does the player's box at feet (x, y, z) overlap a solid block? */
  function collides(x: number, y: number, z: number): boolean {
    const x0 = Math.floor(x - HALF);
    const x1 = Math.floor(x + HALF - SKIN);
    const y0 = Math.floor(y);
    const y1 = Math.floor(y + HEIGHT - SKIN);
    const z0 = Math.floor(z - HALF);
    const z1 = Math.floor(z + HALF - SKIN);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          if (solidAt(cx + 0.5, cy + 0.5, cz + 0.5)) return true;
        }
      }
    }
    return false;
  }

  function spawn(): void {
    if (!grid) return;
    spawnColumn(grid, cc);
    pos[0] = cc[0] + 0.5 + WORLD_ORIGIN;
    pos[1] = cc[1];
    pos[2] = cc[2] + 0.5 + WORLD_ORIGIN;
    vel[0] = vel[1] = vel[2] = 0;
    spawned = true;
  }

  function placeCamera(): void {
    const cp = Math.cos(state.pitch);
    // Yaw 0 looks down -z; positive yaw turns right (towards +x).
    aimDir[0] = Math.sin(state.yaw) * cp;
    aimDir[1] = Math.sin(state.pitch);
    aimDir[2] = -Math.cos(state.yaw) * cp;
    eye[0] = pos[0];
    eye[1] = pos[1] + EYE_HEIGHT;
    eye[2] = pos[2];
    lookTarget[0] = eye[0] + aimDir[0]!;
    lookTarget[1] = eye[1] + aimDir[1]!;
    lookTarget[2] = eye[2] + aimDir[2]!;
    camera.lookAt(eye, lookTarget);
  }

  function aim(yaw: number, pitch: number): void {
    state.yaw = yaw;
    state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    placeCamera();
  }

  /** Move the player one step: gravity, the move input, axis-separated voxel collision. */
  function step(dt: number, moveX: number, moveY: number, jump: boolean, autoJump: boolean): void {
    if (!spawned) return;
    // Standing in the sea: the feet are below the surface in an open cell.
    inWater = pos[1] + 0.4 < WATER_HEIGHT && !solidAt(pos[0], pos[1] + 0.4, pos[2]);
    const speed = inWater ? SWIM_SPEED : WALK_SPEED;
    const fx = Math.sin(state.yaw);
    const fz = -Math.cos(state.yaw);
    const len = Math.hypot(moveX, moveY);
    const k = len > 1 ? 1 / len : 1;
    const wx = (fx * moveY + -fz * moveX) * k;
    const wz = (fz * moveY + fx * moveX) * k;
    vel[0] = wx * speed;
    vel[2] = wz * speed;
    if (inWater) {
      vel[1] = Math.max(vel[1]! - GRAVITY * 0.25 * dt, -2.5);
      if (jump) vel[1] = 3.5;
    } else {
      vel[1] = vel[1]! - GRAVITY * dt;
      if (jump && onGround) vel[1] = JUMP_SPEED;
    }

    let blocked = false;
    // X.
    pos[0] += vel[0]! * dt;
    if (collides(pos[0], pos[1], pos[2])) {
      pos[0] =
        vel[0]! > 0
          ? Math.floor(pos[0] + HALF - SKIN) - HALF - SKIN
          : Math.floor(pos[0] - HALF) + 1 + HALF + SKIN;
      vel[0] = 0;
      blocked = true;
    }
    // Z.
    pos[2] += vel[2]! * dt;
    if (collides(pos[0], pos[1], pos[2])) {
      pos[2] =
        vel[2]! > 0
          ? Math.floor(pos[2] + HALF - SKIN) - HALF - SKIN
          : Math.floor(pos[2] - HALF) + 1 + HALF + SKIN;
      vel[2] = 0;
      blocked = true;
    }
    // Y.
    pos[1] += vel[1]! * dt;
    onGround = false;
    if (collides(pos[0], pos[1], pos[2])) {
      if (vel[1]! <= 0) {
        pos[1] = Math.floor(pos[1]) + 1;
        onGround = true;
      } else {
        pos[1] = Math.floor(pos[1] + HEIGHT - SKIN) - HEIGHT - SKIN;
      }
      vel[1] = 0;
    }
    // A step: walking into a one-block ledge hops it (Bedrock's auto-jump; on every device).
    if (blocked && onGround && autoJump && len > 0) vel[1] = JUMP_SPEED;
    // The world's edge is a wall.
    pos[0] = Math.max(WORLD_ORIGIN + HALF, Math.min(WORLD_ORIGIN + WORLD_X - HALF, pos[0]));
    pos[2] = Math.max(WORLD_ORIGIN + HALF, Math.min(WORLD_ORIGIN + WORLD_Z - HALF, pos[2]));
  }

  // ─── picking and editing ──────────────────────────────────────────────────
  const hit: VoxelHit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
  const lookingAt: [number, number, number] = [0, 0, 0];
  let hasHit = false;

  function pick(): void {
    hasHit =
      grid !== null &&
      raycastVoxels(
        grid,
        eye[0]!,
        eye[1]!,
        eye[2]!,
        aimDir[0]!,
        aimDir[1]!,
        aimDir[2]!,
        REACH,
        hit,
      );
    if (hasHit) {
      lookingAt[0] = hit.x + WORLD_ORIGIN;
      lookingAt[1] = hit.y;
      lookingAt[2] = hit.z + WORLD_ORIGIN;
      state.lookingAt = lookingAt;
    } else {
      state.lookingAt = null;
    }
  }

  /** Set a voxel on both copies and re-mesh the chunks whose faces it changes. */
  function setBlock(x: number, y: number, z: number, block: number): void {
    if (!grid || !inWorld(x, y, z)) return;
    grid[voxelIndex(x, y, z)] = block;
    send({ type: 'set', x, y, z, block });
    chunksTouching(x, y, z, touched);
    token++;
    editStart = performance.now();
    pendingChunks.clear();
    for (const c of touched) pendingChunks.add(c);
    send({ type: 'mesh', chunks: touched.slice(), token });
    state.edits++;
  }

  function breakBlock(): void {
    if (!hasHit) return;
    setBlock(hit.x, hit.y, hit.z, Block.Air);
    reticle.pulse();
    pick();
  }

  function placeBlock(): void {
    if (!hasHit || !grid) return;
    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    if (!inWorld(x, y, z) || grid[voxelIndex(x, y, z)] !== Block.Air) return;
    // Not into the player.
    const wx = x + WORLD_ORIGIN;
    const wz = z + WORLD_ORIGIN;
    const overlapsX = wx + 1 > pos[0] - HALF && wx < pos[0] + HALF;
    const overlapsZ = wz + 1 > pos[2] - HALF && wz < pos[2] + HALF;
    const overlapsY = y + 1 > pos[1] && y < pos[1] + HEIGHT;
    if (overlapsX && overlapsZ && overlapsY) return;
    setBlock(x, y, z, state.selectedBlock);
    pick();
  }

  // ─── input ────────────────────────────────────────────────────────────────
  const touchDevice = navigator.maxTouchPoints > 0;
  const look = new Look({
    keys: {
      forward: ['KeyW', 'ArrowUp'],
      back: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
    },
    touch: { moveZone: 'left', radius: 56 },
    zoom: { wheel: false, pinch: false },
  });
  const gestures = new Gestures({ longPressMs: 420 });
  const input = new Input(
    {
      // Break is the tap (a mouse click is one too) so a click never counts twice.
      breakPad: [{ padButton: 7 }],
      place: [{ mouse: 2 }, { key: 'KeyE' }, { padButton: 6 }],
      jump: [{ key: 'Space' }, { padButton: 0 }],
      next: [{ wheel: 1 }, { padButton: 5 }],
      prev: [{ wheel: -1 }, { padButton: 4 }],
      slot1: [{ key: 'Digit1' }],
      slot2: [{ key: 'Digit2' }],
      slot3: [{ key: 'Digit3' }],
      slot4: [{ key: 'Digit4' }],
      slot5: [{ key: 'Digit5' }],
      slot6: [{ key: 'Digit6' }],
      slot7: [{ key: 'Digit7' }],
    },
    { look, gestures },
  );
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));
  surface.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !look.locked) void look.request();
  });
  surface.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const SLOT_ACTIONS = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7'] as const;

  /** A touch on the move stick's half is never a block action. */
  const inActionZone = (g: { device: string; x: number; inside: boolean }) =>
    g.device !== 'touch' || (g.inside && g.x >= LOGICAL.width / 2);

  const api: VoxelDemoApi = Object.assign(state, {
    aim,
    blockAtWorld: (x: number, y: number, z: number) => blockAtWorld(x + 0.5, y + 0.5, z + 0.5),
  });
  (window as unknown as { __demo: VoxelDemoApi }).__demo = api;

  placeCamera();
  placeSun();
  ui.toasts.show(
    touchDevice
      ? 'Left: move. Right: look. Tap: break. Hold: place.'
      : 'Click to look. WASD, Space. Click: break. Right click / E: place. 1-7, wheel: block.',
    { duration: 6000 },
  );

  const loop = new GameLoop({
    update(dt) {
      input.update();
      if (!STILL) state.timeOfDay = (state.timeOfDay + dt / DAY_SECONDS) % 1;
      placeSun();
      water.update(dt);

      if (look.look.dx !== 0 || look.look.dy !== 0) {
        aim(state.yaw + look.look.dx, state.pitch + look.look.dy);
      }
      state.locked = look.locked;
      step(dt, look.move.x, look.move.y, input.pressed('jump') || input.held('jump'), true);
      placeCamera();
      pick();

      const tap = gestures.tap;
      if ((tap && inActionZone(tap)) || input.pressed('breakPad')) breakBlock();
      const hold = gestures.longPress;
      if ((hold && hold.device === 'touch' && inActionZone(hold)) || input.pressed('place')) {
        placeBlock();
      }
      if (input.pressed('next')) selectSlot(hotbar.selected + 1);
      if (input.pressed('prev')) selectSlot(hotbar.selected - 1);
      for (let i = 0; i < SLOT_ACTIONS.length; i++) {
        if (input.pressed(SLOT_ACTIONS[i]!)) selectSlot(i);
      }
    },
    render(_alpha, time) {
      glow[0] = flicker(time.realTime, { seed: 3, speed: 5, amount: 0.35, base: 1.6 });
      material.setUniforms(glow);

      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0, 0, 0);
      frame.lights = lights;
      frame.drawable(sky, -1);
      // The chunks: only those the frustum sees are recorded (the engine culls by the mesh
      // bounds too; this keeps the record loop and the stats honest).
      let drawn = 0;
      let culled = 0;
      let triangles = 0;
      for (const c of chunks) {
        if (!c.mesh || c.indexCount === 0) continue;
        if (!camera.seesSphere(c.cx, c.cy, c.cz, CHUNK_RADIUS)) {
          culled++;
          continue;
        }
        frame.mesh(c.mesh, material, c.transform);
        drawn++;
        triangles += c.indexCount / 3;
      }
      // The water in a second view of the same camera, so its depth copy holds this frame's
      // terrain (shoreline, depth tint).
      frame.drawable(water, 1, 2);
      camera.layers = 1;
      renderer.render(frame, camera);
      camera.layers = 2;
      renderer.render(frame, camera);
      renderer.endFrame();

      state.frame++;
      if (time.frameDt > 0) {
        const fps = 1 / time.frameDt;
        state.fps = state.fps === 0 ? fps : state.fps + (fps - state.fps) * 0.1;
      }
      state.chunksDrawn = drawn;
      state.chunksCulled = culled;
      state.triangles = triangles;
      state.drawCalls = renderer.stats.drawCalls;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.stats.culled = renderer.stats.culled;
      state.stats.shadowDraws = renderer.stats.shadowDraws;
      state.gpuErrors = gpuDiagnostics.errorCount;
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
  console.error('[demo-voxel]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
