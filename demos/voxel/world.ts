/**
 * The voxel world of the voxel demo: the constants, the block ids and their texture layers, the
 * noise and the generator that pours a world into an engine `VoxelGrid`, and the block rules
 * (what lies beyond the grid, where the player spawns). Shared by the page (`main.ts`), the
 * mesher Worker (`mesher.worker.ts`, for `blockLayer` and `outsideBlock`) and the spec
 * (`e2e/demos/voxel.spec.ts`). The grid, the mesher, the chunk meshes and the picking ray are
 * the engine's (`@thunderclap/engine/voxel`); the blocks are the game's (VISION rule 5).
 *
 * Coordinates: the grid's corner is the world origin, so a voxel `(x, y, z)` occupies the world
 * cube `[x, x + 1) × [y, y + 1) × [z, z + 1)` and grid coordinates are world coordinates.
 */
import type { VoxelFace, VoxelGrid } from '@thunderclap/engine/voxel';

export const CHUNK = 16;
export const WORLD_CHUNKS_X = 8;
export const WORLD_CHUNKS_Y = 4;
export const WORLD_CHUNKS_Z = 8;
export const CHUNK_COUNT = WORLD_CHUNKS_X * WORLD_CHUNKS_Y * WORLD_CHUNKS_Z;
export const WORLD_X = WORLD_CHUNKS_X * CHUNK;
export const WORLD_Y = WORLD_CHUNKS_Y * CHUNK;
export const WORLD_Z = WORLD_CHUNKS_Z * CHUNK;
/** The water plane sits at this height (a little above the top of the sea-level block row). */
export const SEA_LEVEL = 26;
export const WATER_HEIGHT = SEA_LEVEL + 0.85;
export const SEED = 1337;
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

/** The texture layer of `block`'s face `face` (the engine's `layerOf`; faces +x -x +y -y +z -z). */
export function blockLayer(block: number, face: VoxelFace): number {
  if (block === Block.Grass) {
    if (face === 2) return Layer.GrassTop;
    if (face === 3) return Layer.Dirt;
    return Layer.GrassSide;
  }
  // The other blocks share their id with their layer.
  return block;
}

/** What lies beyond the grid (the engine's `outside`): stone below it (no underside), air elsewhere. */
export function outsideBlock(_x: number, y: number, _z: number): number {
  return y < 0 ? Block.Stone : Block.Air;
}

/** The highest non-air voxel of column `(x, z)`, or -1 for none. */
export function surfaceHeight(grid: VoxelGrid, x: number, z: number): number {
  for (let y = WORLD_Y - 1; y >= 0; y--) {
    if (grid.get(x, y, z) !== Block.Air) return y;
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

/** A cave cell: a 3D noise band carved out of the rock, never through the surface skin. */
function carved(x: number, y: number, z: number, h: number, seed: number): boolean {
  return y > 3 && y < h - 3 && valueNoise3(x / 13, y / 9, z / 13, seed + 99) > 0.66;
}

/**
 * The whole world from the seed into `grid` (every chunk dirty afterwards): hills, beaches,
 * caves with glowstone on a few floors, trees on the grass above the sea.
 */
export function generateWorld(grid: VoxelGrid, seed: number): void {
  const heights = new Int16Array(WORLD_X * WORLD_Z);
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) heights[x + WORLD_X * z] = terrainHeight(x, z, seed);
  }
  grid.fill((x, y, z) => {
    const h = heights[x + WORLD_X * z]!;
    if (y > h) return Block.Air;
    const beach = h <= SEA_LEVEL + 1;
    if (carved(x, y, z, h, seed)) {
      // Glowstone on a cave floor: the cell below is rock that was not carved.
      const floor = !carved(x, y - 1, z, h, seed);
      return floor && hash3(x, y, z, seed + 5) < 0.04 ? Block.Glowstone : Block.Air;
    }
    if (y === h) return beach ? Block.Sand : Block.Grass;
    if (y > h - 4) return beach ? Block.Sand : Block.Dirt;
    return Block.Stone;
  });
  // Trees on grass above the sea, kept inside the world; a glowstone lantern on some.
  for (let z = 3; z < WORLD_Z - 3; z++) {
    for (let x = 3; x < WORLD_X - 3; x++) {
      const h = heights[x + WORLD_X * z]!;
      if (h <= SEA_LEVEL + 2 || h > WORLD_Y - 10) continue;
      if (grid.get(x, h, z) !== Block.Grass) continue;
      const r = hash2(x, z, seed + 31);
      if (r < 0.012) {
        const trunk = 4 + Math.floor(hash2(x, z, seed + 32) * 2);
        for (let y = 1; y <= trunk; y++) grid.set(x, h + y, z, Block.Wood);
        const top = h + trunk;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = -1; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
              if (d > 3 || (dy === 2 && d > 1)) continue;
              if (grid.get(x + dx, top + dy, z + dz) === Block.Air) {
                grid.set(x + dx, top + dy, z + dz, Block.Leaves);
              }
            }
          }
        }
      } else if (r > 0.9975) {
        grid.set(x, h + 1, z, Block.Glowstone);
      }
    }
  }
}

/**
 * Where the player spawns: the land column nearest the world centre that stands above the sea,
 * as voxel coordinates `[x, surface + 1, z]`.
 */
export function spawnColumn(grid: VoxelGrid, out: [number, number, number]): void {
  const cx = WORLD_X / 2;
  const cz = WORLD_Z / 2;
  for (let r = 0; r < WORLD_X / 2; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (!grid.inBounds(x, 0, z)) continue;
        const h = surfaceHeight(grid, x, z);
        if (h > SEA_LEVEL + 1 && grid.get(x, h, z) === Block.Grass) {
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
  /** Chunks meshed at least once (256 when the world is complete; saturates there). */
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
  /** Last block-edit round trip: edit → every touched chunk uploaded, ms. -1 before any. */
  remeshMs: number;
  /** Remeshes the engine applied so far (`VoxelChunks.stats.remeshes`). */
  remeshes: number;
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
