import { MODEL_VERTEX_FLOATS } from './builder';
import { MODEL_UNIT_FLOATS, type ModelUnit, type ModelUnits } from './compile';
import { MAX_MODEL_CHANNELS } from './spec';

/**
 * Floats per placed instance (`ModelInstances.data`, the shader's `ModelInst`): a 3×4
 * row-major world matrix (12, `Transform.world`'s layout), the channel values at the scene's
 * base time (4), their rates per second (4), the instance colour rgba (4), its second colour
 * (4), a free vec4 for the game's shade function (4), then the scene unit index and 3 spare.
 */
export const MODEL_INSTANCE_FLOATS = 36;

/** Offsets into one instance's floats. */
export const MODEL_INSTANCE = {
  MATRIX: 0,
  VALUES: 12,
  RATES: 16,
  COLOR: 20,
  COLOR2: 24,
  USER: 28,
  UNIT: 32,
} as const;

/** How far the scene's time may run from its base time before every instance is rebased. */
const REBASE_SECONDS = 600;

/**
 * A channel's value as placed: a number (held), or `[value, rate]`: the value now and how much
 * it changes per second, carried on in the shader with nothing written per frame.
 */
export type ChannelInput = number | readonly [value: number, rate: number];

/** What an instance carries besides its matrix. Anything left out is 0 (colours: white). */
export interface ModelInstanceState {
  /** Channel values by the model's channel names, as of the scene's `time`. */
  channels?: Readonly<Record<string, ChannelInput>>;
  /** Linear rgba for parts coloured `'instance'`. */
  color?: ArrayLike<number>;
  /** Linear rgba for parts coloured `'instance2'`. */
  color2?: ArrayLike<number>;
  /** A free vec4 for a custom shade function (`s.user`). */
  user?: ArrayLike<number>;
}

/** One draw: a unit's vertices (scene vertex index and count) for its run of instances in the order. */
export interface ModelDraw {
  first: number;
  count: number;
  firstInstance: number;
  instances: number;
}

/** A placement: a `Transform` (its `world`) or a 3×4 row-major matrix (12 floats). */
export type ModelXform = { readonly world: ArrayLike<number> } | ArrayLike<number>;

/** Counters a budget test holds the scene to. */
export interface ModelInstanceStats {
  /** Instance slots written by `place` or a rebase. */
  placed: number;
  /** Times the draw order was rebuilt. */
  orderBuilds: number;
  /** Rebases (every live instance with a rate written again). */
  rebases: number;
}

export interface ModelInstancesOptions {
  /** Instance slots (0..maxInstances-1). Default 4096. */
  maxInstances?: number;
}

const IDENTITY_3X4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/**
 * The CPU side of a model scene, with no GPU: the packed vertices and unit rows of every model
 * added, the instance slots, which of them changed since the last `flush`, and the draw order
 * grouped by unit. Instances are written only when placed (or rebased once in ten minutes);
 * moving parts move in the shader from their channel rates and the frame's time, so a frame in
 * which nothing is placed writes nothing. `createModelScene` uploads and draws it; a renderer
 * with its own buffers (the retained core) can consume it the same way.
 */
export class ModelInstances {
  readonly maxInstances: number;
  /** `maxInstances × MODEL_INSTANCE_FLOATS`: every slot, as the GPU holds them. */
  readonly data: Float32Array<ArrayBuffer>;
  /** The drawn slots, grouped by unit: draw `k` reads `order[firstInstance .. +instances)`. */
  readonly order: Uint32Array<ArrayBuffer>;
  readonly stats: ModelInstanceStats = { placed: 0, orderBuilds: 0, rebases: 0 };
  /** Packed vertices of every added model (`MODEL_VERTEX_FLOATS` each); `vertexCount` are used. */
  verts: Float32Array<ArrayBuffer> = new Float32Array(1024 * MODEL_VERTEX_FLOATS);
  vertexCount = 0;
  /** Unit rows (`MODEL_UNIT_FLOATS` each), by scene unit index; `unitCount` are used. */
  unitRows: Float32Array<ArrayBuffer> = new Float32Array(64 * MODEL_UNIT_FLOATS);
  unitCount = 0;
  /** Scene time (seconds) and the base time instance values are stored at. */
  private _time = 0;
  private _base = 0;
  /** Per slot: its scene unit index, or -1 when empty. */
  private readonly slotUnit: Int32Array;
  private readonly dirtyFlag: Uint8Array;
  private readonly dirtySlots: Int32Array;
  private dirtyCount = 0;
  private orderDirty = false;
  private live = 0;
  private readonly unitIndex = new Map<ModelUnit, number>();
  private readonly models = new Set<ModelUnits>();
  /** Per scene unit: its first scene vertex, count, and its instances in the order. */
  private unitFirst: Int32Array<ArrayBuffer> = new Int32Array(64);
  private unitVerts: Int32Array<ArrayBuffer> = new Int32Array(64);
  private counts: Int32Array<ArrayBuffer> = new Int32Array(64);
  private nextAt: Int32Array<ArrayBuffer> = new Int32Array(64);
  private readonly drawList: ModelDraw[] = [];
  private drawCount = 0;
  private drawn = 0;
  /** Vertices and unit rows added since the last `flush` (from these indices). */
  private vertsFrom = 0;
  private rowsFrom = 0;

  constructor(opts: ModelInstancesOptions = {}) {
    this.maxInstances = Math.max(1, Math.floor(opts.maxInstances ?? 4096));
    this.data = new Float32Array(this.maxInstances * MODEL_INSTANCE_FLOATS);
    this.order = new Uint32Array(this.maxInstances);
    this.slotUnit = new Int32Array(this.maxInstances).fill(-1);
    this.dirtyFlag = new Uint8Array(this.maxInstances);
    this.dirtySlots = new Int32Array(this.maxInstances);
  }

  /** The scene's time (seconds): channel values given to `place` are as of this time. */
  get time(): number {
    return this._time;
  }

  /** Seconds from the base time to `time`: what the shader carries rates over. */
  get dt(): number {
    return this._time - this._base;
  }

  /** Slots holding an instance. */
  get count(): number {
    return this.live;
  }

  /** The draws of the current order (`draws[0 .. drawCount)`; rebuilt by `flush`). */
  get draws(): readonly ModelDraw[] {
    return this.drawList;
  }

  get drawCalls(): number {
    return this.drawCount;
  }

  /** Instances in the current order. */
  get instances(): number {
    return this.drawn;
  }

  /** Add a compiled model's vertices and unit rows (once; `place` and `placeModel` do it on first use). */
  add(model: ModelUnits): void {
    if (this.models.has(model)) return;
    this.models.add(model);
    const base = this.vertexCount;
    const n = model.verts.length / MODEL_VERTEX_FLOATS;
    this.verts = grow(this.verts, (base + n) * MODEL_VERTEX_FLOATS);
    this.verts.set(model.verts, base * MODEL_VERTEX_FLOATS);
    this.vertexCount = base + n;
    for (const u of model.units) {
      const i = this.unitCount++;
      this.unitRows = grow(this.unitRows, this.unitCount * MODEL_UNIT_FLOATS);
      this.unitRows.set(u.row, i * MODEL_UNIT_FLOATS);
      if (i >= this.unitFirst.length) {
        const cap = this.unitFirst.length * 2;
        this.unitFirst = growInt(this.unitFirst, cap);
        this.unitVerts = growInt(this.unitVerts, cap);
        this.counts = growInt(this.counts, cap);
        this.nextAt = growInt(this.nextAt, cap);
      }
      this.unitFirst[i] = base + u.first;
      this.unitVerts[i] = u.count;
      this.unitIndex.set(u, i);
      this.drawList.push({ first: 0, count: 0, firstInstance: 0, instances: 0 });
    }
  }

  /**
   * Place `unit` in `slot` (0..maxInstances-1), placed by `xform`, with `state`. Writes the
   * slot (uploaded on the next `flush`); a slot that held another unit, or none, also
   * rebuilds the draw order. Call again whenever the instance moves or its state changes.
   */
  place(unit: ModelUnit, slot: number, xform: ModelXform, state?: ModelInstanceState): void {
    this.checkSlot(slot);
    this.add(unit.owner);
    const u = this.unitIndex.get(unit);
    if (u === undefined) throw new Error(`models: unit ${unit.name} is not in its model`);
    if (this.slotUnit[slot]! !== u) {
      if (this.slotUnit[slot]! < 0) this.live++;
      this.slotUnit[slot] = u;
      this.orderDirty = true;
    }
    this.write(slot, u, unit.owner, xform, state);
  }

  /** Place every unit of `model` in slots `slot`, `slot + 1`, ...; returns the slots used. */
  placeModel(
    model: ModelUnits,
    slot: number,
    xform: ModelXform,
    state?: ModelInstanceState,
  ): number {
    const units = model.units;
    for (let i = 0; i < units.length; i++) this.place(units[i]!, slot + i, xform, state);
    return units.length;
  }

  /** Empty `slot` (nothing when it already is). */
  remove(slot: number): void {
    this.checkSlot(slot);
    if (this.slotUnit[slot]! < 0) return;
    this.slotUnit[slot] = -1;
    this.live--;
    this.orderDirty = true;
  }

  /** Empty `count` slots from `slot` (a model's `placeModel` run). */
  removeRange(slot: number, count: number): void {
    for (let i = 0; i < count; i++) this.remove(slot + i);
  }

  /** Empty every slot. */
  clear(): void {
    if (this.live === 0) return;
    this.slotUnit.fill(-1);
    this.live = 0;
    this.orderDirty = true;
  }

  /** The scene unit index in `slot`, or -1. */
  unitAt(slot: number): number {
    return this.slotUnit[slot] ?? -1;
  }

  /**
   * Move the scene's time to `time` (seconds; a frame does it with `frame.time`). Past ten
   * minutes from the base time, every instance with a rate is written again at a new base
   * (f32 precision in the shader); otherwise nothing is written.
   */
  advance(time: number): void {
    this._time = time;
    const dt = time - this._base;
    if (dt >= 0 && dt <= REBASE_SECONDS) return;
    const d = this.data;
    for (let s = 0; s < this.maxInstances; s++) {
      const u = this.slotUnit[s]!;
      if (u < 0) continue;
      const o = s * MODEL_INSTANCE_FLOATS;
      let moved = false;
      for (let c = 0; c < MAX_MODEL_CHANNELS; c++) {
        const rate = d[o + MODEL_INSTANCE.RATES + c]!;
        if (rate === 0) continue;
        let v = d[o + MODEL_INSTANCE.VALUES + c]! + rate * dt;
        const wrap = this.unitRows[u * MODEL_UNIT_FLOATS + 12 + c]!;
        if (wrap > 0) v -= Math.floor(v / wrap) * wrap;
        d[o + MODEL_INSTANCE.VALUES + c] = v;
        moved = true;
      }
      if (moved) this.markDirty(s);
    }
    this._base = time;
    this.stats.rebases++;
  }

  /**
   * Bring the draw order up to date and say what changed since the last flush: `writes` gets
   * the instance float ranges to upload (pairs of first and end float, neighbouring slots
   * merged); the return value says whether the order and draws changed. Added vertices and
   * unit rows are reported by `takeAdded`.
   */
  flush(writes: number[]): boolean {
    writes.length = 0;
    const n = this.dirtyCount;
    if (n > 0) {
      const slots = this.dirtySlots.subarray(0, n);
      slots.sort();
      for (let i = 0; i < n; i++) {
        const s = slots[i]!;
        this.dirtyFlag[s] = 0;
        const from = s * MODEL_INSTANCE_FLOATS;
        const to = from + MODEL_INSTANCE_FLOATS;
        if (writes.length && writes[writes.length - 1] === from) writes[writes.length - 1] = to;
        else writes.push(from, to);
      }
      this.dirtyCount = 0;
    }
    if (!this.orderDirty) return false;
    this.orderDirty = false;
    this.buildOrder();
    return true;
  }

  /**
   * Vertices and unit rows added since the last call: `[vertexFrom, unitFrom]` (both equal to
   * `vertexCount` and `unitCount` when nothing was added).
   */
  takeAdded(out: [number, number]): [number, number] {
    out[0] = this.vertsFrom;
    out[1] = this.rowsFrom;
    this.vertsFrom = this.vertexCount;
    this.rowsFrom = this.unitCount;
    return out;
  }

  /** The instance floats of `slot` (a view into `data`). */
  slotData(slot: number): Float32Array {
    return this.data.subarray(slot * MODEL_INSTANCE_FLOATS, (slot + 1) * MODEL_INSTANCE_FLOATS);
  }

  private checkSlot(slot: number): void {
    if (!(slot >= 0 && slot < this.maxInstances) || slot !== Math.floor(slot)) {
      throw new RangeError(`models: slot ${slot} outside 0..${this.maxInstances - 1}`);
    }
  }

  private markDirty(slot: number): void {
    if (this.dirtyFlag[slot]) return;
    this.dirtyFlag[slot] = 1;
    this.dirtySlots[this.dirtyCount++] = slot;
  }

  private write(
    slot: number,
    u: number,
    model: ModelUnits,
    xform: ModelXform,
    state: ModelInstanceState | undefined,
  ): void {
    const d = this.data;
    const o = slot * MODEL_INSTANCE_FLOATS;
    const m = 'world' in xform ? xform.world : (xform as ArrayLike<number>);
    for (let i = 0; i < 12; i++) d[o + i] = m[i] ?? IDENTITY_3X4[i]!;
    const back = this._time - this._base;
    for (let c = 0; c < MAX_MODEL_CHANNELS; c++) {
      d[o + MODEL_INSTANCE.VALUES + c] = 0;
      d[o + MODEL_INSTANCE.RATES + c] = 0;
    }
    const ch = state?.channels;
    if (ch) {
      const names = model.channels;
      for (let c = 0; c < names.length; c++) {
        const v = ch[names[c]!.name];
        if (v === undefined) continue;
        const value = typeof v === 'number' ? v : v[0];
        const rate = typeof v === 'number' ? 0 : v[1];
        d[o + MODEL_INSTANCE.VALUES + c] = value - rate * back;
        d[o + MODEL_INSTANCE.RATES + c] = rate;
      }
    }
    vec4(d, o + MODEL_INSTANCE.COLOR, state?.color, 1);
    vec4(d, o + MODEL_INSTANCE.COLOR2, state?.color2, 1);
    vec4(d, o + MODEL_INSTANCE.USER, state?.user, 0);
    d[o + MODEL_INSTANCE.UNIT] = u;
    d[o + MODEL_INSTANCE.UNIT + 1] = 0;
    d[o + MODEL_INSTANCE.UNIT + 2] = 0;
    d[o + MODEL_INSTANCE.UNIT + 3] = 0;
    this.stats.placed++;
    this.markDirty(slot);
  }

  private buildOrder(): void {
    this.stats.orderBuilds++;
    const counts = this.counts;
    const units = this.unitCount;
    counts.fill(0, 0, units);
    const slotUnit = this.slotUnit;
    for (let s = 0; s < this.maxInstances; s++) {
      const u = slotUnit[s]!;
      if (u >= 0) counts[u]!++;
    }
    let at = 0;
    let k = 0;
    for (let u = 0; u < units; u++) {
      this.nextAt[u] = at;
      const c = counts[u]!;
      if (c === 0) continue;
      const d = this.drawList[k++]!;
      d.first = this.unitFirst[u]!;
      d.count = this.unitVerts[u]!;
      d.firstInstance = at;
      d.instances = c;
      at += c;
    }
    const order = this.order;
    for (let s = 0; s < this.maxInstances; s++) {
      const u = slotUnit[s]!;
      if (u >= 0) order[this.nextAt[u]!++] = s;
    }
    this.drawCount = k;
    this.drawn = at;
  }
}

function vec4(d: Float32Array, o: number, v: ArrayLike<number> | undefined, fill: number): void {
  d[o] = v ? (v[0] ?? fill) : fill;
  d[o + 1] = v ? (v[1] ?? fill) : fill;
  d[o + 2] = v ? (v[2] ?? fill) : fill;
  d[o + 3] = v ? (v[3] ?? 1) : fill === 0 ? 0 : 1;
}

function grow(a: Float32Array<ArrayBuffer>, need: number): Float32Array<ArrayBuffer> {
  if (a.length >= need) return a;
  let cap = a.length;
  while (cap < need) cap *= 2;
  const b = new Float32Array(cap);
  b.set(a);
  return b;
}

function growInt(a: Int32Array<ArrayBuffer>, cap: number): Int32Array<ArrayBuffer> {
  const b = new Int32Array(cap);
  b.set(a);
  return b;
}

/** Make the CPU side of a model scene; see `ModelInstances`. */
export function createModelInstances(opts: ModelInstancesOptions = {}): ModelInstances {
  return new ModelInstances(opts);
}
