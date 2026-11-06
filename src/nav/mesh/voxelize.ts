/**
 * Navmesh bake, stage one: triangles to a heightfield of spans, the walkability filters, the
 * compact heightfield (one record per walkable span with its four neighbours) and the erosion
 * by agent radius. The method is Recast's; the units inside are cells (`cellSize` across,
 * `cellHeight` up). Bake-time code: it allocates freely, queries never run here.
 */

/** Triangle soup to bake: positions as x, y, z (every `stride` floats, from `offset`) and indices. */
export interface NavBakeSource {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Floats per vertex in `positions` (3 for a bare position array, 12 for `geom`'s layout). Default 3. */
  stride?: number;
  /** Float index of the first vertex's x inside its stride. Default 0. */
  offset?: number;
}

export interface NavBakeOptions {
  /** World units per heightfield cell across (XZ). The level's smallest feature should span a few. */
  cellSize: number;
  /** World units per heightfield cell up (Y). */
  cellHeight: number;
  /** The agent's height: a ceiling closer than this to the floor is not walkable. */
  agentHeight: number;
  /** The agent's radius: the walkable area is eroded by it, so the centre never leaves the floor. */
  agentRadius: number;
  /** The largest step the agent climbs (a kerb); a taller drop is a ledge. */
  agentMaxClimb: number;
  /** The steepest walkable slope, in degrees from flat. */
  agentMaxSlope: number;
  /** Regions (connected walkable islands) smaller than this many cells are dropped. Default 8. */
  minRegionArea?: number;
  /** Regions smaller than this many cells merge into a neighbour where that keeps it hole-free. Default 20. */
  mergeRegionArea?: number;
  /** Boundary edges longer than this (world units) are split. Default 12 × `cellSize`; 0 never splits. */
  maxEdgeLength?: number;
  /** How far (world units) a simplified contour may stray from the rasterised one. Default 1.3 × `cellSize`. */
  maxSimplification?: number;
  /** Vertices per polygon at most, 3..6. Default 6. */
  maxVertsPerPoly?: number;
}

export const NULL_AREA = 0;
export const WALKABLE_AREA = 1;
/** Spans are clamped to this many cells up. */
const SPAN_MAX_HEIGHT = 0x1fffffff;
export const NOT_CONNECTED = -1;

/** Neighbour offsets by direction: 0 = -x, 1 = +z, 2 = +x, 3 = -z. */
export const DIR_X = [-1, 0, 1, 0] as const;
export const DIR_Z = [0, 1, 0, -1] as const;

export interface Heightfield {
  width: number;
  height: number;
  bmin: [number, number, number];
  bmax: [number, number, number];
  cs: number;
  ch: number;
  /** First span of each column (`x + z * width`), or -1. */
  first: Int32Array;
  smin: Int32Array;
  smax: Int32Array;
  area: Uint8Array;
  next: Int32Array;
  /** Spans allocated so far (the pool's high-water mark). */
  count: number;
  /** Head of the free list of span slots, or -1. */
  free: number;
}

export interface CompactHeightfield {
  width: number;
  height: number;
  spanCount: number;
  walkableHeight: number;
  walkableClimb: number;
  bmin: [number, number, number];
  bmax: [number, number, number];
  cs: number;
  ch: number;
  /** First span and span count of each column. */
  cellIndex: Int32Array;
  cellCount: Int32Array;
  /** Per span: floor height (cells), free height above it, area, region. */
  y: Int32Array;
  h: Int32Array;
  areas: Uint8Array;
  regs: Uint16Array;
  /** Per span × 4 directions: the neighbour span index, or `NOT_CONNECTED`. */
  con: Int32Array;
  maxRegions: number;
}

export function computeBounds(
  sources: readonly NavBakeSource[],
  outMin: number[],
  outMax: number[],
): boolean {
  let any = false;
  outMin[0] = outMin[1] = outMin[2] = Number.POSITIVE_INFINITY;
  outMax[0] = outMax[1] = outMax[2] = Number.NEGATIVE_INFINITY;
  for (const src of sources) {
    const stride = src.stride ?? 3;
    const offset = src.offset ?? 0;
    const p = src.positions;
    const idx = src.indices;
    for (let i = 0; i < idx.length; i++) {
      const b = idx[i]! * stride + offset;
      const x = p[b]!;
      const y = p[b + 1]!;
      const z = p[b + 2]!;
      if (x < outMin[0]!) outMin[0] = x;
      if (y < outMin[1]!) outMin[1] = y;
      if (z < outMin[2]!) outMin[2] = z;
      if (x > outMax[0]!) outMax[0] = x;
      if (y > outMax[1]!) outMax[1] = y;
      if (z > outMax[2]!) outMax[2] = z;
      any = true;
    }
  }
  return any;
}

export function createHeightfield(
  width: number,
  height: number,
  bmin: readonly number[],
  bmax: readonly number[],
  cs: number,
  ch: number,
): Heightfield {
  const cap = Math.max(64, width * height);
  return {
    width,
    height,
    bmin: [bmin[0]!, bmin[1]!, bmin[2]!],
    bmax: [bmax[0]!, bmax[1]!, bmax[2]!],
    cs,
    ch,
    first: new Int32Array(width * height).fill(-1),
    smin: new Int32Array(cap),
    smax: new Int32Array(cap),
    area: new Uint8Array(cap),
    next: new Int32Array(cap),
    count: 0,
    free: -1,
  };
}

function allocSpan(hf: Heightfield): number {
  if (hf.free >= 0) {
    const s = hf.free;
    hf.free = hf.next[s]!;
    return s;
  }
  if (hf.count >= hf.smin.length) {
    const cap = Math.ceil(hf.smin.length * 1.5);
    const grow = <T extends Int32Array | Uint8Array>(a: T): T => {
      const n = new (a.constructor as new (n: number) => T)(cap);
      n.set(a as never);
      return n;
    };
    hf.smin = grow(hf.smin);
    hf.smax = grow(hf.smax);
    hf.area = grow(hf.area);
    hf.next = grow(hf.next);
  }
  return hf.count++;
}

/** Adds a span to a column, merging the spans it overlaps (Recast `rcAddSpan`). */
export function addSpan(
  hf: Heightfield,
  x: number,
  z: number,
  smin: number,
  smax: number,
  area: number,
  flagMergeThr: number,
): void {
  const idx = x + z * hf.width;
  let prev = -1;
  let cur = hf.first[idx]!;
  while (cur !== -1) {
    if (hf.smin[cur]! > smax) break;
    if (hf.smax[cur]! < smin) {
      prev = cur;
      cur = hf.next[cur]!;
      continue;
    }
    if (hf.smin[cur]! < smin) smin = hf.smin[cur]!;
    if (hf.smax[cur]! > smax) smax = hf.smax[cur]!;
    if (Math.abs(smax - hf.smax[cur]!) <= flagMergeThr) area = Math.max(area, hf.area[cur]!);
    const nxt = hf.next[cur]!;
    if (prev !== -1) hf.next[prev] = nxt;
    else hf.first[idx] = nxt;
    hf.next[cur] = hf.free;
    hf.free = cur;
    cur = nxt;
  }
  const s = allocSpan(hf);
  hf.smin[s] = smin;
  hf.smax[s] = smax;
  hf.area[s] = area;
  if (prev !== -1) {
    hf.next[s] = hf.next[prev]!;
    hf.next[prev] = s;
  } else {
    hf.next[s] = hf.first[idx]!;
    hf.first[idx] = s;
  }
}

// Clipping scratch: polygons of at most 7 vertices (a triangle gains at most two per cut), xyz.
const inBuf = new Float64Array(7 * 3);
const inRow = new Float64Array(7 * 3);
const p1 = new Float64Array(7 * 3);
const p2 = new Float64Array(7 * 3);
const cellBuf = new Float64Array(7 * 3);
const dBuf = new Float64Array(7);
const nOut = [0, 0];

/**
 * Splits a convex polygon by the plane `axis = offset` into `out1` (the side at or below the
 * offset) and `out2` (above); writes their vertex counts into `nOut`.
 */
function dividePoly(
  inp: Float64Array,
  nin: number,
  out1: Float64Array,
  out2: Float64Array,
  offset: number,
  axis: number,
): void {
  for (let i = 0; i < nin; i++) dBuf[i] = offset - inp[i * 3 + axis]!;
  let m = 0;
  let n = 0;
  for (let i = 0, j = nin - 1; i < nin; j = i, i++) {
    const di = dBuf[i]!;
    const dj = dBuf[j]!;
    const ina = dj >= 0;
    const inb = di >= 0;
    if (ina !== inb) {
      const s = dj / (dj - di);
      for (let k = 0; k < 3; k++) {
        const v = inp[j * 3 + k]! + (inp[i * 3 + k]! - inp[j * 3 + k]!) * s;
        out1[m * 3 + k] = v;
        out2[n * 3 + k] = v;
      }
      m++;
      n++;
      if (di > 0) {
        for (let k = 0; k < 3; k++) out1[m * 3 + k] = inp[i * 3 + k]!;
        m++;
      } else if (di < 0) {
        for (let k = 0; k < 3; k++) out2[n * 3 + k] = inp[i * 3 + k]!;
        n++;
      }
    } else {
      if (di >= 0) {
        for (let k = 0; k < 3; k++) out1[m * 3 + k] = inp[i * 3 + k]!;
        m++;
        if (di !== 0) continue;
      }
      for (let k = 0; k < 3; k++) out2[n * 3 + k] = inp[i * 3 + k]!;
      n++;
    }
  }
  nOut[0] = m;
  nOut[1] = n;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Rasterises one triangle (world coordinates) into the heightfield. */
export function rasterizeTriangle(
  hf: Heightfield,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  area: number,
  flagMergeThr: number,
): void {
  const bmin = hf.bmin;
  const bmax = hf.bmax;
  const tminX = Math.min(x0, x1, x2);
  const tmaxX = Math.max(x0, x1, x2);
  const tminZ = Math.min(z0, z1, z2);
  const tmaxZ = Math.max(z0, z1, z2);
  const tminY = Math.min(y0, y1, y2);
  const tmaxY = Math.max(y0, y1, y2);
  if (tmaxX < bmin[0] || tminX > bmax[0] || tmaxZ < bmin[2] || tminZ > bmax[2]) return;
  if (tmaxY < bmin[1] || tminY > bmax[1]) return;
  const w = hf.width;
  const h = hf.height;
  const cs = hf.cs;
  const ics = 1 / cs;
  const ich = 1 / hf.ch;
  const by = bmax[1] - bmin[1];

  let zc0 = Math.floor((tminZ - bmin[2]) * ics);
  let zc1 = Math.floor((tmaxZ - bmin[2]) * ics);
  zc0 = clampInt(zc0, -1, h - 1);
  zc1 = clampInt(zc1, 0, h - 1);

  let inp = inBuf;
  let rem = p1;
  inp[0] = x0;
  inp[1] = y0;
  inp[2] = z0;
  inp[3] = x1;
  inp[4] = y1;
  inp[5] = z1;
  inp[6] = x2;
  inp[7] = y2;
  inp[8] = z2;
  let nvIn = 3;

  for (let z = zc0; z <= zc1; z++) {
    const cellZ = bmin[2] + z * cs;
    dividePoly(inp, nvIn, inRow, rem, cellZ + cs, 2);
    const nvRow = nOut[0]!;
    nvIn = nOut[1]!;
    const t = inp;
    inp = rem;
    rem = t;
    if (nvRow < 3) continue;
    if (z < 0) continue;
    let minX = inRow[0]!;
    let maxX = inRow[0]!;
    for (let i = 1; i < nvRow; i++) {
      const vx = inRow[i * 3]!;
      if (vx < minX) minX = vx;
      if (vx > maxX) maxX = vx;
    }
    let xc0 = Math.floor((minX - bmin[0]) * ics);
    let xc1 = Math.floor((maxX - bmin[0]) * ics);
    if (xc1 < 0 || xc0 >= w) continue;
    xc0 = clampInt(xc0, -1, w - 1);
    xc1 = clampInt(xc1, 0, w - 1);
    let row = inRow;
    let rowRem = p2;
    let nv2 = nvRow;
    for (let x = xc0; x <= xc1; x++) {
      const cx = bmin[0] + x * cs;
      dividePoly(row, nv2, cellBuf, rowRem, cx + cs, 0);
      const cell = cellBuf;
      const nv = nOut[0]!;
      nv2 = nOut[1]!;
      const t2 = row;
      row = rowRem;
      rowRem = t2;
      if (nv < 3) continue;
      if (x < 0) continue;
      let smin = cell[1]!;
      let smax = cell[1]!;
      for (let i = 1; i < nv; i++) {
        const vy = cell[i * 3 + 1]!;
        if (vy < smin) smin = vy;
        if (vy > smax) smax = vy;
      }
      smin -= bmin[1];
      smax -= bmin[1];
      if (smax < 0 || smin > by) continue;
      if (smin < 0) smin = 0;
      if (smax > by) smax = by;
      const ismin = clampInt(Math.floor(smin * ich), 0, SPAN_MAX_HEIGHT);
      const ismax = clampInt(Math.ceil(smax * ich), ismin + 1, SPAN_MAX_HEIGHT);
      addSpan(hf, x, z, ismin, ismax, area, flagMergeThr);
    }
  }
}

/**
 * Rasterises every triangle of every source. A triangle whose normal is steeper than
 * `maxSlopeDeg` from +y is rasterised as an obstacle (`NULL_AREA`) so it blocks; others as
 * walkable floor.
 */
export function rasterizeSources(
  hf: Heightfield,
  sources: readonly NavBakeSource[],
  maxSlopeDeg: number,
  flagMergeThr: number,
): number {
  const cosSlope = Math.cos((maxSlopeDeg * Math.PI) / 180);
  let tris = 0;
  for (const src of sources) {
    const stride = src.stride ?? 3;
    const offset = src.offset ?? 0;
    const p = src.positions;
    const idx = src.indices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i]! * stride + offset;
      const b = idx[i + 1]! * stride + offset;
      const c = idx[i + 2]! * stride + offset;
      const ax = p[a]!;
      const ay = p[a + 1]!;
      const az = p[a + 2]!;
      const bx = p[b]!;
      const by = p[b + 1]!;
      const bz = p[b + 2]!;
      const cx = p[c]!;
      const cy = p[c + 1]!;
      const cz = p[c + 2]!;
      const e0x = bx - ax;
      const e0y = by - ay;
      const e0z = bz - az;
      const e1x = cx - ax;
      const e1y = cy - ay;
      const e1z = cz - az;
      const nx = e0y * e1z - e0z * e1y;
      const ny = e0z * e1x - e0x * e1z;
      const nz = e0x * e1y - e0y * e1x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const area = len > 0 && ny / len > cosSlope ? WALKABLE_AREA : NULL_AREA;
      rasterizeTriangle(hf, ax, ay, az, bx, by, bz, cx, cy, cz, area, flagMergeThr);
      tris++;
    }
  }
  return tris;
}

/** A blocking span resting on a walkable one, no higher than a step, becomes walkable (a kerb). */
export function filterLowHangingWalkableObstacles(hf: Heightfield, walkableClimb: number): void {
  const n = hf.width * hf.height;
  for (let c = 0; c < n; c++) {
    let ps = -1;
    let previousWalkable = false;
    let previousArea = NULL_AREA;
    for (let s = hf.first[c]!; s !== -1; ps = s, s = hf.next[s]!) {
      const walkable = hf.area[s] !== NULL_AREA;
      if (!walkable && previousWalkable && ps !== -1) {
        if (Math.abs(hf.smax[s]! - hf.smax[ps]!) <= walkableClimb) hf.area[s] = previousArea;
      }
      previousWalkable = walkable;
      previousArea = hf.area[s]!;
    }
  }
}

/** A span whose drop to a neighbour exceeds the climb, or whose neighbours differ too much in height, is a ledge. */
export function filterLedgeSpans(
  hf: Heightfield,
  walkableHeight: number,
  walkableClimb: number,
): void {
  const w = hf.width;
  const h = hf.height;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      for (let s = hf.first[x + z * w]!; s !== -1; s = hf.next[s]!) {
        if (hf.area[s] === NULL_AREA) continue;
        const bot = hf.smax[s]!;
        const nextS = hf.next[s]!;
        const top = nextS !== -1 ? hf.smin[nextS]! : SPAN_MAX_HEIGHT;
        let minHeight = SPAN_MAX_HEIGHT;
        let asmin = bot;
        let asmax = bot;
        for (let dir = 0; dir < 4; dir++) {
          const dx = x + DIR_X[dir]!;
          const dz = z + DIR_Z[dir]!;
          if (dx < 0 || dz < 0 || dx >= w || dz >= h) {
            minHeight = Math.min(minHeight, -walkableClimb - bot);
            continue;
          }
          const ns0 = hf.first[dx + dz * w]!;
          let nbot = -walkableClimb;
          let ntop = ns0 !== -1 ? hf.smin[ns0]! : SPAN_MAX_HEIGHT;
          if (Math.min(top, ntop) - Math.max(bot, nbot) > walkableHeight) {
            minHeight = Math.min(minHeight, nbot - bot);
          }
          for (let ns = ns0; ns !== -1; ns = hf.next[ns]!) {
            nbot = hf.smax[ns]!;
            const nn = hf.next[ns]!;
            ntop = nn !== -1 ? hf.smin[nn]! : SPAN_MAX_HEIGHT;
            if (Math.min(top, ntop) - Math.max(bot, nbot) > walkableHeight) {
              minHeight = Math.min(minHeight, nbot - bot);
              if (Math.abs(nbot - bot) <= walkableClimb) {
                if (nbot < asmin) asmin = nbot;
                if (nbot > asmax) asmax = nbot;
              }
            }
          }
        }
        if (minHeight < -walkableClimb) hf.area[s] = NULL_AREA;
        else if (asmax - asmin > walkableClimb) hf.area[s] = NULL_AREA;
      }
    }
  }
}

/** A span with less than the agent's height of free space above it is not walkable. */
export function filterWalkableLowHeightSpans(hf: Heightfield, walkableHeight: number): void {
  const n = hf.width * hf.height;
  for (let c = 0; c < n; c++) {
    for (let s = hf.first[c]!; s !== -1; s = hf.next[s]!) {
      const bot = hf.smax[s]!;
      const nextS = hf.next[s]!;
      const top = nextS !== -1 ? hf.smin[nextS]! : SPAN_MAX_HEIGHT;
      if (top - bot <= walkableHeight) hf.area[s] = NULL_AREA;
    }
  }
}

/** One record per walkable span, with its four neighbour connections. */
export function buildCompactHeightfield(
  hf: Heightfield,
  walkableHeight: number,
  walkableClimb: number,
): CompactHeightfield {
  const w = hf.width;
  const h = hf.height;
  let spanCount = 0;
  for (let c = 0; c < w * h; c++) {
    for (let s = hf.first[c]!; s !== -1; s = hf.next[s]!) if (hf.area[s] !== NULL_AREA) spanCount++;
  }
  const chf: CompactHeightfield = {
    width: w,
    height: h,
    spanCount,
    walkableHeight,
    walkableClimb,
    bmin: [hf.bmin[0], hf.bmin[1], hf.bmin[2]],
    bmax: [hf.bmax[0], hf.bmax[1] + walkableHeight * hf.ch, hf.bmax[2]],
    cs: hf.cs,
    ch: hf.ch,
    cellIndex: new Int32Array(w * h),
    cellCount: new Int32Array(w * h),
    y: new Int32Array(spanCount),
    h: new Int32Array(spanCount),
    areas: new Uint8Array(spanCount),
    regs: new Uint16Array(spanCount),
    con: new Int32Array(spanCount * 4).fill(NOT_CONNECTED),
    maxRegions: 0,
  };
  let idx = 0;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      chf.cellIndex[c] = idx;
      let count = 0;
      for (let s = hf.first[c]!; s !== -1; s = hf.next[s]!) {
        if (hf.area[s] === NULL_AREA) continue;
        const bot = hf.smax[s]!;
        const nextS = hf.next[s]!;
        const top = nextS !== -1 ? hf.smin[nextS]! : SPAN_MAX_HEIGHT;
        chf.y[idx] = bot;
        chf.h[idx] = Math.min(top - bot, SPAN_MAX_HEIGHT);
        chf.areas[idx] = hf.area[s]!;
        idx++;
        count++;
      }
      chf.cellCount[c] = count;
    }
  }
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      const end = chf.cellIndex[c]! + chf.cellCount[c]!;
      for (let i = chf.cellIndex[c]!; i < end; i++) {
        const sy = chf.y[i]!;
        const sh = chf.h[i]!;
        for (let dir = 0; dir < 4; dir++) {
          const nx = x + DIR_X[dir]!;
          const nz = z + DIR_Z[dir]!;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const nc = nx + nz * w;
          const nend = chf.cellIndex[nc]! + chf.cellCount[nc]!;
          for (let k = chf.cellIndex[nc]!; k < nend; k++) {
            const ny = chf.y[k]!;
            const bot = Math.max(sy, ny);
            const top = Math.min(sy + sh, ny + chf.h[k]!);
            if (top - bot >= walkableHeight && Math.abs(ny - sy) <= walkableClimb) {
              chf.con[i * 4 + dir] = k;
              break;
            }
          }
        }
      }
    }
  }
  return chf;
}

/** Marks every walkable span within `radius` cells of a boundary unwalkable (Recast `rcErodeWalkableArea`). */
export function erodeWalkableArea(chf: CompactHeightfield, radius: number): void {
  const w = chf.width;
  const h = chf.height;
  const n = chf.spanCount;
  const dist = new Uint8Array(n).fill(255);
  const con = chf.con;
  const areas = chf.areas;
  for (let i = 0; i < n; i++) {
    if (areas[i] === NULL_AREA) {
      dist[i] = 0;
      continue;
    }
    let nc = 0;
    for (let dir = 0; dir < 4; dir++) {
      const ai = con[i * 4 + dir]!;
      if (ai !== NOT_CONNECTED && areas[ai] !== NULL_AREA) nc++;
    }
    if (nc !== 4) dist[i] = 0;
  }
  const relax = (i: number, dir: number, diag: number) => {
    const ai = con[i * 4 + dir]!;
    if (ai === NOT_CONNECTED) return;
    let nd = Math.min(dist[ai]! + 2, 255);
    if (nd < dist[i]!) dist[i] = nd;
    const aai = con[ai * 4 + diag]!;
    if (aai === NOT_CONNECTED) return;
    nd = Math.min(dist[aai]! + 3, 255);
    if (nd < dist[i]!) dist[i] = nd;
  };
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      const end = chf.cellIndex[c]! + chf.cellCount[c]!;
      for (let i = chf.cellIndex[c]!; i < end; i++) {
        relax(i, 0, 3);
        relax(i, 3, 2);
      }
    }
  }
  for (let z = h - 1; z >= 0; z--) {
    for (let x = w - 1; x >= 0; x--) {
      const c = x + z * w;
      const end = chf.cellIndex[c]! + chf.cellCount[c]!;
      for (let i = chf.cellIndex[c]!; i < end; i++) {
        relax(i, 2, 1);
        relax(i, 1, 0);
      }
    }
  }
  const thr = radius * 2;
  for (let i = 0; i < n; i++) if (dist[i]! < thr) areas[i] = NULL_AREA;
}
