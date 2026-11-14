/**
 * Mesh jobs: one section plus a one-cell border, self-contained so a Worker can mesh it.
 *
 * The page does not build the padded volume. A job (`SectionJob`) carries the 27 sections
 * around the one to mesh as the store holds them (one cell, the bytes they arrived as, or
 * decoded cells: only the face, edge or corner of a neighbour the border reads), in one
 * transferable buffer; the Worker decodes them with the game's codec into the padded volume
 * (`SectionInputBuilder`). A job near glowing blocks carries all 27 whole: block light reaches
 * past the border, so the Worker floods it through the 3×3×3 "wide" volume (light.ts).
 */
import type { SectionCodec, VoxelFormat } from './format';

/** Height for a column with nothing known above: no sky light reaches it. */
export const HEIGHT_BLOCKED = 0x7fffffff;
/** Height for a column with nothing in it: open to the sky all the way down. */
export const HEIGHT_OPEN = -0x80000000;

/** The mesher's input, as `SectionInputBuilder.build` returns it (reused per builder). */
export interface SectionInput {
  sx: number;
  sy: number;
  sz: number;
  /** Cells of the section and a one-cell border: `(size + 2)³`, index `padIndex`. */
  blocks: Uint32Array;
  /**
   * The world y of the highest non-`none` cell over each padded column (index
   * `px + pz * (size + 2)`), `HEIGHT_OPEN` or `HEIGHT_BLOCKED`. Cells above it see the sky.
   */
  heights: Int32Array;
  /** Per padded column: 1 where the column's top cell is liquid. */
  wetTops?: Uint8Array;
  /** Near glowing blocks: the 27 sections whole (`(3 × size)³`, the section at size..2size−1). */
  wide?: Uint32Array;
  /** Which of the 27 may hold an emitter (bits in `sourceIndex` order). */
  glowSources?: number;
}

/** How a source section is given in `SectionJob.layout`. */
const SOURCE_CELL = 0;
const SOURCE_BYTES = 1;
const SOURCE_CELLS = 2;

/** The index of neighbour (dx, dy, dz), each −1..1, among a job's 27 sources. */
export function sourceIndex(dx: number, dy: number, dz: number): number {
  return dx + 1 + (dz + 1) * 3 + (dy + 1) * 9;
}

/** A mesh job as the page sends it (see the file comment). Its buffers transfer. */
export interface SectionJob {
  sx: number;
  sy: number;
  sz: number;
  /** 27 × 3 words: kind and its operands per source (`sourceIndex` order). Shares `data`'s buffer. */
  layout: Uint32Array;
  data: Uint8Array;
  /** The cell of air, what the padded volume starts as. */
  air: number;
  heights: Int32Array;
  wetTops?: Uint8Array;
  /** Which of the 27 may hold an emitter; with any, every source is whole. */
  glow?: number;
}

/** A source section as the store hands it over: one cell, encoded bytes, or decoded cells. */
export type SourceSection = number | Uint8Array | Uint32Array;

const LAYOUT_BYTES = 27 * 3 * 4;

function regionCells(size: number, i: number): number {
  const dx = (i % 3) - 1;
  const dz = (Math.floor(i / 3) % 3) - 1;
  const dy = Math.floor(i / 9) - 1;
  return (dx ? 1 : size) * (dy ? 1 : size) * (dz ? 1 : size);
}

/**
 * Pack 27 sources (`sourceIndex` order) into one buffer for a job: each one's bytes, or of
 * decoded cells only those the border reads (a few KB for most jobs). `whole` (a job near
 * glowing blocks) copies decoded sections whole.
 */
export function packSources(
  size: number,
  sources: readonly SourceSection[],
  whole = false,
): { layout: Uint32Array; data: Uint8Array } {
  const volume = size * size * size;
  const cellsOf = (i: number): number => (whole ? volume : regionCells(size, i));
  let bytes = LAYOUT_BYTES;
  for (let i = 0; i < 27; i++) {
    const s = sources[i];
    if (typeof s === 'number') continue;
    bytes += s instanceof Uint32Array ? cellsOf(i) * 4 : (s.byteLength + 3) & ~3;
  }
  const buf = new ArrayBuffer(bytes);
  const layout = new Uint32Array(buf, 0, 81);
  const all = new Uint8Array(buf);
  let at = LAYOUT_BYTES;
  const area = size * size;
  for (let i = 0; i < 27; i++) {
    const s = sources[i];
    const o = i * 3;
    if (typeof s === 'number') {
      layout[o] = SOURCE_CELL;
      layout[o + 1] = s;
    } else if (s instanceof Uint32Array) {
      const n = cellsOf(i);
      layout[o] = SOURCE_CELLS;
      layout[o + 1] = at;
      layout[o + 2] = n;
      const out = new Uint32Array(buf, at, n);
      if (n === volume) {
        out.set(s);
      } else {
        // The neighbour's face, edge or corner, in the builder's order (y, then z, then x).
        const dx = (i % 3) - 1;
        const dz = (Math.floor(i / 3) % 3) - 1;
        const dy = Math.floor(i / 9) - 1;
        const x0 = dx < 0 ? size - 1 : 0;
        const x1 = dx > 0 ? 1 : size;
        const z0 = dz < 0 ? size - 1 : 0;
        const z1 = dz > 0 ? 1 : size;
        const y0 = dy < 0 ? size - 1 : 0;
        const y1 = dy > 0 ? 1 : size;
        let q = 0;
        for (let y = y0; y < y1; y++) {
          for (let z = z0; z < z1; z++) {
            for (let x = x0; x < x1; x++) out[q++] = s[x + z * size + y * area];
          }
        }
      }
      at += n * 4;
    } else {
      layout[o] = SOURCE_BYTES;
      layout[o + 1] = at;
      layout[o + 2] = s.byteLength;
      all.set(s, at);
      at += (s.byteLength + 3) & ~3;
    }
  }
  return { layout, data: all };
}

/** The buffers a job hands to its Worker without copying. */
export function jobTransfers(job: SectionJob): ArrayBuffer[] {
  const out: ArrayBuffer[] = [job.layout.buffer as ArrayBuffer, job.heights.buffer as ArrayBuffer];
  if (job.wetTops) out.push(job.wetTops.buffer as ArrayBuffer);
  return out;
}

/**
 * Builds mesher inputs from jobs, reusing its volumes (one per thread): the input it returns
 * holds until the next `build`.
 */
export class SectionInputBuilder {
  readonly pad: number;
  private readonly size: number;
  private readonly blocks: Uint32Array;
  private readonly scratch: Uint32Array;
  private wideScratch: Uint32Array | null = null;
  private readonly input: SectionInput;

  constructor(
    format: VoxelFormat,
    private readonly codec: SectionCodec,
  ) {
    this.size = format.size;
    this.pad = format.size + 2;
    this.blocks = new Uint32Array(this.pad * this.pad * this.pad);
    this.scratch = new Uint32Array(format.size * format.size * format.size);
    this.input = { sx: 0, sy: 0, sz: 0, blocks: this.blocks, heights: new Int32Array(0) };
  }

  build(job: SectionJob): SectionInput {
    const input = this.input;
    input.sx = job.sx;
    input.sy = job.sy;
    input.sz = job.sz;
    input.heights = job.heights;
    input.wetTops = job.wetTops;
    input.wide = undefined;
    input.glowSources = undefined;
    if (job.glow) this.buildWide(job, job.glow);
    else this.buildPadded(job);
    return input;
  }

  private decode(job: SectionJob, o: number): number | null {
    const { layout, data } = job;
    return this.codec.decode(
      data.subarray(layout[o + 1], layout[o + 1] + layout[o + 2]),
      this.scratch,
    );
  }

  private buildPadded(job: SectionJob): void {
    const S = this.size;
    const P = this.pad;
    const PA = P * P;
    const SA = S * S;
    const blocks = this.blocks;
    const air = job.air;
    blocks.fill(air);
    const { layout, data } = job;
    for (let dy = -1; dy <= 1; dy++) {
      const syFrom = dy < 0 ? S - 1 : 0;
      const syTo = dy > 0 ? 1 : S;
      const pyFrom = dy < 0 ? 0 : dy > 0 ? S + 1 : 1;
      for (let dz = -1; dz <= 1; dz++) {
        const szFrom = dz < 0 ? S - 1 : 0;
        const szTo = dz > 0 ? 1 : S;
        const pzFrom = dz < 0 ? 0 : dz > 0 ? S + 1 : 1;
        for (let dx = -1; dx <= 1; dx++) {
          const sxFrom = dx < 0 ? S - 1 : 0;
          const width = dx === 0 ? S : 1;
          const pxFrom = dx < 0 ? 0 : dx > 0 ? S + 1 : 1;
          const o = sourceIndex(dx, dy, dz) * 3;
          const kind = layout[o];
          let one: number | null;
          if (kind === SOURCE_CELL) {
            one = layout[o + 1];
          } else if (kind === SOURCE_CELLS) {
            const n = layout[o + 2];
            const cells = new Uint32Array(data.buffer, data.byteOffset + layout[o + 1], n);
            const full = n === S * S * S;
            let q = 0;
            for (let y = syFrom, py = pyFrom; y < syTo; y++, py++) {
              for (let z = szFrom, pz = pzFrom; z < szTo; z++, pz++) {
                const p = pxFrom + pz * P + py * PA;
                if (full) {
                  const s = sxFrom + z * S + y * SA;
                  for (let k = 0; k < width; k++) blocks[p + k] = cells[s + k];
                } else {
                  for (let k = 0; k < width; k++) blocks[p + k] = cells[q++];
                }
              }
            }
            continue;
          } else {
            one = this.decode(job, o);
          }
          if (one !== null) {
            if (one === air) continue;
            for (let y = syFrom, py = pyFrom; y < syTo; y++, py++) {
              for (let z = szFrom, pz = pzFrom; z < szTo; z++, pz++) {
                const p = pxFrom + pz * P + py * PA;
                blocks.fill(one, p, p + width);
              }
            }
          } else {
            const cells = this.scratch;
            for (let y = syFrom, py = pyFrom; y < syTo; y++, py++) {
              for (let z = szFrom, pz = pzFrom; z < szTo; z++, pz++) {
                const s = sxFrom + z * S + y * SA;
                const p = pxFrom + pz * P + py * PA;
                for (let k = 0; k < width; k++) blocks[p + k] = cells[s + k];
              }
            }
          }
        }
      }
    }
  }

  private buildWide(job: SectionJob, glow: number): void {
    const S = this.size;
    const W = 3 * S;
    const WA = W * W;
    const P = this.pad;
    const PA = P * P;
    if (!this.wideScratch) this.wideScratch = new Uint32Array(W * WA);
    const wide = this.wideScratch;
    const { layout, data } = job;
    const volume = S * S * S;
    for (let s = 0; s < 27; s++) {
      const x0 = (s % 3) * S;
      const z0 = (Math.floor(s / 3) % 3) * S;
      const y0 = Math.floor(s / 9) * S;
      const o = s * 3;
      const kind = layout[o];
      let one: number | null = null;
      let cells: Uint32Array = this.scratch;
      if (kind === SOURCE_CELL) {
        one = layout[o + 1];
      } else if (kind === SOURCE_CELLS) {
        if (layout[o + 2] !== volume)
          throw new Error('a job near glowing blocks needs its sources whole');
        cells = new Uint32Array(data.buffer, data.byteOffset + layout[o + 1], volume);
      } else {
        one = this.decode(job, o);
      }
      for (let y = 0, c = 0; y < S; y++) {
        for (let z = 0; z < S; z++) {
          const w = x0 + (z0 + z) * W + (y0 + y) * WA;
          if (one !== null) {
            wide.fill(one, w, w + S);
          } else {
            for (let x = 0; x < S; x++, c++) wide[w + x] = cells[c];
          }
        }
      }
    }
    const blocks = this.blocks;
    const lo = S - 1;
    for (let py = 0; py < P; py++) {
      for (let pz = 0; pz < P; pz++) {
        const w = lo + (pz + lo) * W + (py + lo) * WA;
        blocks.set(wide.subarray(w, w + P), pz * P + py * PA);
      }
    }
    this.input.wide = wide;
    this.input.glowSources = glow;
  }
}
