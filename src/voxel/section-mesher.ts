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
  /**
   * Whether the mesh depends on `SectionMeshOptions.leafLod` (the section holds `lodSolid`
   * foliage or cross blocks): a section without stays valid at any level of detail.
   */
  tiered: boolean;
}

/** Options for `SectionMesher.mesh`. */
export interface SectionMeshOptions {
  /** Merge matching faces into larger quads. Default true. */
  greedy?: boolean;
  /**
   * Level of detail for foliage and cross blocks (ws/render-fit), chosen by the game per
   * section by distance. 0 (default): full detail. 1: `lodSolid` foliage meshes into the
   * opaque stream (vertex field `solid`) and hides the opaque faces it covers; cross blocks
   * drop their `parts`. 2: also no `lodSolid` foliage faces across a one-cell gap to foliage or
   * an opaque block, and no cross blocks.
   */
  leafLod?: number;
  /**
   * Insets that differ from the block's own for some cells (a growing plant): pairs of
   * (padded cell index, inset 0..31; higher bits ignored). Applies to `cutout` and `cross`.
   */
  insets?: Int32Array;
  /**
   * Cell fields that read differently in the cells `insets` names (ws/warm-voxel-fit): field
   * name to the value those cells mesh with, e.g. `{ ripe: 0 }` (a growing plant is not ripe
   * yet). Names that are not cell fields are ignored. Default none.
   */
  insetFields?: Readonly<Record<string, number>>;
  /**
   * The highest `leafLod` cross blocks still mesh at (ws/scene-read-fit). Default 1: none at 2.
   * A `farPatch` block's patch is emitted past it anyway.
   */
  crossLod?: number;
  /**
   * Count `lodSolid` foliage and cross blocks in the padding too for `SectionMesh.tiered`
   * (ws/scene-read-fit): solid foliage beside the section hides its faces at `leafLod` 1 and up.
   * Default false: the section's own cells only.
   */
  tieredPadding?: boolean;
  /**
   * Part quads a section emits at most (ws/scene-read-fit); the ones past it are dropped, the
   * blocks' own quads never are. Default no cap.
   */
  partsCap?: number;
  /**
   * Where cross blocks' parts go in the foliage stream (ws/scene-read-fit): `'inline'` (default)
   * after each block's own quads, `'after'` after every cross block's own quads (then
   * `partsCap` drops the last cells' parts first).
   */
  partsOrder?: 'inline' | 'after';
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
  name: string;
  shift: number;
  mask: number;
  fromFacing: boolean;
  /** `CellField.fromNeighbours`: when, y, x, z; null for none. */
  nb: readonly [number, number, number, number] | null;
  /** The value `SectionMeshOptions.insetFields` gives cells `insets` names; −1: none. */
  over: number;
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
  /** A wet cross block's own id + 1 in a cell meshed as its liquid, else 0. */
  private readonly wetId: Uint32Array;
  private readonly opq: Uint8Array;
  private readonly light: Uint8Array;
  private readonly blockLevel: Uint8Array;
  private readonly blockHue: Uint8Array;
  private readonly queue: Int32Array;
  private readonly insets: Uint8Array;
  /** 1 on padded cells `SectionMeshOptions.insets` names, while `insetFields` applies. */
  private readonly overridden: Uint8Array;
  private overriding = false;
  // Per face of a slice.
  private readonly maskKey: Int32Array;
  private readonly maskId: Int32Array;
  private readonly maskE0: Uint32Array;
  private readonly maskE1: Uint32Array;
  private readonly maskAo: Uint8Array;
  private readonly maskLight: Uint32Array;
  private readonly maskBlock: Uint32Array;
  private readonly maskInset: Uint8Array;
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
  private lod = 0;
  private tiered = false;
  private readonly lodSolid: Uint8Array;
  private readonly parts: Uint8Array;
  private readonly partsReplace: Uint8Array;
  private readonly liquidOf: Int32Array | null;
  private readonly farPatch: Uint8Array;
  private readonly axial: Uint8Array;
  private crossLod = 1;
  private tieredPadding = false;
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
  private readonly fSolid: VertexField | undefined;
  private readonly fPart: VertexField | undefined;
  private readonly fTwin: VertexField | undefined;
  private readonly fFar: VertexField | undefined;
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
    this.wetId = new Uint32Array(pv);
    this.opq = new Uint8Array(pv);
    this.light = new Uint8Array(pv);
    this.blockLevel = new Uint8Array(pv);
    this.blockHue = new Uint8Array(pv);
    this.insets = new Uint8Array(pv);
    this.overridden = new Uint8Array(pv);
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
    this.maskInset = new Uint8Array(area);
    const tb = format.blocks;
    this.lodSolid = tb.lodSolid ?? new Uint8Array(tb.count);
    this.parts = tb.parts ?? new Uint8Array(tb.count);
    this.partsReplace = tb.partsReplace ?? new Uint8Array(tb.count);
    this.liquidOf = tb.liquidOf && tb.liquidOf.some((l) => l >= 0) ? tb.liquidOf : null;
    this.farPatch = tb.farPatch ?? new Uint8Array(tb.count);
    this.axial = tb.axial ?? new Uint8Array(tb.count);
    let perCell = 7;
    for (let id = 0; id < tb.count; id++) {
      if (tb.faceClass[id] === CROSS) {
        perCell = Math.max(perCell, tb.quads[id] + this.parts[id] + this.farPatch[id]);
      }
    }
    const maxQuads = S * S * S * 6;
    const words = 4 * SECTION_VERTEX_WORDS;
    this.outOpaque = new Uint32Array(maxQuads * words);
    this.outLiquid = new Uint32Array(maxQuads * words);
    this.outFoliage = new Uint32Array(S * S * S * perCell * words);
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
    this.fSolid = vertexField(v, 'solid');
    this.fPart = vertexField(v, 'part');
    this.fTwin = vertexField(v, 'twin');
    this.fFar = vertexField(v, 'far');
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
        nb: cf.fromNeighbours
          ? [cf.fromNeighbours.when, cf.fromNeighbours.y, cf.fromNeighbours.x, cf.fromNeighbours.z]
          : null,
        over: -1,
        name: cf.name,
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
    this.lod = opts.leafLod ?? 0;
    this.crossLod = opts.crossLod ?? 1;
    this.tieredPadding = opts.tieredPadding === true;
    this.tiered = false;
    const cross = this.classifyAndLight(input);
    const overrides = opts.insets;
    if (overrides) {
      const pv = this.insets.length;
      for (let k = 0; k + 1 < overrides.length; k += 2) {
        const i = overrides[k];
        if (i >= 0 && i < pv) this.insets[i] = overrides[k + 1] & 31;
      }
      const fields = opts.insetFields;
      if (fields) {
        for (const sl of this.cellSlots) {
          const v = fields[sl.name];
          if (v !== undefined) {
            sl.over = (v & sl.mask) >>> 0;
            this.overriding = true;
          }
        }
        if (this.overriding) {
          for (let k = 0; k + 1 < overrides.length; k += 2) {
            const i = overrides[k];
            if (i >= 0 && i < pv) this.overridden[i] = 1;
          }
        }
      }
    }
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
    if (cross)
      faces += this.meshCross(input.blocks, opts.partsCap ?? -1, opts.partsOrder === 'after');
    if (this.overriding && overrides) {
      for (let k = 0; k + 1 < overrides.length; k += 2) {
        const i = overrides[k];
        if (i >= 0 && i < this.overridden.length) this.overridden[i] = 0;
      }
      for (const sl of this.cellSlots) sl.over = -1;
      this.overriding = false;
    }
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
      tiered: this.tiered,
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

  /**
   * The inset (0..31, 1/32 block) per padded cell of the last section meshed (ws/warm-voxel-fit):
   * a cutout's or cross block's own, or its `insets` override; 0 elsewhere. A game that adds
   * quads of its own around the mesh reads the insets the mesh used here.
   */
  get cellInset(): Uint8Array {
    return this.insets;
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
    const { faceClass, lightCost, inset } = this.format.blocks;
    const liquidOf = this.liquidOf;
    const wetId = this.wetId;
    const padTiers = this.tieredPadding;
    const cellInset = this.insets;
    const lodSolid = this.lodSolid;
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
          let id = (blocks[i] >>> idShift) & idMask;
          let c: number = faceClass[id] ?? OPAQUE;
          cellInset[i] = c === CUTOUT || c === CROSS ? (inset[id] ?? 0) : 0;
          let wet = 0;
          if (liquidOf !== null && c === CROSS && liquidOf[id] >= 0) {
            // A cross block in a liquid: the cell meshes as the liquid, its quads come after.
            wet = id + 1;
            id = liquidOf[id];
            c = LIQUID;
          }
          wetId[i] = wet;
          ids[i] = id;
          cls[i] = c;
          if (c === OPAQUE) {
            opq[i] = 1;
            light[i] = 0;
            continue;
          }
          opq[i] = 0;
          if (c === CROSS || wet !== 0 || (c === FOLIAGE && lodSolid[id] === 1)) {
            const inside = px > 0 && px <= S && py > 0 && py <= S && pz > 0 && pz <= S;
            if (inside || padTiers) this.tiered = true;
            if (inside && c !== FOLIAGE) cross = true;
          }
          const h = heights[px + pz * P];
          if (wy > h) {
            light[i] = 15;
          } else {
            const wetTop = wetTops !== undefined && wetTops[px + pz * P] === 1 && c === LIQUID;
            const v = 15 - (wetTop ? liquidSkyFalloff : skyFalloff) * (h - wy);
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
    const cellInset = this.insets;
    const maskInset = this.maskInset;
    const lodSolid = this.lodSolid;
    const lod = this.lod;
    const hasBlock = this.hasBlock;
    const blockLevel = this.blockLevel;
    const slots = this.cellSlots;
    const nSlots = slots.length;
    let faces = 0;
    for (let s = 0; s < S; s++) {
      // Far foliage: a face across a one-cell gap is dropped when the cell past it is foliage
      // or opaque and inside the padded volume.
      const gaps = lod > 1 && (positive ? s <= S - 2 : s >= 1);
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
            // Solid foliage hides what it covers.
            if (lod > 0 && cls[n] === FOLIAGE && lodSolid[ids[n]] === 1) continue;
          } else if (c === LIQUID) {
            if (opq[n] || ids[n] === id) continue;
          } else if (c === FOLIAGE) {
            if (opq[n] || cls[n] === FOLIAGE) continue;
            if (gaps && lodSolid[id] === 1) {
              const past = cls[n + out];
              if (past === FOLIAGE || past === OPAQUE) continue;
            }
          } else if (cellInset[i] === 0 && opq[n]) {
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
              if (sl.nb !== null && val === sl.nb[0] && this.axial[id] === 1)
                val = this.fromNeighbours(i, sl.nb);
              if (sl.over >= 0 && this.overridden[i] === 1) val = sl.over;
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
            maskInset[m] = cellInset[i];
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
    const solid = c === FOLIAGE && this.lod > 0 && this.lodSolid[id] === 1 ? 1 : 0;
    if (c === LIQUID) {
      buf = this.outLiquid;
      o = this.nLiquid++ * 4 * SECTION_VERTEX_WORDS;
    } else if (c === FOLIAGE && solid === 0) {
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
    const inset = c === CUTOUT ? this.maskInset[m] : 0;
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
      if (solid) this.put(this.fSolid, 1);
      buf[o++] = vw[0];
      buf[o++] = vw[1];
      this.stretch(p[0], p[1], p[2]);
    }
  }

  /** A cell field's value from the `axial` blocks next to cell `i` (`CellField.fromNeighbours`). */
  private fromNeighbours(i: number, nb: readonly [number, number, number, number]): number {
    const ax = this.axial;
    const ids = this.ids;
    const PA = this.padArea;
    const P = this.pad;
    if (ax[ids[i + PA]] === 1 || ax[ids[i - PA]] === 1) return nb[1];
    if (ax[ids[i + 1]] === 1 || ax[ids[i - 1]] === 1) return nb[2];
    if (ax[ids[i + P]] === 1 || ax[ids[i - P]] === 1) return nb[3];
    return nb[1];
  }

  /**
   * Cross blocks: `quads` quads standing in the cell, lit by their own cell, never merged, then
   * at full detail their `parts` (inline, or all after when `after`, at most `cap` with a cap ≥
   * 0) and a `farPatch` block's patch at a strand's top.
   */
  private meshCross(blocks: Uint32Array, cap: number, after: boolean): number {
    const S = this.size;
    const P = this.pad;
    const PA = this.padArea;
    const quads = this.format.blocks.quads;
    const { parts, farPatch, wetId, ids } = this;
    const full = this.lod === 0;
    const own = this.lod <= this.crossLod;
    let n = 0;
    // Pass −1: own quads and parts together; with `after`, pass 0 the own quads, pass 1 the parts.
    for (let pass = after ? 0 : -1; pass < (after ? 2 : 0); pass++) {
      let left = cap < 0 ? Number.MAX_SAFE_INTEGER : cap;
      for (let y = 0; y < S; y++) {
        for (let z = 0; z < S; z++) {
          for (let x = 0; x < S; x++) {
            const i = this.base + x + z * P + y * PA;
            const w = wetId[i];
            if (w === 0 && this.cls[i] !== CROSS) continue;
            const id = w === 0 ? ids[i] : w - 1;
            const count = quads[id] ?? 2;
            const patch =
              farPatch[id] === 1 && (w === 0 ? ids[i + PA] !== id : wetId[i + PA] !== w);
            if (!own && !patch) continue;
            let extra = full && own ? parts[id] : 0;
            if (extra > left) extra = left;
            left -= extra;
            const twin = extra > 0 && this.partsReplace[id] === 1;
            if (pass === 1) {
              if (extra > 0)
                n += this.crossQuads(
                  blocks,
                  i,
                  id,
                  x,
                  y,
                  z,
                  count,
                  count,
                  count + extra,
                  false,
                  false,
                );
              continue;
            }
            const to = pass === 0 ? count : count + extra;
            n += this.crossQuads(blocks, i, id, x, y, z, count, own ? 0 : count, to, patch, twin);
            this.stretch(x, y, z);
            this.stretch(x + 1, y + 1, z + 1);
          }
        }
      }
    }
    return n;
  }

  /** Quads `from..to` of a cross block in cell `i` (own below `count`, parts past it), then its far patch when `patch`. */
  private crossQuads(
    blocks: Uint32Array,
    i: number,
    id: number,
    x: number,
    y: number,
    z: number,
    count: number,
    from: number,
    to: number,
    patch: boolean,
    twin: boolean,
  ): number {
    const b = blocks[i];
    const slots = this.cellSlots;
    const out = this.outFoliage;
    const vw = this.vw;
    let e0 = id < this.blockW0.length ? this.blockW0[id] : 0;
    let e1 = id < this.blockW1.length ? this.blockW1[id] : 0;
    const over = this.overriding && this.overridden[i] === 1;
    for (const sl of slots) {
      const val = over && sl.over >= 0 ? sl.over : (b >>> sl.shift) & sl.mask;
      const bits = ((val & sl.toMask) << sl.to) >>> 0;
      if (sl.word === 0) e0 |= bits;
      else e1 |= bits;
    }
    const l = this.light[i] * 4;
    const bl = this.hasBlock ? this.blockLevel[i] * 2 : 0;
    const hue = bl ? this.blockHue[i] : 0;
    const ins = this.insets[i];
    const end = patch ? to + 1 : to;
    for (let k = from; k < end; k++) {
      const far = patch && k === to;
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
        this.put(this.fQuad, far ? count : k);
        this.put(this.fInset, ins);
        this.put(this.fHue, hue);
        if (far) this.put(this.fFar, 1);
        else if (k >= count) this.put(this.fPart, 1);
        else if (twin) this.put(this.fTwin, 1);
        out[o++] = vw[0];
        out[o++] = vw[1];
      }
    }
    return end - from;
  }
}
