/**
 * Buffer arenas (D1 §3.2): a few large GPU buffers ("blocks") that many users sub-allocate from,
 * so a scene of thousands of meshes binds a handful of buffers instead of one per mesh.
 *
 * Each block keeps a first-fit free list in bytes, sorted by offset. First fit without the walk
 * (generalized from Forge's vertex arena): per block and size class `k` (sizes from 2^k up to
 * 2^(k+1)), a skip index says how many ranges at the front are shorter than any size of that
 * class; a search starts there, and lands exactly where a walk from the front would.
 *
 * Blocks are tried in order, so the first fill and later ones drain as a scene moves on. `trim`
 * destroys empty blocks at the end (never the first); anything recorded against them (a render
 * bundle) must be rebuilt, which `version` tells a user.
 */

/** One allocation: `size` bytes at `offset` in block `block` (`arena.buffers[block]`). */
export interface ArenaAlloc {
  readonly block: number;
  readonly offset: number;
  readonly size: number;
}

/** What an arena holds; it sets the buffers' usage. */
export type ArenaKind = 'vertex' | 'index' | 'instance' | 'storage';

export interface ArenaDesc {
  kind: ArenaKind;
  /** Bytes per block (default 64 MiB, clamped to the device's `maxBufferSize`). */
  blockBytes?: number;
  /** Extra usage flags on every block (e.g. `GPUBufferUsage.STORAGE` on a vertex arena). */
  usage?: number;
  label?: string;
}

/** Size classes: class k holds sizes from 2^k to 2^(k+1) - 1 (the last, every size from 2^31). */
const CLASSES = 32;
const DEFAULT_BLOCK = 64 << 20;

interface Range {
  start: number;
  len: number;
}

function usageOf(kind: ArenaKind): number {
  const u = GPUBufferUsage;
  switch (kind) {
    case 'vertex':
      return u.VERTEX | u.COPY_DST;
    case 'index':
      return u.INDEX | u.COPY_DST;
    case 'instance':
      return u.VERTEX | u.STORAGE | u.COPY_DST;
    case 'storage':
      return u.STORAGE | u.COPY_DST;
  }
}

function classOf(bytes: number): number {
  return Math.min(31 - Math.clz32(bytes), CLASSES - 1);
}

/**
 * A pool of large GPU buffers with free-range allocation. `alloc` never creates a buffer unless
 * no block has room; `free` coalesces with neighbours.
 */
export class Arena {
  readonly kind: ArenaKind;
  readonly label: string;
  /** The blocks' buffers; `ArenaAlloc.block` indexes this. */
  readonly buffers: GPUBuffer[] = [];
  /** Bumped when a block is added or destroyed (anything recorded against `buffers` is stale). */
  version = 0;
  /** Bytes in use over every block. */
  usedBytes = 0;
  /** Allocations so far, and the free ranges they looked at to find room. */
  readonly stats = { allocs: 0, walked: 0, trimmed: 0 };
  private device: GPUDevice;
  private readonly blockBytes: number;
  private readonly usage: number;
  private readonly ranges: Range[][] = [];
  private readonly skip: Int32Array[] = [];
  private readonly capacity: number[] = [];
  private readonly used: number[] = [];

  constructor(device: GPUDevice, desc: ArenaDesc) {
    this.device = device;
    this.kind = desc.kind;
    this.label = desc.label ?? `${desc.kind} arena`;
    const max = (device.limits as { maxBufferSize?: number } | undefined)?.maxBufferSize;
    const want = desc.blockBytes ?? DEFAULT_BLOCK;
    this.blockBytes = Math.max(256, Math.min(want, max ?? want)) & ~3;
    this.usage = usageOf(desc.kind) | (desc.usage ?? 0);
  }

  /** Bytes the blocks hold, used or not. */
  get allocatedBytes(): number {
    let s = 0;
    for (const c of this.capacity) s += c;
    return s;
  }

  /**
   * `bytes` (rounded up to 4) at an offset that is a multiple of `align` (default 4; a vertex
   * layout's stride, so `offset / stride` is a base vertex). A request larger than a block gets a
   * block of its own.
   */
  alloc(bytes: number, align = 4): ArenaAlloc {
    if (!(bytes > 0)) throw new Error(`${this.label}: alloc of ${bytes} bytes`);
    const size = (bytes + 3) & ~3;
    this.stats.allocs++;
    const k = classOf(size);
    const least = 2 ** k;
    for (let b = 0; b < this.buffers.length; b++) {
      const list = this.ranges[b]!;
      const skip = this.skip[b]!;
      let i = skip[k]!;
      // Ranges too short for any size of this class are passed for good.
      while (i < list.length && list[i]!.len < least) {
        i++;
        this.stats.walked++;
      }
      skip[k] = i;
      for (; i < list.length; i++) {
        const r = list[i]!;
        this.stats.walked++;
        const start = Math.ceil(r.start / align) * align;
        const pad = start - r.start;
        if (r.len < pad + size) continue;
        const end = r.start + r.len;
        if (pad === 0) {
          r.start += size;
          r.len -= size;
          if (r.len === 0) this.removeAt(b, i);
        } else {
          // The pad stays free in front; what is left after goes in after it.
          r.len = pad;
          if (end > start + size) this.insertAt(b, i + 1, start + size, end - start - size);
        }
        this.usedBytes += size;
        this.used[b]! += size;
        return { block: b, offset: start, size };
      }
    }
    const cap = Math.max(this.blockBytes, size);
    const buffer = this.device.createBuffer({
      label: `${this.label} ${this.buffers.length}`,
      size: cap,
      usage: this.usage,
    });
    this.buffers.push(buffer);
    this.capacity.push(cap);
    this.used.push(size);
    this.ranges.push(size < cap ? [{ start: size, len: cap - size }] : []);
    this.skip.push(new Int32Array(CLASSES));
    this.usedBytes += size;
    this.version++;
    return { block: this.buffers.length - 1, offset: 0, size };
  }

  /** Give `a` back; its bytes are left as they are. */
  free(a: ArenaAlloc): void {
    const list = this.ranges[a.block]!;
    // The first free range at or after it (sorted by start: binary search, not a walk).
    let i = 0;
    let hi = list.length;
    while (i < hi) {
      const mid = (i + hi) >> 1;
      if (list[mid]!.start < a.offset) i = mid + 1;
      else hi = mid;
    }
    const prev = list[i - 1];
    const next = list[i];
    const joinsPrev = prev !== undefined && prev.start + prev.len === a.offset;
    const joinsNext = next !== undefined && a.offset + a.size === next.start;
    if (joinsPrev && joinsNext) {
      prev.len += a.size + next.len;
      this.removeAt(a.block, i);
      this.grew(a.block, i - 1, prev.len);
    } else if (joinsPrev) {
      prev.len += a.size;
      this.grew(a.block, i - 1, prev.len);
    } else if (joinsNext) {
      next.start = a.offset;
      next.len += a.size;
      this.grew(a.block, i, next.len);
    } else {
      this.insertAt(a.block, i, a.offset, a.size);
    }
    this.usedBytes -= a.size;
    this.used[a.block]! -= a.size;
  }

  /** Write `data` into `a` at `byteOffset` (default 0) within it. */
  write(a: ArenaAlloc, data: ArrayBufferView | ArrayBuffer, byteOffset = 0): void {
    const n = data.byteLength;
    if (byteOffset + n > a.size) {
      throw new Error(`${this.label}: write of ${n} B at ${byteOffset} past a ${a.size} B alloc`);
    }
    this.device.queue.writeBuffer(
      this.buffers[a.block]!,
      a.offset + byteOffset,
      data as GPUAllowSharedBufferSource,
    );
  }

  /**
   * Destroy empty blocks at the end (never the first) while what is in use fills at most three
   * quarters of the blocks left, so a block is not destroyed only to be made again at once.
   * Returns how many it destroyed (and bumps `version` when any).
   */
  trim(): number {
    let n = 0;
    while (this.buffers.length > 1 && this.used.at(-1) === 0) {
      let rest = 0;
      for (let b = 0; b < this.capacity.length - 1; b++) rest += this.capacity[b]!;
      if (this.usedBytes > rest * 0.75) break;
      this.buffers.pop()!.destroy();
      this.capacity.pop();
      this.used.pop();
      this.ranges.pop();
      this.skip.pop();
      n++;
    }
    if (n > 0) this.version++;
    this.stats.trimmed += n;
    return n;
  }

  /**
   * After a device loss: make every block again, the same size, on `device`. Allocations and
   * free ranges are kept, so every `ArenaAlloc` stays valid; the bytes are gone, and the owner
   * writes them again (`RenderCore.onDeviceRestored`). Bumps `version`.
   */
  restore(device: GPUDevice): void {
    this.device = device;
    for (let b = 0; b < this.buffers.length; b++) {
      this.buffers[b] = device.createBuffer({
        label: `${this.label} ${b}`,
        size: this.capacity[b]!,
        usage: this.usage,
      });
    }
    this.version++;
  }

  /** Destroy every block. */
  destroy(): void {
    for (const b of this.buffers) b.destroy();
    this.buffers.length = 0;
    this.capacity.length = 0;
    this.used.length = 0;
    this.ranges.length = 0;
    this.skip.length = 0;
    this.usedBytes = 0;
    this.version++;
  }

  /** Free ranges of block `b` (for tests): `[start, len]` pairs, sorted by start. */
  freeRanges(b: number): [number, number][] {
    return (this.ranges[b] ?? []).map((r) => [r.start, r.len]);
  }

  /** Insert a free range at index `i` of block `b`'s list, keeping the skip index exact. */
  private insertAt(b: number, i: number, start: number, len: number): void {
    this.ranges[b]!.splice(i, 0, { start, len });
    // The ranges from i on moved up one; the new one may be the first long enough.
    const skip = this.skip[b]!;
    for (let k = 0; k < CLASSES; k++) {
      if (skip[k]! < i) continue;
      skip[k] = len >= 2 ** k ? i : skip[k]! + 1;
    }
  }

  /** Remove free range `i` of block `b`: the ranges after it move down one. */
  private removeAt(b: number, i: number): void {
    this.ranges[b]!.splice(i, 1);
    const skip = this.skip[b]!;
    for (let k = 0; k < CLASSES; k++) if (skip[k]! > i) skip[k]!--;
  }

  /** Free range `i` of block `b` grew to `len`: classes it now fits start no later than it. */
  private grew(b: number, i: number, len: number): void {
    const skip = this.skip[b]!;
    for (let k = 0; k < CLASSES && 2 ** k <= len; k++) if (skip[k]! > i) skip[k] = i;
  }
}

/** A new arena on `device` (D1 §3.1 `renderer.arena(kind)`). */
export function createArena(device: GPUDevice, desc: ArenaDesc): Arena {
  return new Arena(device, desc);
}
