/**
 * Connectivity (cave) culling for a streamed voxel world (Checchi 2014, "advanced cave
 * culling"), generalized from Forge Wilds' `render/visibility.ts`: which held sections the
 * camera could see into at all, so geometry behind solid ground is not drawn.
 *
 * Each section's open cells connect some of its six faces (15 bits, from the mesher:
 * connectivity.ts). A search walks from the sections around the eye through the faces each
 * section connects, never stepping back against a direction it has taken (a line of sight never
 * does), and marks what it reaches. The world hides what was not reached; the search knows
 * nothing of where the camera looks, so turning costs nothing.
 *
 * The search runs when the camera enters another section or the area moves, at once when a
 * section within two of the camera opens up (a wall dug through), at most four times a second
 * for an opening farther away, and once a second for changes that can only hide more
 * (sections streaming in, closing up). Sections not meshed yet count as open inside the area,
 * so nothing is hidden on a guess. With the eye inside an opaque block the culling stands
 * aside.
 *
 * Step budget: each step costs 1, and passing a section with no light in its open cells costs
 * `darkCost` more, so a branch through dark sections (caves) ends sooner: the budget reaches
 * every section of the area by a lit path, plus `darkSteps` dark sections at its far edge.
 */
import { ALL_FACE_PAIRS, facePairBit } from './connectivity';
import { sectionKey } from './format';

/** A box of sections, inclusive. */
export interface SectionBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Options for `SectionVisibility`. */
export interface SectionVisibilityOptions {
  /** Cells per section side. */
  sectionSize: number;
  /** Whether the cell at a world block is an opaque cube (false where unknown). */
  solidAt: (x: number, y: number, z: number) => boolean;
  /** Sections held beyond the area searched (entered only when held). Default 2. */
  margin?: number;
  /** Dark sections a search may pass at the far edge of its lit reach. Default 6. */
  darkSteps?: number;
  /** What a dark section adds to a step, 0..3. Default 3. */
  darkCost?: number;
  /** Largest area side, in sections, the held-connectivity grid wraps at (a power of two). Default 128. */
  wrapXZ?: number;
  /** The same for y. Default 64. */
  wrapY?: number;
  /** Clock for the throttles and `stats.lastMs`, ms. Default `performance.now`. */
  clock?: () => number;
}

/** What `SectionVisibility.stats` reports. */
export interface SectionVisibilityStats {
  /** Searches run, and of those how many a crossing (or the area moving) started. */
  searches: number;
  crossings: number;
  /** Sections expanded over every search. */
  visited: number;
  /** The last search: sections reached and expanded, and its time, ms. */
  lastReached: number;
  lastVisited: number;
  lastMs: number;
  /** Connectivity changes in the area, and of those, openings near the camera. */
  changes: number;
  nearOpenings: number;
}

/** A section's 15 pair bits as exits: for each face s (5 bits at 5s), the faces entering by s reaches. */
function exitsOf(bits: number): number {
  let out = 0;
  for (let s = 0; s < 6; s++) {
    let v = 0;
    let k = 0;
    for (let g = 0; g < 6; g++) {
      if (g === s) continue;
      if (bits & facePairBit(s, g)) v |= 1 << k;
      k++;
    }
    out |= v << (5 * s);
  }
  return out;
}
const ALL_EXITS = (1 << 30) - 1;
const DARK_BIT = 1 << 30;
const UNKNOWN = -1;
/** `EXPAND[s * 32 + v]`: the faces (6 bits) that 5 exit bits of face s name. */
const EXPAND = new Uint8Array(6 * 32);
for (let s = 0; s < 6; s++) {
  for (let v = 0; v < 32; v++) {
    let m = 0;
    let k = 0;
    for (let g = 0; g < 6; g++) {
      if (g === s) continue;
      if (v & (1 << k)) m |= 1 << g;
      k++;
    }
    EXPAND[s * 32 + v] = m;
  }
}
const SEED = 64;
const SRC_MASK = 127;
const DIRS_SHIFT = 7;
const COST_SHIFT = 13;
const OPENING_INTERVAL_MS = 250;
const CLOSING_INTERVAL_MS = 1000;
const NEAR = 2;
const SEED_REACH = 2;

function pow2(n: number, what: string): number {
  if (!(n >= 1) || (n & (n - 1)) !== 0) throw new RangeError(`${what} must be a power of two`);
  return n;
}

/** Which sections the camera could see into. Pure: no GPU (the world applies it). */
export class SectionVisibility {
  readonly stats: SectionVisibilityStats = {
    searches: 0,
    crossings: 0,
    visited: 0,
    lastReached: 0,
    lastVisited: 0,
    lastMs: 0,
    changes: 0,
    nearOpenings: 0,
  };
  /** Bumped whenever what `reached` answers may have changed. */
  version = 0;

  private readonly size: number;
  private readonly solidAt: (x: number, y: number, z: number) => boolean;
  private readonly clock: () => number;
  private readonly margin: number;
  private readonly darkSteps: number;
  private readonly darkCost: number;
  private readonly buckets: Int32Array[] = [];
  private readonly bucketLen: Int32Array;
  private readonly nBuckets: number;
  private readonly wx: number;
  private readonly wy: number;
  private readonly keys: Float64Array;
  private readonly info: Int32Array;
  private readonly opens: Uint16Array;

  private area: SectionBox | null = null;
  private hasArea = false;
  private x0 = 0;
  private y0 = 0;
  private z0 = 0;
  private sx = 0;
  private sy = 0;
  private sz = 0;
  private local = new Int32Array(0);
  private spare = new Int32Array(0);
  private searched = false;
  private epoch = 0;
  private mark = new Uint32Array(0);
  private state = new Uint32Array(0);
  private waiting = new Int16Array(0);

  private eyeX = Number.NaN;
  private eyeY = Number.NaN;
  private eyeZ = Number.NaN;
  private camX = Number.NaN;
  private camY = Number.NaN;
  private camZ = Number.NaN;
  private eyeSolid = false;
  private eyeInArea = false;
  private on = true;
  private wasActive = false;
  private lastSearch = Number.NEGATIVE_INFINITY;
  private nearOpening = false;
  private opened = false;
  private closed = false;
  private areaMoved = false;

  constructor(opts: SectionVisibilityOptions) {
    this.size = opts.sectionSize;
    this.solidAt = opts.solidAt;
    this.clock = opts.clock ?? (() => performance.now());
    this.margin = opts.margin ?? 2;
    this.darkSteps = opts.darkSteps ?? 6;
    this.darkCost = Math.max(0, Math.min(3, opts.darkCost ?? 3));
    this.nBuckets = 2 + this.darkCost;
    this.bucketLen = new Int32Array(this.nBuckets);
    for (let i = 0; i < this.nBuckets; i++) this.buckets.push(new Int32Array(0));
    this.wx = pow2(opts.wrapXZ ?? 128, 'wrapXZ');
    this.wy = pow2(opts.wrapY ?? 64, 'wrapY');
    const n = this.wx * this.wx * this.wy;
    this.keys = new Float64Array(n);
    this.info = new Int32Array(n);
    this.opens = new Uint16Array(n);
  }

  /** Culling on (the default) or off (frustum only). */
  get enabled(): boolean {
    return this.on;
  }

  set enabled(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.camX = Number.NaN;
    this.eyeX = Number.NaN;
    this.version++;
  }

  /** Changes wait for a throttled search: `update` needs a fresh clock. */
  get throttled(): boolean {
    return this.nearOpening || this.opened || this.closed;
  }

  /** Whether `reached` culls: on, searched, with the eye in the area and not inside a block. */
  get active(): boolean {
    return this.on && this.searched && this.eyeInArea && !this.eyeSolid;
  }

  /**
   * The area searched (the sections the world may hold, without the margin), or null. Kept by
   * reference: change it with `setArea` so the next `update` sees the move.
   */
  setArea(box: SectionBox | null): void {
    if (box) {
      const w = box.maxX - box.minX + 1 + 2 * this.margin;
      const d = box.maxZ - box.minZ + 1 + 2 * this.margin;
      const h = box.maxY - box.minY + 1 + 2 * this.margin;
      if (w > this.wx || d > this.wx || h > this.wy) {
        throw new RangeError(
          `visibility area ${w}×${h}×${d} sections (with margin) exceeds the wrap ${this.wx}×${this.wy}×${this.wx}`,
        );
      }
    }
    this.area = box;
    this.areaMoved = true;
  }

  private slot(x: number, y: number, z: number): number {
    const mx = this.wx - 1;
    return (x & mx) + (z & mx) * this.wx + (y & (this.wy - 1)) * this.wx * this.wx;
  }

  /** A meshed section's connectivity (`SectionMesh.connectivity`, `openCells`, `dark`). */
  set(x: number, y: number, z: number, bits: number, openCells: number, dark: boolean): void {
    const s = this.slot(x, y, z);
    const k = sectionKey(x, y, z) + 1;
    const v = (bits === ALL_FACE_PAIRS ? ALL_EXITS : exitsOf(bits)) | (dark ? DARK_BIT : 0);
    this.opens[s] = Math.min(openCells, 0xffff);
    if (this.keys[s] === k && this.info[s] === v) return;
    this.keys[s] = k;
    this.info[s] = v;
    this.note(x, y, z, v);
  }

  /** A section left: unknown again. */
  clear(x: number, y: number, z: number): void {
    const s = this.slot(x, y, z);
    if (this.keys[s] !== sectionKey(x, y, z) + 1) return;
    this.keys[s] = 0;
    this.note(x, y, z, UNKNOWN);
  }

  /** The open cells of a held section whose connectivity is known, else undefined. */
  openCells(x: number, y: number, z: number): number | undefined {
    const s = this.slot(x, y, z);
    return this.keys[s] === sectionKey(x, y, z) + 1 ? this.opens[s] : undefined;
  }

  /** Whether section (x, y, z) may be drawn: reached by the last search, or anything while inactive. */
  reached(x: number, y: number, z: number): boolean {
    if (!this.active) return true;
    const lx = x - this.x0;
    const ly = y - this.y0;
    const lz = z - this.z0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return true;
    return this.mark[lx + this.sx * (lz + this.sz * ly)] === this.epoch;
  }

  /**
   * Once a frame with the eye (world blocks) and the clock (ms): searches when needed (see the
   * file comment). A held camera costs a few comparisons and allocates nothing.
   */
  update(ex0: number, ey0: number, ez0: number, now: number): void {
    const ex = Math.floor(ex0);
    const ey = Math.floor(ey0);
    const ez = Math.floor(ez0);
    if (ex !== this.eyeX || ey !== this.eyeY || ez !== this.eyeZ) {
      this.eyeX = ex;
      this.eyeY = ey;
      this.eyeZ = ez;
      if (this.on) this.eyeSolid = this.solidAt(ex, ey, ez);
    }
    if (this.on) {
      const S = this.size;
      const cx = Math.floor(ex / S);
      const cy = Math.floor(ey / S);
      const cz = Math.floor(ez / S);
      const moved = this.areaMoved;
      const crossed = cx !== this.camX || cy !== this.camY || cz !== this.camZ;
      if (
        crossed ||
        moved ||
        this.nearOpening ||
        (this.opened && now - this.lastSearch >= OPENING_INTERVAL_MS) ||
        (this.closed && now - this.lastSearch >= CLOSING_INTERVAL_MS)
      ) {
        this.camX = cx;
        this.camY = cy;
        this.camZ = cz;
        this.areaMoved = false;
        if (crossed || moved) this.stats.crossings++;
        this.search(ex0, ey0, ez0, now);
      }
    }
    const active = this.active;
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.version++;
    }
  }

  private inside(lx: number, ly: number, lz: number): boolean {
    const m = this.margin;
    return (
      lx >= m && ly >= m && lz >= m && lx < this.sx - m && ly < this.sy - m && lz < this.sz - m
    );
  }

  private note(x: number, y: number, z: number, v: number): void {
    if (!this.hasArea) return;
    const lx = x - this.x0;
    const ly = y - this.y0;
    const lz = z - this.z0;
    const { sx, sz } = this;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= this.sy || lz >= sz) return;
    const i = lx + sx * (lz + sz * ly);
    const before = this.local[i]!;
    if (before === v) return;
    this.local[i] = v;
    this.stats.changes++;
    const inside = this.inside(lx, ly, lz);
    const was = before === UNKNOWN ? (inside ? ALL_EXITS : UNKNOWN) : before;
    const is = v === UNKNOWN ? (inside ? ALL_EXITS : UNKNOWN) : v;
    const opened =
      is !== UNKNOWN &&
      (was === UNKNOWN ||
        (is & ~was & ALL_EXITS) !== 0 ||
        ((was & DARK_BIT) !== 0 && (is & DARK_BIT) === 0));
    if (!opened) {
      this.closed = true;
    } else if (
      Math.abs(x - this.camX) <= NEAR &&
      Math.abs(y - this.camY) <= NEAR &&
      Math.abs(z - this.camZ) <= NEAR
    ) {
      this.stats.nearOpenings++;
      this.nearOpening = true;
    } else {
      this.opened = true;
    }
  }

  /** Make `local` the area at (x0, y0, z0) of size (sx, sy, sz), copying what the old one shares. */
  private moveLocal(x0: number, y0: number, z0: number, sx: number, sy: number, sz: number): void {
    const n = sx * sy * sz;
    const old = this.local;
    const same = this.hasArea && sx === this.sx && sy === this.sy && sz === this.sz;
    const ox = this.x0;
    const oy = this.y0;
    const oz = this.z0;
    if (this.spare.length < n) this.spare = new Int32Array(n);
    const out = this.spare;
    const { keys, info } = this;
    const dx = x0 - ox;
    const xa = same ? Math.max(0, -dx) : sx;
    const xb = same ? Math.min(sx, sx - dx) : sx;
    for (let ly = 0; ly < sy; ly++) {
      const y = ly + y0;
      const oly = y - oy;
      for (let lz = 0; lz < sz; lz++) {
        const z = lz + z0;
        const olz = z - oz;
        const row = sx * (lz + sz * ly);
        let a = 0;
        let c = 0;
        if (same && xa < xb && oly >= 0 && oly < sy && olz >= 0 && olz < sz) {
          const from = sx * (olz + sz * oly) + dx;
          for (let lx = xa; lx < xb; lx++) out[row + lx] = old[from + lx]!;
          a = xa;
          c = xb;
        }
        for (let lx = 0; lx < sx; lx++) {
          if (lx === a && c > a) lx = c;
          if (lx >= sx) break;
          const x = lx + x0;
          const s = this.slot(x, y, z);
          out[row + lx] = keys[s] === sectionKey(x, y, z) + 1 ? info[s]! : UNKNOWN;
        }
      }
    }
    this.spare = old;
    this.local = out;
  }

  private push(c: number, i: number): void {
    const k = c % this.nBuckets;
    let q = this.buckets[k]!;
    const n = this.bucketLen[k]!;
    if (n === q.length) {
      const grown = new Int32Array(q.length * 2 + 64);
      grown.set(q);
      this.buckets[k] = q = grown;
    }
    q[n] = i;
    this.bucketLen[k] = n + 1;
  }

  private search(ex: number, ey: number, ez: number, now: number): void {
    this.nearOpening = false;
    this.opened = false;
    this.closed = false;
    this.lastSearch = now;
    const b = this.area;
    if (!b) {
      this.searched = false;
      this.eyeInArea = false;
      this.hasArea = false;
      this.version++;
      return;
    }
    const t0 = this.clock();
    const M = this.margin;
    const S = this.size;
    const x0 = b.minX - M;
    const y0 = b.minY - M;
    const z0 = b.minZ - M;
    const sx = b.maxX - b.minX + 1 + 2 * M;
    const sy = b.maxY - b.minY + 1 + 2 * M;
    const sz = b.maxZ - b.minZ + 1 + 2 * M;
    if (
      !this.hasArea ||
      x0 !== this.x0 ||
      y0 !== this.y0 ||
      z0 !== this.z0 ||
      sx !== this.sx ||
      sy !== this.sy ||
      sz !== this.sz
    ) {
      this.moveLocal(x0, y0, z0, sx, sy, sz);
      this.x0 = x0;
      this.y0 = y0;
      this.z0 = z0;
      this.sx = sx;
      this.sy = sy;
      this.sz = sz;
      this.hasArea = true;
    }
    const n = sx * sy * sz;
    if (this.mark.length < n) {
      this.mark = new Uint32Array(n);
      this.state = new Uint32Array(n);
      this.waiting = new Int16Array(n);
      for (let i = 0; i < this.nBuckets; i++) this.buckets[i] = new Int32Array(n);
      this.epoch = 0;
    }
    if (this.epoch === 0xffffffff) {
      this.mark.fill(0);
      this.epoch = 0;
    }
    const epoch = ++this.epoch;
    this.searched = true;
    const cx = this.camX - x0;
    const cy = this.camY - y0;
    const cz = this.camZ - z0;
    this.eyeInArea = cx >= 0 && cy >= 0 && cz >= 0 && cx < sx && cy < sy && cz < sz;
    if (!this.eyeInArea) {
      this.stats.lastReached = 0;
      this.stats.lastVisited = 0;
      this.version++;
      return;
    }
    const darkCost = this.darkCost;
    const budget =
      Math.max(cx, sx - 1 - cx) +
      Math.max(cy, sy - 1 - cy) +
      Math.max(cz, sz - 1 - cz) +
      this.darkSteps * darkCost;
    const { mark, state, waiting, bucketLen, local } = this;
    const NB = this.nBuckets;
    bucketLen.fill(0);
    let queued = 0;
    let reached = 0;
    let visited = 0;
    const xa = Math.max(0, Math.floor((ex - SEED_REACH) / S) - x0);
    const xb = Math.min(sx - 1, Math.floor((ex + SEED_REACH) / S) - x0);
    const ya = Math.max(0, Math.floor((ey - SEED_REACH) / S) - y0);
    const yb = Math.min(sy - 1, Math.floor((ey + SEED_REACH) / S) - y0);
    const za = Math.max(0, Math.floor((ez - SEED_REACH) / S) - z0);
    const zb = Math.min(sz - 1, Math.floor((ez + SEED_REACH) / S) - z0);
    for (let y = ya; y <= yb; y++) {
      for (let z = za; z <= zb; z++) {
        for (let x = xa; x <= xb; x++) {
          const i = x + sx * (z + sz * y);
          mark[i] = epoch;
          state[i] = SEED;
          waiting[i] = 0;
          this.push(0, i);
          queued++;
          reached++;
        }
      }
    }
    const strideZ = sx;
    const strideY = sx * sz;
    const mx1 = sx - M;
    const my1 = sy - M;
    const mz1 = sz - M;
    for (let c = 0; queued > 0; c++) {
      const bk = c % NB;
      const q = this.buckets[bk]!;
      for (let k = 0; k < bucketLen[bk]!; k++) {
        const j = q[k]!;
        queued--;
        if (waiting[j] !== c) continue;
        waiting[j] = -1;
        visited++;
        const lx = j % sx;
        const t = (j - lx) / sx;
        const lz = t % sz;
        const ly = (t - lz) / sz;
        const v = local[j]!;
        const e = v === UNKNOWN ? ALL_EXITS : v & ALL_EXITS;
        const st = state[j]!;
        const from = st & SRC_MASK;
        let out: number;
        if (from & SEED || e === ALL_EXITS) out = 63;
        else if (e === 0) continue;
        else {
          out = 0;
          for (let s = 0; s < 6; s++) {
            if (from & (1 << s)) out |= EXPAND[s * 32 + ((e >>> (5 * s)) & 31)]!;
          }
        }
        const taken = (st >>> DIRS_SHIFT) & 63;
        out &= ~(((taken & 0b010101) << 1) | ((taken & 0b101010) >> 1));
        if (out === 0) continue;
        const nc = c + 1 + (v !== UNKNOWN && (v & DARK_BIT) !== 0 ? darkCost : 0);
        if (nc > budget) continue;
        for (let g = 0; g < 6; g++) {
          if ((out & (1 << g)) === 0) continue;
          let ni: number;
          if (g === 0) {
            if (lx === 0) continue;
            ni = j - 1;
          } else if (g === 1) {
            if (lx === sx - 1) continue;
            ni = j + 1;
          } else if (g === 2) {
            if (ly === 0) continue;
            ni = j - strideY;
          } else if (g === 3) {
            if (ly === sy - 1) continue;
            ni = j + strideY;
          } else if (g === 4) {
            if (lz === 0) continue;
            ni = j - strideZ;
          } else {
            if (lz === sz - 1) continue;
            ni = j + strideZ;
          }
          if (local[ni] === UNKNOWN) {
            const nx = lx + (g === 0 ? -1 : g === 1 ? 1 : 0);
            const ny = ly + (g === 2 ? -1 : g === 3 ? 1 : 0);
            const nz = lz + (g === 4 ? -1 : g === 5 ? 1 : 0);
            if (nx < M || ny < M || nz < M || nx >= mx1 || ny >= my1 || nz >= mz1) continue;
          }
          const nd = taken | (1 << g);
          const ns = 1 << (g ^ 1);
          if (mark[ni] !== epoch) {
            mark[ni] = epoch;
            state[ni] = ns | (nd << DIRS_SHIFT) | (nc << COST_SHIFT);
            waiting[ni] = nc;
            this.push(nc, ni);
            queued++;
            reached++;
            continue;
          }
          const os = state[ni]!;
          const oc = os >>> COST_SHIFT;
          const ms = (os & SRC_MASK) | ns;
          const md = (os >>> DIRS_SHIFT) & 63 & nd;
          const mc = nc < oc ? nc : oc;
          const merged = ms | (md << DIRS_SHIFT) | (mc << COST_SHIFT);
          if (merged === os) continue;
          state[ni] = merged;
          const w = waiting[ni]!;
          if (w >= 0 && w <= nc) continue;
          waiting[ni] = nc;
          this.push(nc, ni);
          queued++;
        }
      }
      bucketLen[bk] = 0;
    }
    const st = this.stats;
    st.searches++;
    st.visited += visited;
    st.lastVisited = visited;
    st.lastReached = reached;
    st.lastMs = this.clock() - t0;
    this.version++;
  }
}
