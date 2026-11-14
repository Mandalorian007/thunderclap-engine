/**
 * The section mesher: one section of a streamed voxel world into vertices (two u32 words
 * each, laid out by the format's `VertexSchema`), in three streams by how they draw: `opaque`
 * (opaque and cutout blocks), `liquid` (drawn blended) and `foliage` (alpha-cut from both
 * sides: foliage faces and cross quads). Faces against opaque cubes are culled; the rest get
 * per-corner ambient occlusion, smooth sky light and (near emitters) smooth block light with
 * its hue, and merge greedily where all of that matches. It also reports which faces the
 * section's open cells connect (connectivity.ts) and its bounds.
 *
 * Pure and synchronous over reused buffers (one mesher per thread): the same in a Worker, a
 * test, or the page. Generalized from Forge Wilds' mesher with its game's blocks turned into a
 * `BlockTable`; its rules are the engine's (see the README's *Section vertices*).
 *
 * Quads are four vertices, indexed (0, 1, 2) (0, 2, 3), counter-clockwise seen from outside;
 * the diagonal they split on follows the brighter corners so one dark corner does not streak.
 */
import { FACE_CLASS } from './blocks';
import { ConnectivityFlood } from './connectivity';
import type { VoxelFormat } from './format';
import { BlockLightFlood } from './light';
import { type VertexField, vertexField } from './schema';
import { HEIGHT_OPEN, type SectionInput } from './sources';

/** A section's mesh. Buffers are plain (transferable); each vertex is two u32 words. */
export interface SectionMesh {
  opaque: ArrayBuffer;
  liquid: ArrayBuffer;
  foliage: ArrayBuffer;
  opaqueQuads: number;
  liquidQuads: number;
  foliageQuads: number;
  /** Faces before greedy merging (the quad count without it). */
  faces: number;
  /** Section-local box the vertices lie in (`minX minY minZ maxX maxY maxZ`, cells); all 0 when empty. */
  bounds: [number, number, number, number, number, number];
  /** Face pairs the open cells connect (`facePairBit`). */
  connectivity: number;
  openCells: number;
  dark: boolean;
}

/** Options for `SectionMesher.mesh`. */
export interface SectionMeshOptions {
  /** Merge matching faces into larger quads. Default true. */
  greedy?: boolean;
}

/** Words per vertex. */
export const SECTION_VERTEX_WORDS = 2;

const NONE = FACE_CLASS.none;
const OPAQUE = FACE_CLASS.opaque;
const LIQUID = FACE_CLASS.liquid;
const CUTOUT = FACE_CLASS.cutout;
const FOLIAGE = FACE_CLASS.foliage;
const CROSS = FACE_CLASS.cross;

/** The cross quad face code (`face` field). */
export const CROSS_FACE = 6;

const KEY_PRESENT = 1;
const KEY_NOMERGE = 2;

const ORDER_POS = [0, 1, 2, 3] as const;
const ORDER_POS_FLIP = [1, 2, 3, 0] as const;
const ORDER_NEG = [0, 3, 2, 1] as const;
const ORDER_NEG_FLIP = [3, 2, 1, 0] as const;

/** Smooth light at a corner: the face cell and the open cells around the corner, averaged, ×4. */
function smooth(
  lc: number,
  s1: number,
  s2: number,
  c: number,
  l1: number,
  l2: number,
  lcorner: number,
): number {
  let sum = lc;
  let n = 1;
  if (!s1) {
    sum += l1;
    n++;
  }
  if (!s2) {
    sum += l2;
    n++;
  }
  if (!c && !(s1 && s2)) {
    sum += lcorner;
    n++;
  }
  return Math.round((sum * 4) / n);
}

interface CellSlot {
  shift: number;
  mask: number;
  fromFacing: boolean;
  word: 0 | 1;
  to: number;
  toMask: number;
}

/** A section mesher for one format, reusing its buffers across sections. */
export class SectionMesher {
  readonly size: number;
  private readonly pad: number;
  private readonly padArea: number;
  private readonly base: number;
  private readonly stride: readonly [number, number, number];
  private readonly format: VoxelFormat;
  // Per padded cell.
  private readonly cls: Uint8Array;
  private readonly ids: Uint16Array;
  private readonly opq: Uint8Array;
  private readonly light: Uint8Array;
  private readonly blockLevel: Uint8Array;
  private readonly blockHue: Uint8Array;
  private readonly queue: Int32Array;
  // Per face of a slice.
  private readonly maskKey: Int32Array;
  private readonly maskId: Int32Array;
  private readonly maskE0: Uint32Array;
  private readonly maskE1: Uint32Array;
  private readonly maskAo: Uint8Array;
  private readonly maskLight: Uint32Array;
  private readonly maskBlock: Uint32Array;
  // Streams.
  private readonly outOpaque: Uint32Array;
  private readonly outLiquid: Uint32Array;
  private readonly outFoliage: Uint32Array;
  private nOpaque = 0;
  private nLiquid = 0;
  private nFoliage = 0;
  private readonly flood: ConnectivityFlood;
  private blockFlood: BlockLightFlood | null = null;
  private hasBlock = false;
  // Vertex fields.
  private readonly fx: VertexField | undefined;
  private readonly fy: VertexField | undefined;
  private readonly fz: VertexField | undefined;
  private readonly fFace: VertexField | undefined;
  private readonly fAo: VertexField | undefined;
  private readonly fSky: VertexField | undefined;
  private readonly fBlock: VertexField | undefined;
  private readonly fId: VertexField | undefined;
  private readonly fSide: VertexField | undefined;
  private readonly fQuad: VertexField | undefined;
  private readonly fInset: VertexField | undefined;
  private readonly fHue: VertexField | undefined;
  /** Per block id: its constant game fields, already in place in each word. */
  private readonly blockW0: Uint32Array;
  private readonly blockW1: Uint32Array;
  private readonly cellSlots: CellSlot[];
  private readonly vw = new Uint32Array(2);
  private readonly corner = [0, 0, 0];
  private readonly sides = [0, 0, 0];
  private readonly box = [0, 0, 0, 0, 0, 0];
  private best = 0;
  private bestHue = 0;
  private other = 0;
  private otherHue = 0;
  private readonly piece: SectionInput;

  constructor(format: VoxelFormat) {
    this.format = format;
    const S = format.size;
    const P = S + 2;
    this.size = S;
    this.pad = P;
    this.padArea = P * P;
    this.base = 1 + P + P * P;
    this.stride = [1, P * P, P];
    const pv = P * P * P;
    this.cls = new Uint8Array(pv);
    this.ids = new Uint16Array(pv);
    this.opq = new Uint8Array(pv);
    this.light = new Uint8Array(pv);
    this.blockLevel = new Uint8Array(pv);
    this.blockHue = new Uint8Array(pv);
    let q = 1;
    while (q < pv * 16) q <<= 1;
    this.queue = new Int32Array(q);
    const area = S * S;
    this.maskKey = new Int32Array(area);
    this.maskId = new Int32Array(area);
    this.maskE0 = new Uint32Array(area);
    this.maskE1 = new Uint32Array(area);
    this.maskAo = new Uint8Array(area);
    this.maskLight = new Uint32Array(area);
    this.maskBlock = new Uint32Array(area);
    const maxQuads = S * S * S * 6;
    const words = 4 * SECTION_VERTEX_WORDS;
    this.outOpaque = new Uint32Array(maxQuads * words);
    this.outLiquid = new Uint32Array(maxQuads * words);
    this.outFoliage = new Uint32Array(S * S * S * 7 * words);
    this.flood = new ConnectivityFlood(S);
    const v = format.vertex;
    this.fx = vertexField(v, 'x');
    this.fy = vertexField(v, 'y');
    this.fz = vertexField(v, 'z');
    this.fFace = vertexField(v, 'face');
    this.fAo = vertexField(v, 'ao');
    this.fSky = vertexField(v, 'sky');
    this.fBlock = vertexField(v, 'block');
    this.fId = vertexField(v, 'id');
    this.fSide = vertexField(v, 'side');
    this.fQuad = vertexField(v, 'quad');
    this.fInset = vertexField(v, 'inset');
    this.fHue = vertexField(v, 'hue');
    const blocks = format.blocks;
    this.blockW0 = new Uint32Array(blocks.count);
    this.blockW1 = new Uint32Array(blocks.count);
    for (let id = 0; id < blocks.count; id++) {
      const fields = blocks.fields[id];
      if (!fields) continue;
      for (const name of Object.keys(fields)) {
        const f = vertexField(v, name);
        if (!f) throw new Error(`block ${id} field '${name}' names no field of the vertex schema`);
        const bits = ((fields[name] & f.mask) << f.shift) >>> 0;
        if (f.word === 0) this.blockW0[id] |= bits;
        else this.blockW1[id] |= bits;
      }
    }
    this.cellSlots = format.cellFields.map((cf) => {
      const f = vertexField(v, cf.name)!;
      return {
        shift: cf.shift,
        mask: cf.bits >= 32 ? 0xffffffff : (1 << cf.bits) - 1,
        fromFacing: cf.fromFacing === true,
        word: f.word,
        to: f.shift,
        toMask: f.mask,
      };
    });
    const heights = new Int32Array(P * P).fill(HEIGHT_OPEN);
    this.piece = { sx: 0, sy: 0, sz: 0, blocks: new Uint32Array(pv), heights };
  }

  /** Mesh a section from its padded input (`SectionInputBuilder.build`). */
  mesh(input: SectionInput, opts: SectionMeshOptions = {}): SectionMesh {
    const S = this.size;
    this.nOpaque = 0;
    this.nLiquid = 0;
    this.nFoliage = 0;
    const box = this.box;
    box[0] = box[1] = box[2] = S;
    box[3] = box[4] = box[5] = 0;
    const cross = this.classifyAndLight(input);
    this.hasBlock = false;
    if (this.blockFlood) this.blockFlood.visited = 0;
    if (input.wide && input.glowSources && this.format.blocks.emissive) {
      this.blockFlood ??= new BlockLightFlood(this.format);
      this.hasBlock = this.blockFlood.fill(
        input.wide,
        input.glowSources,
        this.blockLevel,
        this.blockHue,
      );
    }
    const conn = this.flood.compute(this.opq, this.light, this.hasBlock ? this.blockLevel : null);
    const greedy = opts.greedy !== false;
    let faces = 0;
    for (let face = 0; face < 6; face++) faces += this.meshDirection(input.blocks, face, greedy);
    if (cross) faces += this.meshCross(input.blocks);
    const words = 4 * SECTION_VERTEX_WORDS;
    const empty = this.nOpaque + this.nLiquid + this.nFoliage === 0;
    return {
      opaque: this.outOpaque.slice(0, this.nOpaque * words).buffer,
      liquid: this.outLiquid.slice(0, this.nLiquid * words).buffer,
      foliage: this.outFoliage.slice(0, this.nFoliage * words).buffer,
      opaqueQuads: this.nOpaque,
      liquidQuads: this.nLiquid,
      foliageQuads: this.nFoliage,
      faces,
      bounds: empty ? [0, 0, 0, 0, 0, 0] : [box[0], box[1], box[2], box[3], box[4], box[5]],
      connectivity: conn.bits,
      openCells: conn.open,
      dark: conn.dark,
    };
  }

  /**
   * Mesh a small free-standing grid of cells (a held block, a falling piece): `cells` is
   * `sx × sy × sz` (each ≤ the section size, x fastest then z then y), surrounded by `air`
   * and lit fully by the sky.
   */
  meshPiece(
    cells: Uint32Array,
    sx: number,
    sy: number,
    sz: number,
    opts: SectionMeshOptions & { air?: number } = {},
  ): SectionMesh {
    const S = this.size;
    if (sx > S || sy > S || sz > S || sx < 1 || sy < 1 || sz < 1) {
      throw new RangeError(`a piece is 1..${S} cells a side, got ${sx}×${sy}×${sz}`);
    }
    if (cells.length < sx * sy * sz) throw new RangeError('meshPiece: too few cells');
    const P = this.pad;
    const PA = this.padArea;
    const blocks = this.piece.blocks;
    blocks.fill(opts.air ?? 0);
    for (let y = 0, c = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) blocks[1 + x + (1 + z) * P + (1 + y) * PA] = cells[c++];
      }
    }
    return this.mesh(this.piece, opts);
  }

  /** Sky light per padded cell (0..15) of the last section meshed. For tests and tools. */
  get skyLevels(): Uint8Array {
    return this.light;
  }

  /** Block light per padded cell (0..15) of the last section meshed (all 0 without any). */
  get blockLevels(): Uint8Array {
    if (!this.hasBlock) this.blockLevel.fill(0);
    return this.blockLevel;
  }

  /** Block light hue per padded cell of the last section meshed. */
  get blockHues(): Uint8Array {
    if (!this.hasBlock) this.blockHue.fill(0);
    return this.blockHue;
  }

  /** Cells the last block light flood spread from (0 without one). */
  get blockLightVisited(): number {
    return this.blockFlood?.visited ?? 0;
  }

  /**
   * Classes and sky light per padded cell. Cells above their column's height get 15; below it
   * they start from a falloff (`skyFalloff` a block, `liquidSkyFalloff` in liquid under a
   * liquid-topped column), then light spreads by each block's `lightCost`. Returns whether the
   * section holds a cross block.
   */
  private classifyAndLight(input: SectionInput): boolean {
    const { blocks, heights, wetTops } = input;
    const { idShift, idMask, skyFalloff, liquidSkyFalloff } = this.format;
    const { faceClass, lightCost } = this.format.blocks;
    const S = this.size;
    const P = this.pad;
    const PA = this.padArea;
    const cls = this.cls;
    const ids = this.ids;
    const opq = this.opq;
    const light = this.light;
    const baseY = input.sy * S - 1;
    let dim = 0;
    let cross = false;
    for (let py = 0, i = 0; py < P; py++) {
      const wy = baseY + py;
      for (let pz = 0; pz < P; pz++) {
        for (let px = 0; px < P; px++, i++) {
          const id = (blocks[i] >>> idShift) & idMask;
          const c = faceClass[id] ?? OPAQUE;
          ids[i] = id;
          cls[i] = c;
          if (c === OPAQUE) {
            opq[i] = 1;
            light[i] = 0;
            continue;
          }
          opq[i] = 0;
          if (c === CROSS && px > 0 && px <= S && py > 0 && py <= S && pz > 0 && pz <= S)
            cross = true;
          const h = heights[px + pz * P];
          if (wy > h) {
            light[i] = 15;
          } else {
            const wet = wetTops !== undefined && wetTops[px + pz * P] === 1 && c === LIQUID;
            const v = 15 - (wet ? liquidSkyFalloff : skyFalloff) * (h - wy);
            light[i] = v > 0 ? v : 0;
            dim++;
          }
        }
      }
    }
    if (dim === 0) return cross;
    const q = this.queue;
    const mask = q.length - 1;
    const pv = P * PA;
    let head = 0;
    let tail = 0;
    for (let i = 0; i < pv; i++) if (light[i] > 1) q[tail++ & mask] = i;
    while (head !== tail) {
      const i = q[head++ & mask];
      const l = light[i];
      if (l <= 1) continue;
      const px = i % P;
      const pz = Math.floor(i / P) % P;
      const py = Math.floor(i / PA);
      for (let n = 0; n < 6; n++) {
        let j: number;
        if (n === 0) {
          if (px === 0) continue;
          j = i - 1;
        } else if (n === 1) {
          if (px === P - 1) continue;
          j = i + 1;
        } else if (n === 2) {
          if (pz === 0) continue;
          j = i - P;
        } else if (n === 3) {
          if (pz === P - 1) continue;
          j = i + P;
        } else if (n === 4) {
          if (py === 0) continue;
          j = i - PA;
        } else {
          if (py === P - 1) continue;
          j = i + PA;
        }
        const cost = lightCost[ids[j]] ?? 0;
        if (cost === 0) continue;
        const nl = l - cost;
        if (nl > light[j]) {
          light[j] = nl;
          q[tail++ & mask] = j;
        }
      }
    }
    return cross;
  }

  /** Faces of one direction, slice by slice. Returns the faces before merging. */
  private meshDirection(blocks: Uint32Array, face: number, greedy: boolean): number {
    const S = this.size;
    const axis = face >> 1;
    const positive = (face & 1) === 1;
    const uAxis = (axis + 1) % 3;
    const vAxis = (axis + 2) % 3;
    const sa = this.stride[axis];
    const su = this.stride[uAxis];
    const sv = this.stride[vAxis];
    const out = positive ? sa : -sa;
    const { cls, ids, opq, light } = this;
    const { maskKey, maskId, maskE0, maskE1, maskAo, maskLight, maskBlock } = this;
    const inset = this.format.blocks.inset;
    const hasBlock = this.hasBlock;
    const blockLevel = this.blockLevel;
    const slots = this.cellSlots;
    const nSlots = slots.length;
    let faces = 0;
    for (let s = 0; s < S; s++) {
      let any = false;
      for (let v = 0; v < S; v++) {
        for (let u = 0; u < S; u++) {
          const m = u + v * S;
          maskKey[m] = 0;
          const i = this.base + s * sa + u * su + v * sv;
          const c = cls[i];
          if (c === NONE || c === CROSS) continue;
          const n = i + out;
          const id = ids[i];
          if (c === OPAQUE) {
            if (opq[n]) continue;
          } else if (c === LIQUID) {
            if (opq[n] || ids[n] === id) continue;
          } else if (c === FOLIAGE) {
            if (opq[n] || cls[n] === FOLIAGE) continue;
          } else if ((inset[id] ?? 0) === 0 && opq[n]) {
            continue;
          }
          faces++;
          any = true;
          let e0 = 0;
          let e1 = 0;
          if (nSlots > 0) {
            const b = blocks[i];
            const facingNone = cls[n] === NONE;
            for (let k = 0; k < nSlots; k++) {
              const sl = slots[k];
              let val = (b >>> sl.shift) & sl.mask;
              if (sl.fromFacing && facingNone) val |= (blocks[n] >>> sl.shift) & sl.mask;
              const bits = ((val & sl.toMask) << sl.to) >>> 0;
              if (sl.word === 0) e0 |= bits;
              else e1 |= bits;
            }
          }
          maskId[m] = id;
          maskE0[m] = e0 >>> 0;
          maskE1[m] = e1 >>> 0;
          if (c === CUTOUT) {
            const l = light[i] * 4;
            maskKey[m] = KEY_PRESENT | KEY_NOMERGE;
            maskAo[m] = 0xff;
            maskLight[m] = l | (l << 6) | (l << 12) | (l << 18);
            if (hasBlock) {
              const bl = blockLevel[i];
              const cb = bl ? (bl * 2) | (this.blockHue[i] << 5) : 0;
              maskBlock[m] = (cb | (cb << 8) | (cb << 16) | (cb << 24)) >>> 0;
            }
            continue;
          }
          const um = opq[n - su];
          const up = opq[n + su];
          const vm = opq[n - sv];
          const vp = opq[n + sv];
          const cmm = opq[n - su - sv];
          const cpm = opq[n + su - sv];
          const cpp = opq[n + su + sv];
          const cmp = opq[n - su + sv];
          let a0 = 3;
          let a1 = 3;
          let a2 = 3;
          let a3 = 3;
          if (c === OPAQUE || c === FOLIAGE) {
            a0 = um && vm ? 0 : 3 - um - vm - cmm;
            a1 = up && vm ? 0 : 3 - up - vm - cpm;
            a2 = up && vp ? 0 : 3 - up - vp - cpp;
            a3 = um && vp ? 0 : 3 - um - vp - cmp;
          }
          const lc = light[n];
          const l0 = smooth(lc, um, vm, cmm, light[n - su], light[n - sv], light[n - su - sv]);
          const l1 = smooth(lc, up, vm, cpm, light[n + su], light[n - sv], light[n + su - sv]);
          const l2 = smooth(lc, up, vp, cpp, light[n + su], light[n + sv], light[n + su + sv]);
          const l3 = smooth(lc, um, vp, cmp, light[n - su], light[n + sv], light[n - su + sv]);
          let uniform = a0 === a1 && a1 === a2 && a2 === a3 && l0 === l1 && l1 === l2 && l2 === l3;
          if (hasBlock) {
            const b0 = this.cornerBlock(n, -su, -sv, um, vm, cmm);
            const b1 = this.cornerBlock(n, su, -sv, up, vm, cpm);
            const b2 = this.cornerBlock(n, su, sv, up, vp, cpp);
            const b3 = this.cornerBlock(n, -su, sv, um, vp, cmp);
            const all = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
            maskBlock[m] = all;
            if (all !== 0) uniform = false;
          }
          maskKey[m] = uniform ? KEY_PRESENT | (a0 << 2) | (l0 << 4) : KEY_PRESENT | KEY_NOMERGE;
          maskAo[m] = a0 | (a1 << 2) | (a2 << 4) | (a3 << 6);
          maskLight[m] = l0 | (l1 << 6) | (l2 << 12) | (l3 << 18);
        }
      }
      if (!any) continue;
      for (let v = 0; v < S; v++) {
        for (let u = 0; u < S; u++) {
          const m = u + v * S;
          const k = maskKey[m];
          if (k === 0) continue;
          let w = 1;
          let h = 1;
          if (greedy && (k & KEY_NOMERGE) === 0) {
            const id = maskId[m];
            const e0 = maskE0[m];
            const e1 = maskE1[m];
            while (u + w < S && this.same(m + w, k, id, e0, e1)) w++;
            grow: while (v + h < S) {
              const row = m + h * S;
              for (let t = 0; t < w; t++) if (!this.same(row + t, k, id, e0, e1)) break grow;
              h++;
            }
            for (let dv = 0; dv < h; dv++) maskKey.fill(0, m + dv * S, m + dv * S + w);
          } else {
            maskKey[m] = 0;
          }
          this.emitQuad(face, axis, uAxis, vAxis, positive, s, u, v, w, h, m);
        }
      }
    }
    return faces;
  }

  private same(j: number, k: number, id: number, e0: number, e1: number): boolean {
    return (
      this.maskKey[j] === k &&
      this.maskId[j] === id &&
      this.maskE0[j] === e0 &&
      this.maskE1[j] === e1
    );
  }

  /** Block light at a face's corner, as `smooth` takes sky light: half levels | hue << 5. */
  private cornerBlock(
    n: number,
    d1: number,
    d2: number,
    s1: number,
    s2: number,
    c: number,
  ): number {
    let sum = 0;
    let cnt = 1;
    this.best = 0;
    this.bestHue = 0;
    this.other = 0;
    this.otherHue = 0;
    sum += this.takeCell(n);
    if (!s1) {
      sum += this.takeCell(n + d1);
      cnt++;
    }
    if (!s2) {
      sum += this.takeCell(n + d2);
      cnt++;
    }
    if (!c && !(s1 && s2)) {
      sum += this.takeCell(n + d1 + d2);
      cnt++;
    }
    const level = Math.round((sum * 2) / cnt);
    if (!level) return 0;
    let hue = this.bestHue;
    if (this.other > 0 && this.other + 1 >= this.best) {
      const mix = this.format.blocks.hueMix[hue * 8 + this.otherHue];
      if (mix !== 255) hue = mix;
    }
    return level | (hue << 5);
  }

  /** Counts cell `i` in a corner's block light; ties go to the lower hue (order-free). */
  private takeCell(i: number): number {
    const v = this.blockLevel[i];
    if (v === 0) return 0;
    const h = this.blockHue[i];
    if (h === this.bestHue && this.best > 0) {
      if (v > this.best) this.best = v;
    } else if (v > this.best || (v === this.best && h < this.bestHue)) {
      if (
        this.best > 0 &&
        (this.best > this.other || (this.best === this.other && this.bestHue < this.otherHue))
      ) {
        this.other = this.best;
        this.otherHue = this.bestHue;
      }
      this.best = v;
      this.bestHue = h;
      if (this.otherHue === h) {
        this.other = 0;
        this.otherHue = 0;
      }
    } else if (v > this.other || (v === this.other && h < this.otherHue)) {
      this.other = v;
      this.otherHue = h;
    }
    return v;
  }

  private put(f: VertexField | undefined, value: number): void {
    if (!f) return;
    this.vw[f.word] |= (value & f.mask) << f.shift;
  }

  private stretch(x: number, y: number, z: number): void {
    const b = this.box;
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (z < b[2]) b[2] = z;
    if (x > b[3]) b[3] = x;
    if (y > b[4]) b[4] = y;
    if (z > b[5]) b[5] = z;
  }

  private emitQuad(
    face: number,
    axis: number,
    uAxis: number,
    vAxis: number,
    positive: boolean,
    s: number,
    u: number,
    v: number,
    w: number,
    h: number,
    m: number,
  ): void {
    const id = this.maskId[m];
    const c = this.format.blocks.faceClass[id] ?? OPAQUE;
    let buf: Uint32Array;
    let o: number;
    if (c === LIQUID) {
      buf = this.outLiquid;
      o = this.nLiquid++ * 4 * SECTION_VERTEX_WORDS;
    } else if (c === FOLIAGE) {
      buf = this.outFoliage;
      o = this.nFoliage++ * 4 * SECTION_VERTEX_WORDS;
    } else {
      buf = this.outOpaque;
      o = this.nOpaque++ * 4 * SECTION_VERTEX_WORDS;
    }
    const ao = this.maskAo[m];
    const lp = this.maskLight[m];
    const bp = this.hasBlock ? this.maskBlock[m] : 0;
    const a0 = ao & 3;
    const a1 = (ao >> 2) & 3;
    const a2 = (ao >> 4) & 3;
    const a3 = (ao >> 6) & 3;
    const l0 = lp & 63;
    const l1 = (lp >> 6) & 63;
    const l2 = (lp >> 12) & 63;
    const l3 = (lp >> 18) & 63;
    const c0 = bp & 255;
    const c1 = (bp >>> 8) & 255;
    const c2 = (bp >>> 16) & 255;
    const c3 = bp >>> 24;
    const flip =
      a0 + a2 < a1 + a3 ||
      (a0 + a2 === a1 + a3 &&
        (l0 + l2 < l1 + l3 ||
          (l0 + l2 === l1 + l3 && (c0 & 31) + (c2 & 31) < (c1 & 31) + (c3 & 31))));
    const order = positive
      ? flip
        ? ORDER_POS_FLIP
        : ORDER_POS
      : flip
        ? ORDER_NEG_FLIP
        : ORDER_NEG;
    const plane = s + (positive ? 1 : 0);
    const p = this.corner;
    const sides = this.sides;
    const inset = c === CUTOUT ? (this.format.blocks.inset[id] ?? 0) : 0;
    const k0 = (id < this.blockW0.length ? this.blockW0[id] : 0) | this.maskE0[m];
    const k1 = (id < this.blockW1.length ? this.blockW1[id] : 0) | this.maskE1[m];
    const vw = this.vw;
    for (let e = 0; e < 4; e++) {
      const corner = order[e];
      const du = corner === 1 || corner === 2 ? 1 : 0;
      const dv = corner === 2 || corner === 3 ? 1 : 0;
      p[axis] = plane;
      p[uAxis] = u + du * w;
      p[vAxis] = v + dv * h;
      sides[axis] = positive ? 1 : 0;
      sides[uAxis] = du;
      sides[vAxis] = dv;
      const a = corner === 0 ? a0 : corner === 1 ? a1 : corner === 2 ? a2 : a3;
      const l = corner === 0 ? l0 : corner === 1 ? l1 : corner === 2 ? l2 : l3;
      const b = corner === 0 ? c0 : corner === 1 ? c1 : corner === 2 ? c2 : c3;
      vw[0] = k0;
      vw[1] = k1;
      this.put(this.fx, p[0]);
      this.put(this.fy, p[1]);
      this.put(this.fz, p[2]);
      this.put(this.fFace, face);
      this.put(this.fAo, a);
      this.put(this.fSky, l);
      this.put(this.fBlock, b & 31);
      this.put(this.fId, id);
      this.put(this.fSide, sides[0] | (sides[1] << 1) | (sides[2] << 2));
      this.put(this.fInset, inset);
      this.put(this.fHue, b >> 5);
      buf[o++] = vw[0];
      buf[o++] = vw[1];
      this.stretch(p[0], p[1], p[2]);
    }
  }

  /** Cross blocks: `quads` quads standing in the cell, lit by their own cell, never merged. */
  private meshCross(blocks: Uint32Array): number {
    const S = this.size;
    const P = this.pad;
    const PA = this.padArea;
    const { quads, inset } = this.format.blocks;
    const slots = this.cellSlots;
    const out = this.outFoliage;
    const vw = this.vw;
    let n = 0;
    for (let y = 0; y < S; y++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const i = this.base + x + z * P + y * PA;
          if (this.cls[i] !== CROSS) continue;
          const id = this.ids[i];
          const b = blocks[i];
          let e0 = id < this.blockW0.length ? this.blockW0[id] : 0;
          let e1 = id < this.blockW1.length ? this.blockW1[id] : 0;
          for (const sl of slots) {
            const bits = (((b >>> sl.shift) & sl.mask & sl.toMask) << sl.to) >>> 0;
            if (sl.word === 0) e0 |= bits;
            else e1 |= bits;
          }
          const l = this.light[i] * 4;
          const bl = this.hasBlock ? this.blockLevel[i] * 2 : 0;
          const hue = bl ? this.blockHue[i] : 0;
          const count = quads[id] ?? 2;
          for (let k = 0; k < count; k++) {
            let o = this.nFoliage++ * 4 * SECTION_VERTEX_WORDS;
            for (let c = 0; c < 4; c++) {
              const u = c === 1 || c === 2 ? 1 : 0;
              const v = c >= 2 ? 1 : 0;
              vw[0] = e0;
              vw[1] = e1;
              this.put(this.fx, x);
              this.put(this.fy, y);
              this.put(this.fz, z);
              this.put(this.fFace, CROSS_FACE);
              this.put(this.fAo, 3);
              this.put(this.fSky, l);
              this.put(this.fBlock, bl);
              this.put(this.fId, id);
              this.put(this.fSide, u | (v << 1));
              this.put(this.fQuad, k);
              this.put(this.fInset, inset[id] ?? 0);
              this.put(this.fHue, hue);
              out[o++] = vw[0];
              out[o++] = vw[1];
            }
            n++;
          }
          this.stretch(x, y, z);
          this.stretch(x + 1, y + 1, z + 1);
        }
      }
    }
    return n;
  }
}
