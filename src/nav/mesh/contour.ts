/**
 * Navmesh bake, stage three: contours. Each region's boundary is walked cell by cell, then
 * simplified (points where the neighbouring region changes are kept, the rest within
 * `maxError`), and long outer edges are split. Recast `rcBuildContours`, in cells; vertices are
 * `x, y, z, flags` with the neighbour region in the low 16 bits of `flags`.
 */
import { type CompactHeightfield, DIR_X, DIR_Z, NOT_CONNECTED, NULL_AREA } from './voxelize';

export const CONTOUR_REG_MASK = 0xffff;
export const AREA_BORDER = 0x20000;

export interface Contour {
  /** Simplified vertices, `x, y, z, flags` per vertex (cells). */
  verts: number[];
  reg: number;
  area: number;
}

function cornerHeight(i: number, dir: number, chf: CompactHeightfield): number {
  let ch = chf.y[i]!;
  const dirp = (dir + 1) & 3;
  const ai = chf.con[i * 4 + dir]!;
  if (ai !== NOT_CONNECTED) {
    ch = Math.max(ch, chf.y[ai]!);
    const ai2 = chf.con[ai * 4 + dirp]!;
    if (ai2 !== NOT_CONNECTED) ch = Math.max(ch, chf.y[ai2]!);
  }
  const bi = chf.con[i * 4 + dirp]!;
  if (bi !== NOT_CONNECTED) {
    ch = Math.max(ch, chf.y[bi]!);
    const bi2 = chf.con[bi * 4 + dir]!;
    if (bi2 !== NOT_CONNECTED) ch = Math.max(ch, chf.y[bi2]!);
  }
  return ch;
}

function walkContour(
  x0: number,
  z0: number,
  i0: number,
  chf: CompactHeightfield,
  flags: Uint8Array,
  points: number[],
): void {
  let x = x0;
  let z = z0;
  let i = i0;
  let dir = 0;
  while ((flags[i]! & (1 << dir)) === 0) dir++;
  const startDir = dir;
  const area = chf.areas[i]!;
  let iter = 0;
  while (++iter < 40000) {
    if (flags[i]! & (1 << dir)) {
      let px = x;
      const py = cornerHeight(i, dir, chf);
      let pz = z;
      switch (dir) {
        case 0:
          pz++;
          break;
        case 1:
          px++;
          pz++;
          break;
        case 2:
          px++;
          break;
        default:
          break;
      }
      let r = 0;
      const ai = chf.con[i * 4 + dir]!;
      if (ai !== NOT_CONNECTED) {
        r = chf.regs[ai]!;
        if (area !== chf.areas[ai]) r |= AREA_BORDER;
      }
      points.push(px, py, pz, r);
      flags[i] = flags[i]! & ~(1 << dir);
      dir = (dir + 1) & 3;
    } else {
      const ni = chf.con[i * 4 + dir]!;
      if (ni === NOT_CONNECTED) return;
      x += DIR_X[dir]!;
      z += DIR_Z[dir]!;
      i = ni;
      dir = (dir + 3) & 3;
    }
    if (i0 === i && startDir === dir) break;
  }
}

/** Squared distance from a point to a segment, in the XZ plane. */
function distancePtSeg(
  x: number,
  z: number,
  px: number,
  pz: number,
  qx: number,
  qz: number,
): number {
  const pqx = qx - px;
  const pqz = qz - pz;
  let dx = x - px;
  let dz = z - pz;
  const d = pqx * pqx + pqz * pqz;
  let t = pqx * dx + pqz * dz;
  if (d > 0) t /= d;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  dx = px + t * pqx - x;
  dz = pz + t * pqz - z;
  return dx * dx + dz * dz;
}

function simplifyContour(
  points: number[],
  simplified: number[],
  maxError: number,
  maxEdgeLen: number,
): void {
  const pn = points.length / 4;
  let hasConnections = false;
  for (let i = 0; i < pn; i++) {
    if ((points[i * 4 + 3]! & CONTOUR_REG_MASK) !== 0) {
      hasConnections = true;
      break;
    }
  }
  if (hasConnections) {
    for (let i = 0; i < pn; i++) {
      const ii = (i + 1) % pn;
      const differentRegs =
        (points[i * 4 + 3]! & CONTOUR_REG_MASK) !== (points[ii * 4 + 3]! & CONTOUR_REG_MASK);
      const areaBorders =
        (points[i * 4 + 3]! & AREA_BORDER) !== (points[ii * 4 + 3]! & AREA_BORDER);
      if (differentRegs || areaBorders) {
        simplified.push(points[i * 4]!, points[i * 4 + 1]!, points[i * 4 + 2]!, i);
      }
    }
  }
  if (simplified.length === 0) {
    let llx = points[0]!;
    let lly = points[1]!;
    let llz = points[2]!;
    let lli = 0;
    let urx = points[0]!;
    let ury = points[1]!;
    let urz = points[2]!;
    let uri = 0;
    for (let i = 0; i < pn; i++) {
      const x = points[i * 4]!;
      const y = points[i * 4 + 1]!;
      const z = points[i * 4 + 2]!;
      if (x < llx || (x === llx && z < llz)) {
        llx = x;
        lly = y;
        llz = z;
        lli = i;
      }
      if (x > urx || (x === urx && z > urz)) {
        urx = x;
        ury = y;
        urz = z;
        uri = i;
      }
    }
    simplified.push(llx, lly, llz, lli, urx, ury, urz, uri);
  }

  // Add points until every raw point is within the error of the simplified shape.
  for (let i = 0; i < simplified.length / 4; ) {
    const n = simplified.length / 4;
    const ii = (i + 1) % n;
    let ax = simplified[i * 4]!;
    let az = simplified[i * 4 + 2]!;
    const ai = simplified[i * 4 + 3]!;
    let bx = simplified[ii * 4]!;
    let bz = simplified[ii * 4 + 2]!;
    const bi = simplified[ii * 4 + 3]!;
    let maxd = 0;
    let maxi = -1;
    let ci: number;
    let cinc: number;
    let endi: number;
    // Traverse in lexicographic order so opposite traversals of a shared edge agree.
    if (bx > ax || (bx === ax && bz > az)) {
      cinc = 1;
      ci = (ai + cinc) % pn;
      endi = bi;
    } else {
      cinc = pn - 1;
      ci = (bi + cinc) % pn;
      endi = ai;
      const tx = ax;
      ax = bx;
      bx = tx;
      const tz = az;
      az = bz;
      bz = tz;
    }
    // Tessellate only outer edges or edges between areas.
    if ((points[ci * 4 + 3]! & CONTOUR_REG_MASK) === 0 || points[ci * 4 + 3]! & AREA_BORDER) {
      while (ci !== endi) {
        const d = distancePtSeg(points[ci * 4]!, points[ci * 4 + 2]!, ax, az, bx, bz);
        if (d > maxd) {
          maxd = d;
          maxi = ci;
        }
        ci = (ci + cinc) % pn;
      }
    }
    if (maxi !== -1 && maxd > maxError * maxError) {
      simplified.splice(
        (i + 1) * 4,
        0,
        points[maxi * 4]!,
        points[maxi * 4 + 1]!,
        points[maxi * 4 + 2]!,
        maxi,
      );
    } else {
      i++;
    }
  }

  // Split too long outer edges.
  if (maxEdgeLen > 0) {
    for (let i = 0; i < simplified.length / 4; ) {
      const n = simplified.length / 4;
      const ii = (i + 1) % n;
      const ax = simplified[i * 4]!;
      const az = simplified[i * 4 + 2]!;
      const ai = simplified[i * 4 + 3]!;
      const bx = simplified[ii * 4]!;
      const bz = simplified[ii * 4 + 2]!;
      const bi = simplified[ii * 4 + 3]!;
      let maxi = -1;
      const ci = (ai + 1) % pn;
      if ((points[ci * 4 + 3]! & CONTOUR_REG_MASK) === 0) {
        const dx = bx - ax;
        const dz = bz - az;
        if (dx * dx + dz * dz > maxEdgeLen * maxEdgeLen) {
          const cnt = bi < ai ? bi + pn - ai : bi - ai;
          if (cnt > 1) {
            if (bx > ax || (bx === ax && bz > az)) maxi = (ai + (cnt >> 1)) % pn;
            else maxi = (ai + ((cnt + 1) >> 1)) % pn;
          }
        }
      }
      if (maxi !== -1) {
        simplified.splice(
          (i + 1) * 4,
          0,
          points[maxi * 4]!,
          points[maxi * 4 + 1]!,
          points[maxi * 4 + 2]!,
          maxi,
        );
      } else {
        i++;
      }
    }
  }

  for (let i = 0; i < simplified.length / 4; i++) {
    // The neighbour region of an edge comes from the raw point after the vertex.
    const ai = (simplified[i * 4 + 3]! + 1) % pn;
    simplified[i * 4 + 3] = points[ai * 4 + 3]! & (CONTOUR_REG_MASK | AREA_BORDER);
  }
}

function removeDegenerateSegments(simplified: number[]): void {
  let npts = simplified.length / 4;
  for (let i = 0; i < npts; i++) {
    const ni = (i + 1) % npts;
    if (
      simplified[i * 4] === simplified[ni * 4] &&
      simplified[i * 4 + 2] === simplified[ni * 4 + 2]
    ) {
      simplified.splice(i * 4, 4);
      npts--;
      i--;
    }
  }
}

/** Twice the signed area of a contour in the XZ plane. */
export function contourArea2(verts: number[]): number {
  const n = verts.length / 4;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += verts[i * 4]! * verts[j * 4 + 2]! - verts[j * 4]! * verts[i * 4 + 2]!;
  }
  return area;
}

/**
 * Builds one simplified contour per region. `maxError` and `maxEdgeLen` are in cells. A contour
 * that comes out as a hole (reversed winding) cannot happen with hole-free regions and is dropped.
 */
export function buildContours(
  chf: CompactHeightfield,
  maxError: number,
  maxEdgeLen: number,
): Contour[] {
  const w = chf.width;
  const h = chf.height;
  const flags = new Uint8Array(chf.spanCount);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      const end = chf.cellIndex[c]! + chf.cellCount[c]!;
      for (let i = chf.cellIndex[c]!; i < end; i++) {
        let res = 0;
        if (chf.regs[i] === 0 || chf.areas[i] === NULL_AREA) {
          flags[i] = 0;
          continue;
        }
        for (let dir = 0; dir < 4; dir++) {
          const ai = chf.con[i * 4 + dir]!;
          const r = ai !== NOT_CONNECTED ? chf.regs[ai]! : 0;
          if (r === chf.regs[i]) res |= 1 << dir;
        }
        flags[i] = res ^ 0xf;
      }
    }
  }
  const contours: Contour[] = [];
  const verts: number[] = [];
  const simplified: number[] = [];
  // The sign of a region's outer boundary, from the first contour built (all share the walk order).
  let outerSign = 0;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      const end = chf.cellIndex[c]! + chf.cellCount[c]!;
      for (let i = chf.cellIndex[c]!; i < end; i++) {
        if (flags[i] === 0 || flags[i] === 0xf) {
          flags[i] = 0;
          continue;
        }
        const reg = chf.regs[i]!;
        if (reg === 0) continue;
        const area = chf.areas[i]!;
        verts.length = 0;
        simplified.length = 0;
        walkContour(x, z, i, chf, flags, verts);
        simplifyContour(verts, simplified, maxError, maxEdgeLen);
        removeDegenerateSegments(simplified);
        if (simplified.length / 4 >= 3) {
          const a = contourArea2(simplified);
          if (a === 0) continue;
          if (outerSign === 0) outerSign = a > 0 ? 1 : -1;
          if ((a > 0 ? 1 : -1) !== outerSign) continue;
          contours.push({ verts: simplified.slice(), reg, area });
        }
      }
    }
  }
  return contours;
}
