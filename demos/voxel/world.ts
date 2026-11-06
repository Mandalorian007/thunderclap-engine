/**
 * The voxel world of the voxel demo: constants, block ids, the noise, the generator, the grid
 * helpers and the DDA ray. Shared by the page (`main.ts`), the mesher Worker
 * (`mesher.worker.ts`) and the spec (`e2e/demos/voxel.spec.ts`). Nothing here is engine code:
 * the grid, the noise and the ray are what a voxel game writes (VISION rule 5: the mesher is the
 * game's, the renderer is the engine's).
 *
 * Coordinates: a voxel `(vx, vy, vz)` with `0 <= vx < WORLD_X` etc. occupies the world cube
 * `[vx + WORLD_ORIGIN, vx + WORLD_ORIGIN + 1)` on x and z and `[vy, vy + 1)` on y, so the world
 * is centred on the origin and the engine's `Water` plane (centred on the origin) covers it.
 */

export const CHUNK = 16;
export const WORLD_CHUNKS_X = 8;
export const WORLD_CHUNKS_Y = 4;
export const WORLD_CHUNKS_Z = 8;
export const CHUNK_COUNT = WORLD_CHUNKS_X * WORLD_CHUNKS_Y * WORLD_CHUNKS_Z;
export const WORLD_X = WORLD_CHUNKS_X * CHUNK;
export const WORLD_Y = WORLD_CHUNKS_Y * CHUNK;
export const WORLD_Z = WORLD_CHUNKS_Z * CHUNK;
/** World x and z of voxel column 0. */
export const WORLD_ORIGIN = -WORLD_X / 2;
/** The water plane sits at this height (a little above the top of the sea-level block row). */
export const SEA_LEVEL = 26;
export const WATER_HEIGHT = SEA_LEVEL + 0.85;
export const SEED = 1337;
/** Half the diagonal of a chunk: the radius of its bounding sphere. */
export const CHUNK_RADIUS = Math.sqrt(3) * (CHUNK / 2);
/** How far the player can reach a block. */
export const REACH = 6;

export const Block = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Sand: 4,
  Wood: 5,
  Leaves: 6,
  Glowstone: 7,
} as const;
export type BlockId = (typeof Block)[keyof typeof Block];

/** Texture-array layers (one canvas-painted face each; `textures.ts` paints them in this order). */
export const Layer = {
  GrassTop: 0,
  GrassSide: 1,
  Dirt: 2,
  Stone: 3,
  Sand: 4,
  Wood: 5,
  Leaves: 6,
  Glowstone: 7,
} as const;
export const LAYER_COUNT = 8;

/** The blocks the hotbar offers, in slot order. */
export const HOTBAR: readonly BlockId[] = [
  Block.Grass,
  Block.Dirt,
  Block.Stone,
  Block.Sand,
  Block.Wood,
  Block.Leaves,
  Block.Glowstone,
];
export const BLOCK_NAMES: readonly string[] = [
  'air',
  'grass',
  'dirt',
  'stone',
  'sand',
  'wood',
  'leaves',
  'glowstone',
];

/** Face index: +x, -x, +y, -y, +z, -z (the order the mesher walks). */
export type Face = 0 | 1 | 2 | 3 | 4 | 5;

/** The texture layer of `block`'s face `face`. */
export function blockLayer(block: number, face: Face): number {
  if (block === Block.Grass) {
    if (face === 2) return Layer.GrassTop;
    if (face === 3) return Layer.Dirt;
    return Layer.GrassSide;
  }
  // The other blocks share their id with their layer.
  return block;
}

// ─── grid ────────────────────────────────────────────────────────────────────

export function voxelIndex(x: number, y: number, z: number): number {
  return y + WORLD_Y * (x + WORLD_X * z);
}

export function inWorld(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < WORLD_X && y < WORLD_Y && z < WORLD_Z;
}

/** The block at a voxel, air outside the world (and solid stone below it: no bottom faces). */
export function blockAt(grid: Uint8Array, x: number, y: number, z: number): number {
  if (y < 0) return Block.Stone;
  if (!inWorld(x, y, z)) return Block.Air;
  return grid[voxelIndex(x, y, z)]!;
}

export function chunkIndex(cx: number, cy: number, cz: number): number {
  return cx + WORLD_CHUNKS_X * (cy + WORLD_CHUNKS_Y * cz);
}

/** The chunk coordinates of chunk `index`, written into `out`. */
export function chunkCoords(index: number, out: [number, number, number]): void {
  out[0] = index % WORLD_CHUNKS_X;
  out[1] = Math.floor(index / WORLD_CHUNKS_X) % WORLD_CHUNKS_Y;
  out[2] = Math.floor(index / (WORLD_CHUNKS_X * WORLD_CHUNKS_Y));
}

/** The chunk a voxel lives in. */
export function chunkOf(x: number, y: number, z: number): number {
  return chunkIndex(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK));
}

/**
 * The chunk of voxel `(x, y, z)` and every neighbouring chunk that shares a face with it (a
 * block on a chunk border changes the neighbour's faces and AO too). Pushed into `out`, unique.
 */
export function chunksTouching(x: number, y: number, z: number, out: number[]): void {
  out.length = 0;
  const push = (cx: number, cy: number, cz: number) => {
    if (cx < 0 || cy < 0 || cz < 0) return;
    if (cx >= WORLD_CHUNKS_X || cy >= WORLD_CHUNKS_Y || cz >= WORLD_CHUNKS_Z) return;
    const c = chunkIndex(cx, cy, cz);
    if (!out.includes(c)) out.push(c);
  };
  const cx = Math.floor(x / CHUNK);
  const cy = Math.floor(y / CHUNK);
  const cz = Math.floor(z / CHUNK);
  push(cx, cy, cz);
  const lx = x - cx * CHUNK;
  const ly = y - cy * CHUNK;
  const lz = z - cz * CHUNK;
  if (lx === 0) push(cx - 1, cy, cz);
  if (lx === CHUNK - 1) push(cx + 1, cy, cz);
  if (ly === 0) push(cx, cy - 1, cz);
  if (ly === CHUNK - 1) push(cx, cy + 1, cz);
  if (lz === 0) push(cx, cy, cz - 1);
  if (lz === CHUNK - 1) push(cx, cy, cz + 1);
}

/** The highest non-air voxel of column `(x, z)`, or -1 for none. */
export function surfaceHeight(grid: Uint8Array, x: number, z: number): number {
  for (let y = WORLD_Y - 1; y >= 0; y--) {
    if (grid[voxelIndex(x, y, z)] !== Block.Air) return y;
  }
  return -1;
}

// ─── noise ───────────────────────────────────────────────────────────────────

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2246822519 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 2D value noise in [0, 1]. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/** 3D value noise in [0, 1]. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const tz = smooth(z - z0);
  const c000 = hash3(x0, y0, z0, seed);
  const c100 = hash3(x0 + 1, y0, z0, seed);
  const c010 = hash3(x0, y0 + 1, z0, seed);
  const c110 = hash3(x0 + 1, y0 + 1, z0, seed);
  const c001 = hash3(x0, y0, z0 + 1, seed);
  const c101 = hash3(x0 + 1, y0, z0 + 1, seed);
  const c011 = hash3(x0, y0 + 1, z0 + 1, seed);
  const c111 = hash3(x0 + 1, y0 + 1, z0 + 1, seed);
  const z0v = lerp(lerp(c000, c100, tx), lerp(c010, c110, tx), ty);
  const z1v = lerp(lerp(c001, c101, tx), lerp(c011, c111, tx), ty);
  return lerp(z0v, z1v, tz);
}

/** Fractal 2D value noise, `octaves` layers, in [0, 1]. */
export function fbm2(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x, y, seed + o * 17);
    norm += amp;
    x *= 2.03;
    y *= 1.97;
    amp *= 0.5;
  }
  return sum / norm;
}

// ─── generation ──────────────────────────────────────────────────────────────

/** Terrain height of column `(x, z)`: rolling hills with a sea between them. */
export function terrainHeight(x: number, z: number, seed: number): number {
  const base = fbm2(x / 56, z / 56, seed, 4);
  const ridge = fbm2(x / 23 + 100, z / 23 - 50, seed + 7, 3);
  const h = 18 + base * 26 + (ridge - 0.5) * 8;
  return Math.max(4, Math.min(WORLD_Y - 6, Math.round(h)));
}

/** The whole world from the seed: hills, beaches, caves, trees and glowstone. */
export function generateWorld(seed: number): Uint8Array {
  const grid = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
  const heights = new Int16Array(WORLD_X * WORLD_Z);
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const h = terrainHeight(x, z, seed);
      heights[x + WORLD_X * z] = h;
      const beach = h <= SEA_LEVEL + 1;
      for (let y = 0; y <= h; y++) {
        let b: number;
        if (y === h) b = beach ? Block.Sand : Block.Grass;
        else if (y > h - 4) b = beach ? Block.Sand : Block.Dirt;
        else b = Block.Stone;
        // Caves: a 3D noise band carved out of the rock, never through the surface skin.
        if (y > 3 && y < h - 3) {
          const n = valueNoise3(x / 13, y / 9, z / 13, seed + 99);
          if (n > 0.66) {
            b = Block.Air;
            // Glowstone on a few cave floors.
            if (hash3(x, y, z, seed + 5) < 0.04 && blockAtRaw(grid, x, y - 1, z) !== Block.Air) {
              b = Block.Glowstone;
            }
          }
        }
        grid[voxelIndex(x, y, z)] = b;
      }
    }
  }
  // Trees on grass above the sea, kept inside the world; a glowstone lantern on some.
  for (let z = 3; z < WORLD_Z - 3; z++) {
    for (let x = 3; x < WORLD_X - 3; x++) {
      const h = heights[x + WORLD_X * z]!;
      if (h <= SEA_LEVEL + 2 || h > WORLD_Y - 10) continue;
      if (grid[voxelIndex(x, h, z)] !== Block.Grass) continue;
      const r = hash2(x, z, seed + 31);
      if (r < 0.012) {
        const trunk = 4 + Math.floor(hash2(x, z, seed + 32) * 2);
        for (let y = 1; y <= trunk; y++) grid[voxelIndex(x, h + y, z)] = Block.Wood;
        const top = h + trunk;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = -1; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
              if (d > 3 || (dy === 2 && d > 1)) continue;
              const i = voxelIndex(x + dx, top + dy, z + dz);
              if (grid[i] === Block.Air) grid[i] = Block.Leaves;
            }
          }
        }
      } else if (r > 0.9975) {
        grid[voxelIndex(x, h + 1, z)] = Block.Glowstone;
      }
    }
  }
  return grid;
}

function blockAtRaw(grid: Uint8Array, x: number, y: number, z: number): number {
  return inWorld(x, y, z) ? grid[voxelIndex(x, y, z)]! : Block.Air;
}

/**
 * Where the player spawns: the land column nearest the world centre that stands above the sea,
 * as voxel coordinates `[x, surface + 1, z]`.
 */
export function spawnColumn(grid: Uint8Array, out: [number, number, number]): void {
  const cx = WORLD_X / 2;
  const cz = WORLD_Z / 2;
  for (let r = 0; r < WORLD_X / 2; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (!inWorld(x, 0, z)) continue;
        const h = surfaceHeight(grid, x, z);
        if (h > SEA_LEVEL + 1 && grid[voxelIndex(x, h, z)] === Block.Grass) {
          out[0] = x;
          out[1] = h + 1;
          out[2] = z;
          return;
        }
      }
    }
  }
  out[0] = cx;
  out[1] = surfaceHeight(grid, cx, cz) + 1;
  out[2] = cz;
}

// ─── the ray ─────────────────────────────────────────────────────────────────

/** What `raycastVoxels` fills: the hit voxel, the face normal it entered through, the distance. */
export interface VoxelHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  distance: number;
}

/**
 * DDA traversal (Amanatides & Woo) through the grid from a world point along a unit direction,
 * up to `maxDistance`. Returns true and fills `out` on the first non-air voxel.
 */
export function raycastVoxels(
  grid: Uint8Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  out: VoxelHit,
): boolean {
  // Into voxel space.
  const px = ox - WORLD_ORIGIN;
  const py = oy;
  const pz = oz - WORLD_ORIGIN;
  let x = Math.floor(px);
  let y = Math.floor(py);
  let z = Math.floor(pz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? x + 1 - px : px - x) * tDeltaX;
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? y + 1 - py : py - y) * tDeltaY;
  let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? z + 1 - pz : pz - z) * tDeltaZ;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  for (let i = 0; i < 4 * maxDistance + 8; i++) {
    if (inWorld(x, y, z) && grid[voxelIndex(x, y, z)] !== Block.Air) {
      out.x = x;
      out.y = y;
      out.z = z;
      out.nx = nx;
      out.ny = ny;
      out.nz = nz;
      out.distance = t;
      return true;
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      t = tMaxX;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY < tMaxZ) {
      t = tMaxY;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      t = tMaxZ;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
    if (t > maxDistance) return false;
  }
  return false;
}

// ─── Worker messages ─────────────────────────────────────────────────────────

/** Page → Worker. */
export type MesherRequest =
  | { type: 'init'; seed: number }
  | { type: 'set'; x: number; y: number; z: number; block: number }
  | { type: 'mesh'; chunks: number[]; token: number };

/**
 * Worker → page. `world` carries a copy of the generated grid once; each `mesh` reply carries one
 * chunk's vertices (`VERTEX_LAYOUT_3D`: xyz, normal, uv, rgb = ambient occlusion, a = texture
 * layer) and uint32 indices, both transferred, plus the request token it answers.
 */
export type MesherReply =
  | { type: 'world'; grid: Uint8Array }
  | {
      type: 'mesh';
      chunk: number;
      token: number;
      vertices: Float32Array;
      indices: Uint32Array;
      vertexCount: number;
      indexCount: number;
    };

/** Floats per vertex in `VERTEX_LAYOUT_3D`. */
export const VERTEX_FLOATS = 12;

// ─── what the page publishes ─────────────────────────────────────────────────

export interface VoxelDemoState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frame: number;
  /** Running average of frames per second. */
  fps: number;
  /** `renderer.stats` of the last frame, copied. */
  stats: { drawCalls: number; instances: number; culled: number; shadowDraws: number };
  /** Chunks meshed at least once (256 when the world is complete). */
  chunks: number;
  /** Chunks drawn last frame (after the frustum test), and chunks skipped by it. */
  chunksDrawn: number;
  chunksCulled: number;
  /** Chunks whose mesh has faces. */
  chunksSolid: number;
  /** Scene-pass draw calls of the last frame. */
  drawCalls: number;
  /** Triangles drawn last frame (chunk meshes only). */
  triangles: number;
  /** Last block-edit round trip: edit sent → every touched chunk uploaded, ms. -1 before any. */
  remeshMs: number;
  /** Block edits so far. */
  edits: number;
  /** `mesh.growths` summed over the chunks. */
  growths: number;
  /** The player's feet, world units. */
  playerPos: [number, number, number];
  /** The view: yaw (+ turns right) and pitch (+ looks up), radians. */
  yaw: number;
  pitch: number;
  /** The block id the hotbar has selected, and its slot. */
  selectedBlock: number;
  selectedSlot: number;
  /** World cell of the block under the reticle within reach (`[x, y, z]`, world coords), or null. */
  lookingAt: [number, number, number] | null;
  /** 0..1: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. */
  timeOfDay: number;
  /** `?still`: the day cycle is parked. */
  still: boolean;
  /** `look.locked`. */
  locked: boolean;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface VoxelDemoApi extends VoxelDemoState {
  /** Set the view directly: yaw (+ turns right) and pitch (+ looks up, clamped), radians. */
  aim(yaw: number, pitch: number): void;
  /** The block id at a world cell (`Block.Air` outside the world). */
  blockAtWorld(x: number, y: number, z: number): number;
}
