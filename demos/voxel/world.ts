/**
 * The voxel world of the voxel demo: the constants, the block ids and their texture layers, the
 * terrain (the engine's `createNoise`) and the generator that pours a world into an engine `VoxelGrid`, and the block rules
 * (what lies beyond the grid, where the player spawns). Shared by the page (`main.ts`), the
 * mesher Worker (`mesher.worker.ts`, for `blockLayer` and `outsideBlock`) and the spec
 * (`e2e/demos/voxel.spec.ts`). The grid, the mesher, the chunk meshes and the picking ray are
 * the engine's (`@thunderclap/engine/voxel`); the blocks are the game's (VISION rule 5).
 *
 * Coordinates: the grid's corner is the world origin, so a voxel `(x, y, z)` occupies the world
 * cube `[x, x + 1) × [y, y + 1) × [z, z + 1)` and grid coordinates are world coordinates.
 */
import { createNoise, type FbmOptions, type Noise } from '@thunderclap/engine/core';
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

/**
 * Point hashes for per-column and per-cell rolls (a tree here, a lantern there). These are not
 * noise: a roll needs a number per lattice point, not a field between them.
 */
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

/** The engine's seeded noise for one seed, built once (the permutation table is per seed). */
let noiseSeed = 0;
let noise: Noise | null = null;
function noiseFor(seed: number): Noise {
  if (noise === null || seed !== noiseSeed) {
    noise = createNoise(seed);
    noiseSeed = seed;
  }
  return noise;
}

const HILLS: FbmOptions = { octaves: 4 };
const RIDGES: FbmOptions = { octaves: 3 };
/**
 * Where the world's window sits on the noise field, in columns along z: chosen so the seed's
 * spawn looks north over flat grass (the spec places a block a few cells ahead).
 */
const WINDOW_Z = -40;

// ─── generation ──────────────────────────────────────────────────────────────

/**
 * The band every column's terrain top falls in (seed 1337 spans 19..39; the mulberry-era value
 * noise spanned 22..39). The page checks it at boot (`worldProblem`).
 */
export const TERRAIN_MIN = 16;
export const TERRAIN_MAX = 44;

/** Terrain height of column `(x, z)`: rolling hills with a sea between them. */
export function terrainHeight(x: number, z: number, seed: number): number {
  const n = noiseFor(seed);
  z += WINDOW_Z;
  // `fbm` is in [-1, 1]; the hills read it as 0..1 around 0.5, the ridges as ±0.5.
  const base = 0.5 + 0.5 * n.fbm(n.value2, x / 56, z / 56, 0, HILLS);
  const ridge = 0.5 * n.fbm(n.value2, x / 23 + 100, z / 23 - 50, 0, RIDGES);
  const h = 16 + base * 26 + ridge * 8;
  return Math.max(4, Math.min(WORLD_Y - 6, Math.round(h)));
}

/** A cave cell: a 3D noise band carved out of the rock, never through the surface skin. */
function carved(x: number, y: number, z: number, h: number, seed: number): boolean {
  // value3 in [-1, 1]: above 0.32 is the old 0..1 field's band above 0.66.
  return y > 3 && y < h - 3 && noiseFor(seed).value3(x / 13 + 99, y / 9, z / 13) > 0.32;
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

/**
 * The generator's promises, checked on the built world: every terrain top inside
 * `[TERRAIN_MIN, TERRAIN_MAX]`, and the spawn cell open with solid land (not sand, not air)
 * under it, above the sea. Returns what broke, or null. The page logs a broken promise as a
 * console error, which the spec's no-errors check fails on.
 */
export function worldProblem(
  grid: VoxelGrid,
  seed: number,
  spawn: readonly [number, number, number],
): string | null {
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const h = terrainHeight(x, z, seed);
      if (h < TERRAIN_MIN || h > TERRAIN_MAX)
        return `terrain at (${x}, ${z}) is ${h}, outside ${TERRAIN_MIN}..${TERRAIN_MAX}`;
    }
  }
  const [x, y, z] = spawn;
  const under = grid.get(x, y - 1, z);
  if (grid.get(x, y, z) !== Block.Air || under === Block.Air || under === Block.Sand)
    return `spawn (${x}, ${y}, ${z}) does not stand on solid land (block below: ${under})`;
  if (y - 1 <= SEA_LEVEL) return `spawn (${x}, ${y}, ${z}) is at or below the sea`;
  return null;
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
  /**
   * The lowest and highest `terrainHeight` over every column of the built world (trees and
   * caves aside), measured once at boot; `[-1, -1]` before.
   */
  terrainTops: [number, number];
  /** The spawn cell (`spawnColumn`, world cell coords), set once at boot; `[-1, -1, -1]` before. */
  spawn: [number, number, number];
}

export interface VoxelDemoApi extends VoxelDemoState {
  /** Set the view directly: yaw (+ turns right) and pitch (+ looks up, clamped), radians. */
  aim(yaw: number, pitch: number): void;
  /** The block id at a world cell (`Block.Air` outside the world). */
  blockAtWorld(x: number, y: number, z: number): number;
}
