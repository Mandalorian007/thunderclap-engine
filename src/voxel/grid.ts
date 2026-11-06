/**
 * The block grid: one `Uint8Array` of block ids (0 = air) over a box of `sizeX × sizeY × sizeZ`
 * cells, cut into cubic chunks of `chunk` cells on a side. Cell (x, y, z) lives at
 * `x + sizeX * (y + sizeY * z)`; chunk (cx, cy, cz) is `cx + chunksX * (cy + chunksY * cz)`.
 * Every `set` bumps `version` and flags the chunk it touched, plus the chunks sharing that
 * cell's faces, edges and corners when it lies on a border (a face there changes the
 * neighbour's ambient occlusion). `serialize()` packs the grid into one `ArrayBuffer` a Worker
 * can own (`deserializeVoxelGrid`), so the mesher runs off the thread on its own copy.
 * Pure: no GPU, no DOM.
 */

export interface VoxelGridOptions {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** Cells on a chunk's side. Default 16. The sizes need not be multiples of it. */
  chunk?: number;
}

/** What a grid reports to its subscribers (`VoxelGrid.subscribe`). */
export interface VoxelGridListener {
  /** One cell changed to `block`. */
  set?(x: number, y: number, z: number, block: number): void;
  /** Every cell may have changed (`fill`, `deserialize`): resync whole. */
  reset?(): void;
}

export interface VoxelGrid {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** Cells on a chunk's side. */
  readonly chunk: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunksZ: number;
  /** Chunks in the grid (`chunksX * chunksY * chunksZ`). */
  readonly chunkCount: number;
  /** The cells, `x + sizeX * (y + sizeY * z)`. Writing it directly bypasses the dirty flags. */
  readonly data: Uint8Array;
  /** Bumps on every change (`set`, `setMany`, `fill`, `deserialize`). */
  readonly version: number;
  /** Dirty flag per chunk (1 = needs a remesh). */
  readonly dirty: Uint8Array;
  inBounds(x: number, y: number, z: number): boolean;
  /** The cell's index in `data`; no bounds check. */
  index(x: number, y: number, z: number): number;
  /** The block at (x, y, z); `outside` (default 0) when out of bounds. */
  get(x: number, y: number, z: number, outside?: number): number;
  /** Set one cell; out of bounds is ignored. Returns whether the cell changed. */
  set(x: number, y: number, z: number, block: number): boolean;
  /** Set cells from a flat `[x, y, z, block, ...]` list. Returns how many changed. */
  setMany(cells: ArrayLike<number>): number;
  /** Every cell from `fn`; flags every chunk dirty. */
  fill(fn: (x: number, y: number, z: number) => number): void;
  /** Index of the chunk holding cell (x, y, z), -1 out of bounds. */
  chunkAt(x: number, y: number, z: number): number;
  /** Chunk index from chunk coordinates; no bounds check. */
  chunkIndex(cx: number, cy: number, cz: number): number;
  /** Chunk coordinates of a chunk index, into `out` (`[cx, cy, cz]`). */
  chunkCoords(chunk: number, out: number[] | Float32Array | Int32Array): void;
  /** True when no cell of the chunk is a block. */
  chunkEmpty(chunk: number): boolean;
  isDirty(chunk: number): boolean;
  markDirty(chunk: number): void;
  /** Flag every chunk. */
  markAllDirty(): void;
  clearDirty(chunk: number): void;
  /** Calls `fn` for each dirty chunk, clearing its flag first; returns how many. */
  forEachDirtyChunk(fn: (chunk: number) => void): number;
  /**
   * One `ArrayBuffer`: a 16-byte header (sizeX, sizeY, sizeZ, chunk as uint32) then the
   * cells. Transferable; `deserializeVoxelGrid` rebuilds the grid from it.
   */
  serialize(): ArrayBuffer;
  /** Copy the cells of a serialized grid of the same sizes into this one; every chunk dirty. */
  deserialize(buffer: ArrayBuffer): void;
  /** Mirror changes elsewhere (a mesher Worker). Returns the unsubscriber. */
  subscribe(listener: VoxelGridListener): () => void;
}

const HEADER_BYTES = 16;

class Grid implements VoxelGrid {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly chunk: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunksZ: number;
  readonly chunkCount: number;
  readonly data: Uint8Array;
  readonly dirty: Uint8Array;
  version = 0;
  private readonly listeners: VoxelGridListener[] = [];

  constructor(opts: VoxelGridOptions, data?: Uint8Array) {
    const chunk = opts.chunk ?? 16;
    if (!(chunk >= 1) || !(opts.sizeX >= 1) || !(opts.sizeY >= 1) || !(opts.sizeZ >= 1)) {
      throw new Error('createVoxelGrid: sizes and chunk must be at least 1');
    }
    this.sizeX = Math.floor(opts.sizeX);
    this.sizeY = Math.floor(opts.sizeY);
    this.sizeZ = Math.floor(opts.sizeZ);
    this.chunk = Math.floor(chunk);
    this.chunksX = Math.ceil(this.sizeX / this.chunk);
    this.chunksY = Math.ceil(this.sizeY / this.chunk);
    this.chunksZ = Math.ceil(this.sizeZ / this.chunk);
    this.chunkCount = this.chunksX * this.chunksY * this.chunksZ;
    this.data = data ?? new Uint8Array(this.sizeX * this.sizeY * this.sizeZ);
    this.dirty = new Uint8Array(this.chunkCount).fill(1);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sizeX && y < this.sizeY && z < this.sizeZ;
  }

  index(x: number, y: number, z: number): number {
    return x + this.sizeX * (y + this.sizeY * z);
  }

  get(x: number, y: number, z: number, outside = 0): number {
    if (!this.inBounds(x, y, z)) return outside;
    return this.data[x + this.sizeX * (y + this.sizeY * z)]!;
  }

  set(x: number, y: number, z: number, block: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);
    if (this.data[i] === block) return false;
    this.data[i] = block;
    this.version++;
    this.touch(x, y, z);
    for (const l of this.listeners) l.set?.(x, y, z, block);
    return true;
  }

  setMany(cells: ArrayLike<number>): number {
    let changed = 0;
    for (let i = 0; i + 3 < cells.length; i += 4) {
      if (this.set(cells[i]!, cells[i + 1]!, cells[i + 2]!, cells[i + 3]!)) changed++;
    }
    return changed;
  }

  fill(fn: (x: number, y: number, z: number) => number): void {
    const d = this.data;
    let i = 0;
    for (let z = 0; z < this.sizeZ; z++) {
      for (let y = 0; y < this.sizeY; y++) {
        for (let x = 0; x < this.sizeX; x++) d[i++] = fn(x, y, z);
      }
    }
    this.version++;
    this.markAllDirty();
    for (const l of this.listeners) l.reset?.();
  }

  chunkAt(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return -1;
    const c = this.chunk;
    return this.chunkIndex(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c));
  }

  chunkIndex(cx: number, cy: number, cz: number): number {
    return cx + this.chunksX * (cy + this.chunksY * cz);
  }

  chunkCoords(chunk: number, out: number[] | Float32Array | Int32Array): void {
    const cx = chunk % this.chunksX;
    const rest = (chunk - cx) / this.chunksX;
    const cy = rest % this.chunksY;
    out[0] = cx;
    out[1] = cy;
    out[2] = (rest - cy) / this.chunksY;
  }

  chunkEmpty(chunk: number): boolean {
    const c = this.chunk;
    const cx = chunk % this.chunksX;
    const rest = (chunk - cx) / this.chunksX;
    const cy = rest % this.chunksY;
    const cz = (rest - cy) / this.chunksY;
    const x1 = Math.min(this.sizeX, (cx + 1) * c);
    const y1 = Math.min(this.sizeY, (cy + 1) * c);
    const z1 = Math.min(this.sizeZ, (cz + 1) * c);
    const d = this.data;
    for (let z = cz * c; z < z1; z++) {
      for (let y = cy * c; y < y1; y++) {
        const row = this.sizeX * (y + this.sizeY * z);
        for (let x = cx * c; x < x1; x++) if (d[row + x] !== 0) return false;
      }
    }
    return true;
  }

  isDirty(chunk: number): boolean {
    return this.dirty[chunk] === 1;
  }

  markDirty(chunk: number): void {
    if (chunk >= 0 && chunk < this.chunkCount) this.dirty[chunk] = 1;
  }

  markAllDirty(): void {
    this.dirty.fill(1);
  }

  clearDirty(chunk: number): void {
    if (chunk >= 0 && chunk < this.chunkCount) this.dirty[chunk] = 0;
  }

  forEachDirtyChunk(fn: (chunk: number) => void): number {
    let n = 0;
    const d = this.dirty;
    for (let c = 0; c < d.length; c++) {
      if (d[c] !== 1) continue;
      d[c] = 0;
      n++;
      fn(c);
    }
    return n;
  }

  serialize(): ArrayBuffer {
    const buffer = new ArrayBuffer(HEADER_BYTES + this.data.length);
    const header = new Uint32Array(buffer, 0, 4);
    header[0] = this.sizeX;
    header[1] = this.sizeY;
    header[2] = this.sizeZ;
    header[3] = this.chunk;
    new Uint8Array(buffer, HEADER_BYTES).set(this.data);
    return buffer;
  }

  deserialize(buffer: ArrayBuffer): void {
    const header = readHeader(buffer);
    if (
      header.sizeX !== this.sizeX ||
      header.sizeY !== this.sizeY ||
      header.sizeZ !== this.sizeZ ||
      header.chunk !== this.chunk
    ) {
      throw new Error('VoxelGrid.deserialize: the buffer holds a grid of other sizes');
    }
    this.data.set(new Uint8Array(buffer, HEADER_BYTES, this.data.length));
    this.version++;
    this.markAllDirty();
    for (const l of this.listeners) l.reset?.();
  }

  subscribe(listener: VoxelGridListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Flag the chunk of (x, y, z) and every chunk within one cell of it. */
  private touch(x: number, y: number, z: number): void {
    const c = this.chunk;
    const cx = Math.floor(x / c);
    const cy = Math.floor(y / c);
    const cz = Math.floor(z / c);
    const x0 = x % c === 0 && cx > 0 ? cx - 1 : cx;
    const x1 = x % c === c - 1 && cx + 1 < this.chunksX ? cx + 1 : cx;
    const y0 = y % c === 0 && cy > 0 ? cy - 1 : cy;
    const y1 = y % c === c - 1 && cy + 1 < this.chunksY ? cy + 1 : cy;
    const z0 = z % c === 0 && cz > 0 ? cz - 1 : cz;
    const z1 = z % c === c - 1 && cz + 1 < this.chunksZ ? cz + 1 : cz;
    for (let k = z0; k <= z1; k++) {
      for (let j = y0; j <= y1; j++) {
        for (let i = x0; i <= x1; i++) this.dirty[this.chunkIndex(i, j, k)] = 1;
      }
    }
  }
}

function readHeader(buffer: ArrayBuffer): VoxelGridOptions {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('voxel grid buffer: too short');
  const h = new Uint32Array(buffer, 0, 4);
  const opts = { sizeX: h[0]!, sizeY: h[1]!, sizeZ: h[2]!, chunk: h[3]! };
  if (buffer.byteLength !== HEADER_BYTES + opts.sizeX * opts.sizeY * opts.sizeZ) {
    throw new Error('voxel grid buffer: length does not match its header');
  }
  return opts;
}

/** A grid of air. */
export function createVoxelGrid(opts: VoxelGridOptions): VoxelGrid {
  return new Grid(opts);
}

/**
 * A grid over the cells of a `serialize()` buffer: the grid reads and writes that buffer in
 * place (no copy), so a Worker handed the transferred buffer owns the cells.
 */
export function deserializeVoxelGrid(buffer: ArrayBuffer): VoxelGrid {
  const opts = readHeader(buffer);
  return new Grid(opts, new Uint8Array(buffer, HEADER_BYTES));
}
