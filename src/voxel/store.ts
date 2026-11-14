/**
 * `SectionStore`: the page's copy of a streamed voxel world, sparse and keyed by section. Each
 * section is kept as it arrived (the game codec's bytes, or one cell for a uniform section)
 * and decoded only when edited or read; a short summary per section (column tops, whether
 * its top cells are liquid, whether it holds an emitter) is all meshing needs beyond that.
 *
 * It tracks which sections need a mesh (`dirty`), which of those can be meshed (`ready`: the
 * 26 around are known), hands them out nearest the point of interest first (`takeReady`), and
 * makes their self-contained Worker jobs (`jobFor`). `edit` changes cells and returns every
 * section whose mesh it changed.
 */
import {
  type SectionCodec,
  sectionKey,
  sectionKeyX,
  sectionKeyY,
  sectionKeyZ,
  type VoxelFormat,
} from './format';
import {
  HEIGHT_OPEN,
  packSources,
  type SectionJob,
  type SourceSection,
  sourceIndex,
} from './sources';

/** Options for `createSectionStore`. */
export interface SectionStoreOptions {
  format: VoxelFormat;
  codec: SectionCodec;
  /** The cell of empty space (a `none` block). Default 0. */
  air?: number;
  /**
   * The world's section rows, inclusive: sections above or below count as known, filled with
   * `outside` below and `air` above. Default: no limit (every neighbour must arrive).
   */
  minSectionY?: number;
  maxSectionY?: number;
  /** The cell below `minSectionY`. Default `air`. */
  outside?: number;
}

/** What `SectionStore.stats` reports. */
export interface SectionStoreStats {
  sections: number;
  /** Sections held decoded (edited ones). */
  decoded: number;
  /** Sections waiting for a mesh. */
  dirty: number;
  /** Bytes held: encoded sections plus decoded cells. */
  bytes: number;
}

/** See the file comment. Keys are `sectionKey(sx, sy, sz)`. */
export interface SectionStore {
  readonly format: VoxelFormat;
  /** Add or replace a section from its encoded bytes. Marks it and its known neighbours dirty. */
  putSection(sx: number, sy: number, sz: number, bytes: Uint8Array): void;
  /** Forget a section (it left the world's interest area). */
  dropSection(key: number): void;
  has(key: number): boolean;
  /** Present, and every one of the 26 around it known. */
  ready(key: number): boolean;
  /** The cell at a world block, or undefined when its section is not here. */
  cellAt(x: number, y: number, z: number): number | undefined;
  /**
   * Set cells of one section: `changes` is `[index, cell, index, cell, ...]` with
   * `index = x + z * size + y * size²` (local). Returns the keys of every section whose mesh
   * changed (the section, the neighbours sharing its edited border, those below whose sky
   * light moved, and all 27 around when emitters are near), all of them marked dirty.
   */
  edit(key: number, changes: ArrayLike<number>): number[];
  /** The point (world blocks) meshing is nearest-first from. */
  setInterest(x: number, y: number, z: number): void;
  /** Mark a section as needing a mesh (a render setting changed). */
  markDirty(key: number): void;
  /**
   * Move up to `max` dirty ready sections, nearest the interest point first, into `out`
   * (cleared first) and out of the dirty set. Returns how many.
   */
  takeReady(out: number[], max: number): number;
  /** A ready section's mesh job; its buffers are fresh and transferable. */
  jobFor(key: number): SectionJob;
  stats(): SectionStoreStats;
}

interface Entry {
  bytes: Uint8Array | null;
  uniform: number | null;
  cells: Uint32Array | null;
  /** Per column (x + z·size): the highest non-`none` local y, or −1. */
  tops: Int8Array;
  /** Per column: 1 where that top cell is liquid. */
  wet: Uint8Array;
  glow: boolean;
}

/** Make a store (see `SectionStore`). */
export function createSectionStore(opts: SectionStoreOptions): SectionStore {
  const format = opts.format;
  const codec = opts.codec;
  const S = format.size;
  const SA = S * S;
  const volume = SA * S;
  const P = S + 2;
  const air = opts.air ?? 0;
  const outside = opts.outside ?? air;
  const minY = opts.minSectionY ?? Number.NEGATIVE_INFINITY;
  const maxY = opts.maxSectionY ?? Number.POSITIVE_INFINITY;
  const { idShift, idMask } = format;
  const { faceClass, emission } = format.blocks;
  const NONE = 0;
  const LIQUID = 2;
  const entries = new Map<number, Entry>();
  /** Section rows present per section column (`sectionKey(sx, 0, sz)`), for column heights. */
  const columns = new Map<number, Set<number>>();
  const dirty = new Set<number>();
  const scratch = new Uint32Array(volume);
  let cacheKey = -1;
  let cacheCells: Uint32Array | null = null;
  const interest = [0, 0, 0];

  const idOf = (cell: number): number => (cell >>> idShift) & idMask;
  const isNone = (cell: number): boolean => faceClass[idOf(cell)] === NONE;

  function summarize(e: Entry, cells: Uint32Array | null, one: number | null): void {
    e.tops.fill(-1);
    e.wet.fill(0);
    e.glow = false;
    if (one !== null) {
      if (!isNone(one)) {
        e.tops.fill(S - 1);
        if (faceClass[idOf(one)] === LIQUID) e.wet.fill(1);
      }
      e.glow = (emission[idOf(one)] ?? 0) > 0;
      return;
    }
    const c = cells!;
    for (let col = 0; col < SA; col++) {
      for (let y = S - 1; y >= 0; y--) {
        const cell = c[col + y * SA];
        if (isNone(cell)) continue;
        e.tops[col] = y;
        e.wet[col] = faceClass[idOf(cell)] === LIQUID ? 1 : 0;
        break;
      }
    }
    if (format.blocks.emissive) {
      for (let i = 0; i < volume; i++) {
        if ((emission[idOf(c[i])] ?? 0) > 0) {
          e.glow = true;
          break;
        }
      }
    }
  }

  const known = (sx: number, sy: number, sz: number): boolean =>
    sy < minY || sy > maxY || entries.has(sectionKey(sx, sy, sz));

  function markAround(sx: number, sy: number, sz: number): void {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = sectionKey(sx + dx, sy + dy, sz + dz);
          if (entries.has(k)) dirty.add(k);
        }
      }
    }
  }

  function decoded(key: number, e: Entry): Uint32Array {
    if (e.cells) return e.cells;
    if (cacheKey === key && cacheCells) return cacheCells;
    cacheCells ??= new Uint32Array(volume);
    if (e.uniform !== null) cacheCells.fill(e.uniform);
    else {
      const one = codec.decode(e.bytes!, cacheCells);
      if (one !== null) cacheCells.fill(one);
    }
    cacheKey = key;
    return cacheCells;
  }

  /** World y of the highest non-`none` cell over world column (x, z), and whether it is liquid. */
  let topWet = 0;
  function columnTop(x: number, z: number): number {
    const sx = Math.floor(x / S);
    const sz = Math.floor(z / S);
    const rows = columns.get(sectionKey(sx, 0, sz));
    topWet = 0;
    if (!rows) return HEIGHT_OPEN;
    const col = x - sx * S + (z - sz * S) * S;
    let best = HEIGHT_OPEN;
    for (const sy of rows) {
      if (sy * S + S - 1 <= best) continue;
      const e = entries.get(sectionKey(sx, sy, sz))!;
      const t = e.tops[col];
      if (t >= 0 && sy * S + t > best) {
        best = sy * S + t;
        topWet = e.wet[col];
      }
    }
    return best;
  }

  const store: SectionStore = {
    format,

    putSection(sx, sy, sz, bytes) {
      const key = sectionKey(sx, sy, sz);
      if (cacheKey === key) cacheKey = -1;
      const one = codec.decode(bytes, scratch);
      const e: Entry = {
        bytes: one === null ? bytes : null,
        uniform: one,
        cells: null,
        tops: new Int8Array(SA),
        wet: new Uint8Array(SA),
        glow: false,
      };
      summarize(e, one === null ? scratch : null, one);
      entries.set(key, e);
      const ck = sectionKey(sx, 0, sz);
      let rows = columns.get(ck);
      if (!rows) {
        rows = new Set();
        columns.set(ck, rows);
      }
      rows.add(sy);
      markAround(sx, sy, sz);
    },

    dropSection(key) {
      if (!entries.delete(key)) return;
      if (cacheKey === key) cacheKey = -1;
      dirty.delete(key);
      const ck = sectionKey(sectionKeyX(key), 0, sectionKeyZ(key));
      const rows = columns.get(ck);
      rows?.delete(sectionKeyY(key));
      if (rows && rows.size === 0) columns.delete(ck);
    },

    has: (key) => entries.has(key),

    ready(key) {
      if (!entries.has(key)) return false;
      const sx = sectionKeyX(key);
      const sy = sectionKeyY(key);
      const sz = sectionKeyZ(key);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) if (!known(sx + dx, sy + dy, sz + dz)) return false;
        }
      }
      return true;
    },

    cellAt(x, y, z) {
      const sx = Math.floor(x / S);
      const sy = Math.floor(y / S);
      const sz = Math.floor(z / S);
      const key = sectionKey(sx, sy, sz);
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.uniform !== null && !e.cells) return e.uniform;
      return decoded(key, e)[x - sx * S + (z - sz * S) * S + (y - sy * S) * SA];
    },

    edit(key, changes) {
      const e = entries.get(key);
      if (!e) throw new Error('edit: the section is not in the store');
      const sx = sectionKeyX(key);
      const sy = sectionKeyY(key);
      const sz = sectionKeyZ(key);
      if (!e.cells) {
        const cells = new Uint32Array(volume);
        cells.set(decoded(key, e));
        e.cells = cells;
        e.bytes = null;
        e.uniform = null;
        if (cacheKey === key) cacheKey = -1;
      }
      const cells = e.cells;
      const oldTops = e.tops.slice();
      const wasGlow = e.glow;
      // The box the edit spans (x, y, z): which neighbours' borders it touches.
      const lo = [S, S, S];
      const hi = [-1, -1, -1];
      let changed = false;
      for (let k = 0; k + 1 < changes.length; k += 2) {
        const i = changes[k];
        if (i < 0 || i >= volume)
          throw new RangeError(`edit: cell index ${i} is outside the section`);
        if (cells[i] === changes[k + 1] >>> 0) continue;
        cells[i] = changes[k + 1] >>> 0;
        changed = true;
        const x = i % S;
        const z = Math.floor(i / S) % S;
        const y = Math.floor(i / SA);
        lo[0] = Math.min(lo[0], x);
        lo[1] = Math.min(lo[1], y);
        lo[2] = Math.min(lo[2], z);
        hi[0] = Math.max(hi[0], x);
        hi[1] = Math.max(hi[1], y);
        hi[2] = Math.max(hi[2], z);
      }
      if (!changed) return [];
      summarize(e, cells, null);
      const out = new Set<number>([key]);
      const range = (axis: number): [number, number] => [
        lo[axis] === 0 ? -1 : 0,
        hi[axis] === S - 1 ? 1 : 0,
      ];
      const [x0, x1] = range(0);
      const [y0, y1] = range(1);
      const [z0, z1] = range(2);
      for (let dy = y0; dy <= y1; dy++) {
        for (let dz = z0; dz <= z1; dz++) {
          for (let dx = x0; dx <= x1; dx++) out.add(sectionKey(sx + dx, sy + dy, sz + dz));
        }
      }
      // Sky light: a column top that moved changes the light below it (down to where its
      // falloff reaches zero), in this column of sections and the ones beside it.
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (let c = 0; c < SA; c++) {
        if (oldTops[c] === e.tops[c]) continue;
        const a = sy * S + Math.max(oldTops[c], e.tops[c]);
        const b = sy * S + Math.min(oldTops[c], e.tops[c]);
        if (a > high) high = a;
        if (b < low) low = b;
      }
      if (high > Number.NEGATIVE_INFINITY) {
        const reach =
          Math.ceil(15 / Math.max(1, Math.min(format.skyFalloff, format.liquidSkyFalloff))) + 1;
        const syLow = Math.floor((low - reach) / S);
        const syHigh = Math.floor((high + 1) / S);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const rows = columns.get(sectionKey(sx + dx, 0, sz + dz));
            if (!rows) continue;
            for (const r of rows)
              if (r >= syLow && r <= syHigh) out.add(sectionKey(sx + dx, r, sz + dz));
          }
        }
      }
      // Block light reaches past the border: near any emitter, all 27 around.
      let glow = wasGlow || e.glow;
      for (let dy = -1; dy <= 1 && !glow; dy++) {
        for (let dz = -1; dz <= 1 && !glow; dz++) {
          for (let dx = -1; dx <= 1 && !glow; dx++) {
            if (entries.get(sectionKey(sx + dx, sy + dy, sz + dz))?.glow) glow = true;
          }
        }
      }
      if (glow) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) out.add(sectionKey(sx + dx, sy + dy, sz + dz));
          }
        }
      }
      const keys: number[] = [];
      for (const k of out) {
        if (!entries.has(k)) continue;
        keys.push(k);
        dirty.add(k);
      }
      return keys;
    },

    setInterest(x, y, z) {
      interest[0] = x;
      interest[1] = y;
      interest[2] = z;
    },

    markDirty(key) {
      if (entries.has(key)) dirty.add(key);
    },

    takeReady(out, max) {
      out.length = 0;
      if (max <= 0) return 0;
      const dist: number[] = [];
      const half = S / 2;
      for (const k of dirty) {
        if (!store.ready(k)) continue;
        const dx = sectionKeyX(k) * S + half - interest[0];
        const dy = sectionKeyY(k) * S + half - interest[1];
        const dz = sectionKeyZ(k) * S + half - interest[2];
        const d = dx * dx + dy * dy + dz * dz;
        // Keep the `max` nearest, sorted, by insertion.
        if (out.length === max && d >= dist[max - 1]) continue;
        let at = out.length < max ? out.length : max - 1;
        while (at > 0 && dist[at - 1] > d) {
          if (at < max) {
            out[at] = out[at - 1];
            dist[at] = dist[at - 1];
          }
          at--;
        }
        out[at] = k;
        dist[at] = d;
      }
      for (const k of out) dirty.delete(k);
      return out.length;
    },

    jobFor(key) {
      const e = entries.get(key);
      if (!e) throw new Error('jobFor: the section is not in the store');
      const sx = sectionKeyX(key);
      const sy = sectionKeyY(key);
      const sz = sectionKeyZ(key);
      const sources: SourceSection[] = new Array(27);
      let glow = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i = sourceIndex(dx, dy, dz);
            const ny = sy + dy;
            const n = entries.get(sectionKey(sx + dx, ny, sz + dz));
            if (!n) {
              if (ny >= minY && ny <= maxY) throw new Error('jobFor: the section is not ready');
              sources[i] = ny < minY ? outside : air;
              continue;
            }
            if (n.glow) glow |= 1 << i;
            sources[i] = n.cells ?? (n.uniform !== null ? n.uniform : n.bytes!);
          }
        }
      }
      if (!format.blocks.emissive) glow = 0;
      const { layout, data } = packSources(S, sources, glow !== 0);
      const heights = new Int32Array(P * P);
      const wetTops = new Uint8Array(P * P);
      for (let pz = 0; pz < P; pz++) {
        for (let px = 0; px < P; px++) {
          heights[px + pz * P] = columnTop(sx * S + px - 1, sz * S + pz - 1);
          wetTops[px + pz * P] = topWet;
        }
      }
      return { sx, sy, sz, layout, data, air, heights, wetTops, glow: glow || undefined };
    },

    stats() {
      let decodedCount = 0;
      let bytes = 0;
      for (const e of entries.values()) {
        if (e.cells) {
          decodedCount++;
          bytes += e.cells.byteLength;
        } else if (e.bytes) bytes += e.bytes.byteLength;
        else bytes += 4;
      }
      return { sections: entries.size, decoded: decodedCount, dirty: dirty.size, bytes };
    },
  };
  return store;
}
