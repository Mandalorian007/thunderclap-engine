/**
 * Remote things drawn a little in the past. Each update the server sends is a snapshot stamped with
 * the step it is as of. `SnapshotBuffer` keeps the last few snapshots of each thing and draws it
 * where it was a short delay ago, between the two snapshots around that moment, so uneven arrival
 * (a late frame, two at once) doesn't change how it moves, only how far behind it is drawn.
 *
 * - Each thing's steps map to local time by its quickest arrival: `base = min(arrival - step ×
 *   stepMs)`, rising slowly so it follows a path that got slower.
 * - The delay is one step plus the jitter seen (a decaying peak of lateness past `base`) plus a
 *   margin, kept within `minDelayMs..maxDelayMs`. It changes smoothly: the drawn clock runs between
 *   0.9 and 1.1× real time while it catches up, and jumps only when more than 250 ms off.
 * - Past the newest snapshot it goes on at that snapshot's velocity for at most one step, then
 *   holds. Where a new snapshot moves what is drawn now, the difference fades out instead of
 *   jumping (longer for a bigger one); a difference of `blendMax` units or more is a jump.
 * - A snap (the server moved it), a step that goes back, or a move of more than `jump` units starts
 *   it over at the new place.
 * - A thing that stood still then moves: the server sends nothing while it stands, so its first
 *   move would glide over the whole wait. The last still snapshot is held until it set off.
 *
 * Positions are in the game's units, velocities in units a step, in 2 or 3 dimensions. Nothing here
 * allocates per drawn frame: each thing's snapshots are a preallocated ring, and `frame`, `at`,
 * `velocity` and `latest` write into what they are given.
 */

/** Tuning for a `SnapshotBuffer`. Every field has a default. */
export interface SnapshotOptions {
  /** Components per position: 2 or 3 (default 3). */
  readonly dims?: 2 | 3;
  /** Milliseconds per step (default 50: 20 steps a second). */
  readonly stepMs?: number;
  /** Snapshots kept per thing (default 16). */
  readonly capacity?: number;
  /** Smallest and largest delay, ms (default 100 and 300). */
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  /** A difference bigger than this (units) isn't faded but jumps (default 2). */
  readonly blendMax?: number;
  /** How long a difference fades per unit of it, ms (default 400; at least 80, at most 250). */
  readonly blendMsPerUnit?: number;
  /** A move bigger than this between snapshots (units, any axis) starts over (default 16). */
  readonly jump?: number;
}

const MARGIN_MS = 10;
const JITTER_DECAY = 0.02;
const BASE_RISE = 0.002;
const SLEW = 0.1;
const SLEW_SNAP_MS = 250;
const REANCHOR_MS = 250;
const EXTRAPOLATE_STEPS = 1;
const BLEND_MS = 80;
const BLEND_MAX_MS = 250;

class Track {
  id: number;
  readonly ring: Float64Array;
  head = 0;
  count = 0;
  base = 0;
  baseAt = 0;
  shift = 0;
  readonly err: Float64Array;
  errAt = Number.NEGATIVE_INFINITY;
  errMs = BLEND_MS;
  index = 0;

  constructor(id: number, capacity: number, stride: number, dims: number) {
    this.id = id;
    this.ring = new Float64Array(capacity * stride);
    this.err = new Float64Array(dims);
  }
}

/**
 * Draws remote things a little in the past from the snapshots that arrive. `push` each snapshot as
 * it arrives, call `frame(now)` once per drawn frame, then `at(id, out)` for each thing.
 */
export class SnapshotBuffer {
  /** Components per position. */
  readonly dims: number;
  /** Milliseconds per step. */
  readonly stepMs: number;
  readonly #cap: number;
  readonly #stride: number;
  readonly #min: number;
  readonly #max: number;
  readonly #blendMax: number;
  readonly #blendPerUnit: number;
  readonly #jump: number;
  readonly #tracks = new Map<number, Track>();
  readonly #list: Track[] = [];
  readonly #free: Track[] = [];
  #jitter = 0;
  #jitterAt = 0;
  #delay: number;
  #now = 0;
  #last = Number.NaN;
  readonly #s: Float64Array;
  readonly #before: Float64Array;

  constructor(options: SnapshotOptions = {}) {
    this.dims = options.dims ?? 3;
    this.stepMs = options.stepMs ?? 50;
    this.#cap = options.capacity ?? 16;
    this.#stride = 1 + 2 * this.dims;
    this.#min = options.minDelayMs ?? 100;
    this.#max = options.maxDelayMs ?? 300;
    this.#blendMax = options.blendMax ?? 2;
    this.#blendPerUnit = options.blendMsPerUnit ?? 400;
    this.#jump = options.jump ?? 16;
    this.#delay = this.#min;
    this.#s = new Float64Array(2 * this.dims);
    this.#before = new Float64Array(this.dims);
  }

  /** The delay things are drawn behind, ms. */
  get delay(): number {
    return this.#delay;
  }

  /** The jitter seen lately (a decaying peak of lateness), ms. */
  get jitter(): number {
    return this.#jitter;
  }

  /** How many things it holds. */
  get size(): number {
    return this.#list.length;
  }

  has(id: number): boolean {
    return this.#tracks.has(id);
  }

  /**
   * A snapshot of `id` arrived at `now` (ms): at step `step` it was at `pos`, moving `vel` units a
   * step (both `dims` long). `snap`: the server moved it, draw it there.
   */
  push(
    id: number,
    step: number,
    pos: ArrayLike<number>,
    vel: ArrayLike<number>,
    now: number,
    snap = false,
  ): void {
    const D = this.dims;
    let t = this.#tracks.get(id);
    const offset = now - step * this.stepMs;
    if (!t) {
      t = this.#free.pop() ?? new Track(id, this.#cap, this.#stride, D);
      t.id = id;
      t.count = 0;
      t.index = this.#list.length;
      this.#list.push(t);
      this.#tracks.set(id, t);
    }
    if (t.count === 0) {
      this.#restart(t, offset, now);
      this.#append(t, step, pos, vel);
      return;
    }
    const r = t.ring;
    const lo = this.#o(t, t.count - 1);
    const lastStep = r[lo]!;
    let far = false;
    for (let c = 0; c < D; c++) if (Math.abs(pos[c]! - r[lo + 1 + c]!) > this.#jump) far = true;
    if (snap || step < lastStep || far) {
      t.count = 0;
      this.#restart(t, offset, now);
      this.#append(t, step, pos, vel);
      return;
    }
    t.base = Math.min(t.base + (now - t.baseAt) * BASE_RISE, offset);
    t.baseAt = now;
    const late = offset - t.base;
    if (late > REANCHOR_MS) {
      // Its clock stalled: keep where it was, held to the step before.
      this.#restart(t, offset, now);
      const o = this.#o(t, 0);
      for (let k = 0; k < this.#stride; k++) r[o + k] = r[lo + k]!;
      r[o] = step - 1;
      for (let c = 0; c < D; c++) r[o + 1 + D + c] = 0;
      t.count = 1;
      this.#append(t, step, pos, vel);
      return;
    }
    this.#late(late, now);
    const s = this.#s;
    const before = this.#before;
    const had = this.#sample(t, now, s);
    for (let c = 0; c < D; c++) before[c] = s[c]!;
    const gap = step - lastStep;
    if (gap === 0) t.count--;
    else if (gap > 1) {
      let still = true;
      for (let c = 0; c < D; c++) if (r[lo + 1 + D + c] !== 0) still = false;
      if (still) {
        // It stood still until it set off: as many steps before this one as its move takes.
        let speed2 = 0;
        let dist2 = 0;
        for (let c = 0; c < D; c++) {
          speed2 += vel[c]! * vel[c]!;
          const d = pos[c]! - r[lo + 1 + c]!;
          dist2 += d * d;
        }
        const back = speed2 > 0 ? Math.max(1, Math.round(Math.sqrt(dist2 / speed2))) : 1;
        if (back < gap) this.#hold(t, lo, step - back);
      }
    }
    this.#append(t, step, pos, vel);
    if (had && this.#sample(t, now, s)) {
      const fade = this.#fade(t, now);
      let e2 = 0;
      for (let c = 0; c < D; c++) {
        const e = before[c]! - s[c]! + t.err[c]! * fade;
        before[c] = e;
        e2 += e * e;
      }
      const e = Math.sqrt(e2);
      if (e > 1e-9 && e < this.#blendMax) {
        for (let c = 0; c < D; c++) t.err[c] = before[c]!;
        t.errAt = now;
        const ms = e * this.#blendPerUnit;
        t.errMs = ms < BLEND_MS ? BLEND_MS : ms > BLEND_MAX_MS ? BLEND_MAX_MS : ms;
      } else if (fade > 0) {
        t.err.fill(0);
        t.errAt = Number.NEGATIVE_INFINITY;
      }
    }
  }

  /** Forgets `id`. */
  remove(id: number): void {
    const t = this.#tracks.get(id);
    if (!t) return;
    this.#tracks.delete(id);
    const last = this.#list.pop()!;
    if (last !== t) {
      this.#list[t.index] = last;
      last.index = t.index;
    }
    this.#free.push(t);
  }

  /** Forgets everything. */
  clear(): void {
    for (const t of this.#list) this.#free.push(t);
    this.#list.length = 0;
    this.#tracks.clear();
  }

  /** Starts a drawn frame at `now` (ms): eases the delay and each thing's clock. */
  frame(now: number): void {
    const dt = Number.isNaN(this.#last) ? 0 : Math.max(0, Math.min(250, now - this.#last));
    this.#last = now;
    this.#now = now;
    this.#jitter = Math.max(0, this.#jitter - (now - this.#jitterAt) * JITTER_DECAY);
    this.#jitterAt = now;
    this.#delay = this.#target();
    const most = dt * SLEW;
    for (let i = 0; i < this.#list.length; i++) {
      const t = this.#list[i]!;
      const want = t.base + this.#delay;
      const d = want - t.shift;
      if (Math.abs(d) > SLEW_SNAP_MS) t.shift = want;
      else t.shift += d > most ? most : d < -most ? -most : d;
    }
  }

  /** Where `id` is drawn in this frame into `out[0..dims)`; false (and `out` untouched) if not held. */
  at(id: number, out: { [i: number]: number }): boolean {
    const t = this.#tracks.get(id);
    if (!t) return false;
    const s = this.#s;
    if (!this.#sample(t, this.#now, s)) return false;
    const fade = this.#fade(t, this.#now);
    for (let c = 0; c < this.dims; c++) out[c] = s[c]! + t.err[c]! * fade;
    return true;
  }

  /**
   * How fast `id` is drawn moving in this frame, units a second, into `out[0..dims)` (its glide
   * between snapshots; its velocity while going on past the newest; 0 held). False if not held.
   */
  velocity(id: number, out: { [i: number]: number }): boolean {
    const t = this.#tracks.get(id);
    if (!t) return false;
    const s = this.#s;
    if (!this.#sample(t, this.#now, s)) return false;
    const perSecond = 1000 / this.stepMs;
    for (let c = 0; c < this.dims; c++) out[c] = s[this.dims + c]! * perSecond;
    return true;
  }

  /** The newest snapshot of `id` into `out[0..dims)`; false if not held. */
  latest(id: number, out: { [i: number]: number }): boolean {
    const t = this.#tracks.get(id);
    if (!t || t.count === 0) return false;
    const o = this.#o(t, t.count - 1);
    for (let c = 0; c < this.dims; c++) out[c] = t.ring[o + 1 + c]!;
    return true;
  }

  #o(t: Track, i: number): number {
    return ((t.head + i) % this.#cap) * this.#stride;
  }

  #target(): number {
    const d = this.stepMs + this.#jitter + MARGIN_MS;
    return d < this.#min ? this.#min : d > this.#max ? this.#max : d;
  }

  #late(late: number, now: number): void {
    const j = Math.max(0, this.#jitter - (now - this.#jitterAt) * JITTER_DECAY);
    this.#jitter = late > j ? late : j;
    this.#jitterAt = now;
  }

  #restart(t: Track, offset: number, now: number): void {
    t.base = offset;
    t.baseAt = now;
    t.shift = offset + this.#target();
    t.err.fill(0);
    t.errAt = Number.NEGATIVE_INFINITY;
  }

  #slot(t: Track): number {
    if (t.count === this.#cap) {
      t.head = (t.head + 1) % this.#cap;
      t.count--;
    }
    return this.#o(t, t.count++);
  }

  #append(t: Track, step: number, pos: ArrayLike<number>, vel: ArrayLike<number>): void {
    const o = this.#slot(t);
    const r = t.ring;
    const D = this.dims;
    r[o] = step;
    for (let c = 0; c < D; c++) {
      r[o + 1 + c] = pos[c]!;
      r[o + 1 + D + c] = vel[c]!;
    }
  }

  /** Appends a still copy of the snapshot at `from`, at `step`. */
  #hold(t: Track, from: number, step: number): void {
    const r = t.ring;
    const D = this.dims;
    // Copy first: appending may overwrite `from` when the ring is full.
    const s = this.#s;
    for (let c = 0; c < D; c++) s[c] = r[from + 1 + c]!;
    const o = this.#slot(t);
    r[o] = step;
    for (let c = 0; c < D; c++) {
      r[o + 1 + c] = s[c]!;
      r[o + 1 + D + c] = 0;
    }
  }

  #fade(t: Track, now: number): number {
    const k = 1 - (now - t.errAt) / t.errMs;
    return k > 0 ? k : 0;
  }

  /** Where `t` is drawn at `now` and how fast (units a step) into `s`, before any fading difference. */
  #sample(t: Track, now: number, s: Float64Array): boolean {
    const n = t.count;
    if (n === 0) return false;
    const D = this.dims;
    const r = t.ring;
    const step = (now - t.shift) / this.stepMs;
    const first = this.#o(t, 0);
    if (step <= r[first]!) {
      for (let c = 0; c < D; c++) {
        s[c] = r[first + 1 + c]!;
        s[D + c] = 0;
      }
      return true;
    }
    const last = this.#o(t, n - 1);
    if (step >= r[last]!) {
      const ahead = Math.min(step - r[last]!, EXTRAPOLATE_STEPS);
      const going = step - r[last]! < EXTRAPOLATE_STEPS;
      for (let c = 0; c < D; c++) {
        const v = r[last + 1 + D + c]!;
        s[c] = r[last + 1 + c]! + v * ahead;
        s[D + c] = going ? v : 0;
      }
      return true;
    }
    let i = n - 2;
    while (i > 0 && r[this.#o(t, i)]! > step) i--;
    const a = this.#o(t, i);
    const b = this.#o(t, i + 1);
    const span = r[b]! - r[a]!;
    const k = (step - r[a]!) / span;
    for (let c = 0; c < D; c++) {
      const d = r[b + 1 + c]! - r[a + 1 + c]!;
      s[c] = r[a + 1 + c]! + d * k;
      s[D + c] = d / span;
    }
    return true;
  }
}
