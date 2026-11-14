/**
 * A `VoxelGrid` as a source of a `VoxelWorld` (D1 §2.8 "Keeps"): a small bounded world for a
 * puzzle, an editor or a demo, drawn by the same streamed path as any other. Each grid chunk is
 * one section (the format's `sectionSize` must equal `grid.chunk`), put as raw cells; a ring of
 * empty sections around the grid (and `outside` below it) makes every chunk's neighbours known.
 * `sync()` once a frame re-puts the chunks the grid flagged dirty, and the world remeshes them
 * and their neighbours.
 */
import type { VoxelGrid } from './grid';
import type { VoxelWorld } from './world';

/** Options for `feedVoxelGrid`. */
export interface VoxelGridSourceOptions {
  /** The cell under the grid (`grid.get`'s `outside` below y 0). Default 0, empty. */
  outside?: number;
}

/** What `feedVoxelGrid` returns. */
export interface VoxelGridSource {
  readonly grid: VoxelGrid;
  /** Put the dirty chunks into the world; returns how many. Allocates only for what it puts. */
  sync(): number;
  /** Sections put so far (the ring included). */
  readonly puts: number;
}

/** Feed `grid` into `world`: every chunk now, the dirty ones on each `sync()`. */
export function feedVoxelGrid(
  world: VoxelWorld,
  grid: VoxelGrid,
  opts: VoxelGridSourceOptions = {},
): VoxelGridSource {
  const S = world.format.size;
  if (grid.chunk !== S)
    throw new RangeError(`grid chunk ${grid.chunk} must equal the format's sectionSize ${S}`);
  const outside = opts.outside ?? 0;
  const cells = new Uint32Array(S * S * S);
  const at = [0, 0, 0];
  const { sizeX, sizeY, sizeZ, data } = grid;
  let puts = 0;

  const uniform = (value: number): Uint8Array => new Uint8Array(Uint32Array.of(value).buffer);
  const putChunk = (chunk: number): void => {
    grid.chunkCoords(chunk, at);
    const cx = at[0]!;
    const cy = at[1]!;
    const cz = at[2]!;
    const x0 = cx * S;
    const y0 = cy * S;
    const z0 = cz * S;
    let first = -1;
    let same = true;
    for (let y = 0; y < S; y++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const gx = x0 + x;
          const gy = y0 + y;
          const gz = z0 + z;
          const v =
            gx < sizeX && gy < sizeY && gz < sizeZ ? data[gx + sizeX * (gy + sizeY * gz)]! : 0;
          cells[x + z * S + y * S * S] = v;
          if (first < 0) first = v;
          else if (v !== first) same = false;
        }
      }
    }
    world.putSection(cx, cy, cz, same ? uniform(first) : new Uint8Array(cells.slice().buffer));
    puts++;
  };

  // The ring: empty beside and above the grid, `outside` below it.
  for (let cz = -1; cz <= grid.chunksZ; cz++) {
    for (let cy = -1; cy <= grid.chunksY; cy++) {
      for (let cx = -1; cx <= grid.chunksX; cx++) {
        const inside =
          cx >= 0 &&
          cx < grid.chunksX &&
          cy >= 0 &&
          cy < grid.chunksY &&
          cz >= 0 &&
          cz < grid.chunksZ;
        if (inside) continue;
        world.putSection(cx, cy, cz, uniform(cy < 0 ? outside : 0));
        puts++;
      }
    }
  }
  grid.markAllDirty();
  const source: VoxelGridSource = {
    grid,
    sync: () => grid.forEachDirtyChunk(putChunk),
    get puts() {
      return puts;
    },
  };
  source.sync();
  return source;
}
