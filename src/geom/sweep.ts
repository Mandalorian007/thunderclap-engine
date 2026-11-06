/**
 * Shapes swept from 2D profiles, all in `VERTEX_LAYOUT_3D`: `extrude` (a closed outline pushed
 * along +z with capped, optionally bevelled ends), `lathe` (an open profile revolved around +y),
 * `sweep` (a closed outline carried along a 3D path with rotation-minimising or Frenet frames),
 * `tube` (a circle swept) and `polygon` (a flat triangulated outline facing +y).
 *
 * Every surface is wound counter-clockwise from outside with u along the outline and v along the
 * sweep, so the tangent frame `computeTangents` derives is right-handed (handedness +1) throughout.
 * Outlines are `Profile2D` (x, y pairs, counter-clockwise; clockwise is reversed on entry).
 */
import { type Geometry, type GeometryOptions, GeometryWriter } from './geometry';
import { type Profile2D, profileArea2, triangulate } from './triangulate';

export type { Profile2D } from './triangulate';

const TAU = Math.PI * 2;

/** A counter-clockwise `Float32Array` copy of `profile` (reversed when it came clockwise). */
function ccwProfile(profile: Profile2D, what: string): Float32Array {
  const n = profile.length >> 1;
  if (n < 3) throw new Error(`geom: ${what} needs a profile of at least 3 points, got ${n}`);
  const out = new Float32Array(n * 2);
  if (profileArea2(profile) >= 0) {
    for (let i = 0; i < n * 2; i++) out[i] = profile[i]!;
  } else {
    for (let i = 0; i < n; i++) {
      out[i * 2] = profile[(n - 1 - i) * 2]!;
      out[i * 2 + 1] = profile[(n - 1 - i) * 2 + 1]!;
    }
  }
  return out;
}

/**
 * Cumulative length fraction at each point of a profile (`n + 1` entries for a closed outline,
 * the last 1; `n` for an open one), so u and v follow arc length rather than point index.
 */
function lengthFractions(p: Float32Array, closed: boolean): Float32Array {
  const n = p.length >> 1;
  const out = new Float32Array(closed ? n + 1 : n);
  let acc = 0;
  const edges = closed ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % n;
    acc += Math.hypot(p[j * 2]! - p[i * 2]!, p[j * 2 + 1]! - p[i * 2 + 1]!);
    out[i + 1] = acc;
  }
  if (acc > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / acc;
  else for (let i = 0; i < out.length; i++) out[i] = i / Math.max(1, out.length - 1);
  return out;
}

/**
 * Smooth outward 2D normals, one per profile point: the normalised sum of the two adjacent edge
 * normals `(dy, -dx)` (one edge at the ends of an open profile).
 */
function vertexNormals2(p: Float32Array, closed: boolean): Float32Array {
  const n = p.length >> 1;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let nx = 0;
    let ny = 0;
    if (closed || i > 0) {
      const a = (i - 1 + n) % n;
      const dx = p[i * 2]! - p[a * 2]!;
      const dy = p[i * 2 + 1]! - p[a * 2 + 1]!;
      const l = Math.hypot(dx, dy) || 1;
      nx += dy / l;
      ny -= dx / l;
    }
    if (closed || i < n - 1) {
      const b = (i + 1) % n;
      const dx = p[b * 2]! - p[i * 2]!;
      const dy = p[b * 2 + 1]! - p[i * 2 + 1]!;
      const l = Math.hypot(dx, dy) || 1;
      nx += dy / l;
      ny -= dx / l;
    }
    const l = Math.hypot(nx, ny);
    out[i * 2] = l > 0 ? nx / l : 1;
    out[i * 2 + 1] = l > 0 ? ny / l : 0;
  }
  return out;
}

function bounds2(p: Float32Array): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i]!;
    const y = p[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX - minX || 1, maxY - minY || 1];
}

// ------------------------------------------------------------------ extrude

export interface ExtrudeOptions extends GeometryOptions {
  /** Extent along z, centred on the origin. Default 1. */
  depth?: number;
  /** Rows along the depth (≥ 1). Default 1. */
  segments?: number;
  /** Close both ends with triangulated caps. Default true. */
  caps?: boolean;
  /**
   * A 45° chamfer of this size between each cap and the sides: the caps are inset by it along
   * the outline's mitred normals and the sides shortened by it at each end. Default 0 (none);
   * needs `caps`. Keep it below half the depth and the outline's narrowest feature.
   */
  bevel?: number;
}

/**
 * A closed outline pushed along z from -depth/2 to +depth/2: flat side normals (two vertices per
 * outline point per row), ear-clipped caps facing ±z, an optional 45° bevel. Side u runs around
 * the outline by arc length (0 at the first point) and v along z (0 at the back); cap uvs span
 * the outline's box in 0..1 (the back cap mirrored in u).
 */
export function extrude(profile: Profile2D, opts: ExtrudeOptions = {}): Geometry {
  const p = ccwProfile(profile, 'extrude');
  const n = p.length >> 1;
  const depth = opts.depth ?? 1;
  const rows = Math.floor(opts.segments ?? 1);
  if (!(rows >= 1)) throw new Error(`geom: extrude segments must be at least 1, got ${rows}`);
  const caps = opts.caps ?? true;
  const bevel = caps ? Math.max(0, opts.bevel ?? 0) : 0;
  const capTris = caps ? triangulate(p) : null;
  const sideV = n * 2 * (rows + 1);
  const sideI = n * rows * 6;
  const capV = caps ? 2 * n : 0;
  const capI = capTris ? capTris.length * 2 : 0;
  const bevV = bevel > 0 ? 2 * n * 4 : 0;
  const bevI = bevel > 0 ? 2 * n * 6 : 0;
  const w = new GeometryWriter(sideV + capV + bevV, sideI + capI + bevI, opts);
  const z0 = -depth / 2 + bevel;
  const z1 = depth / 2 - bevel;
  const frac = lengthFractions(p, true);

  // Sides: one strip per edge, flat normal.
  for (let e = 0; e < n; e++) {
    const f = (e + 1) % n;
    const ax = p[e * 2]!;
    const ay = p[e * 2 + 1]!;
    const bx = p[f * 2]!;
    const by = p[f * 2 + 1]!;
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (by - ay) / l;
    const ny = -(bx - ax) / l;
    const base = w.count;
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const z = z0 + (z1 - z0) * t;
      w.vertex(ax, ay, z, nx, ny, 0, frac[e]!, t);
      w.vertex(bx, by, z, nx, ny, 0, frac[e + 1]!, t);
    }
    for (let j = 0; j < rows; j++) {
      const a = base + j * 2;
      w.quad(a, a + 1, a + 3, a + 2);
    }
  }

  if (caps && capTris) {
    // Inset outline for the caps (the outline itself without a bevel).
    const inset = new Float32Array(n * 2);
    if (bevel > 0) {
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n;
        const b = (i + 1) % n;
        const d0x = p[i * 2]! - p[a * 2]!;
        const d0y = p[i * 2 + 1]! - p[a * 2 + 1]!;
        const d1x = p[b * 2]! - p[i * 2]!;
        const d1y = p[b * 2 + 1]! - p[i * 2 + 1]!;
        const l0 = Math.hypot(d0x, d0y) || 1;
        const l1 = Math.hypot(d1x, d1y) || 1;
        const n0x = d0y / l0;
        const n0y = -d0x / l0;
        const n1x = d1y / l1;
        const n1y = -d1x / l1;
        // Mitre: (n0 + n1) / (1 + n0·n1) moves the offset edges by exactly `bevel`.
        const k = Math.max(0.2, 1 + n0x * n1x + n0y * n1y);
        inset[i * 2] = p[i * 2]! - (bevel * (n0x + n1x)) / k;
        inset[i * 2 + 1] = p[i * 2 + 1]! - (bevel * (n0y + n1y)) / k;
      }
    } else {
      inset.set(p);
    }
    const [minX, minY, sx, sy] = bounds2(p);
    const zf = depth / 2;
    const front = w.count;
    for (let i = 0; i < n; i++) {
      const x = inset[i * 2]!;
      const y = inset[i * 2 + 1]!;
      w.vertex(x, y, zf, 0, 0, 1, (x - minX) / sx, (y - minY) / sy);
    }
    const back = w.count;
    for (let i = 0; i < n; i++) {
      const x = inset[i * 2]!;
      const y = inset[i * 2 + 1]!;
      w.vertex(x, y, -zf, 0, 0, -1, 1 - (x - minX) / sx, (y - minY) / sy);
    }
    for (let t = 0; t < capTris.length; t += 3) {
      const a = capTris[t]!;
      const b = capTris[t + 1]!;
      const c = capTris[t + 2]!;
      w.tri(front + a, front + b, front + c);
      w.tri(back + a, back + c, back + b);
    }
    if (bevel > 0) {
      const s = Math.SQRT1_2;
      for (let e = 0; e < n; e++) {
        const f = (e + 1) % n;
        const ax = p[e * 2]!;
        const ay = p[e * 2 + 1]!;
        const bx = p[f * 2]!;
        const by = p[f * 2 + 1]!;
        const l = Math.hypot(bx - ax, by - ay) || 1;
        const nx = ((by - ay) / l) * s;
        const ny = (-(bx - ax) / l) * s;
        const u0 = frac[e]!;
        const u1 = frac[e + 1]!;
        // Front chamfer: side's front edge (z1) up to the inset cap edge (zf).
        let a = w.vertex(ax, ay, z1, nx, ny, s, u0, 0);
        w.vertex(bx, by, z1, nx, ny, s, u1, 0);
        w.vertex(inset[f * 2]!, inset[f * 2 + 1]!, zf, nx, ny, s, u1, 1);
        w.vertex(inset[e * 2]!, inset[e * 2 + 1]!, zf, nx, ny, s, u0, 1);
        w.quad(a, a + 1, a + 2, a + 3);
        // Back chamfer: traversed the other way so the winding faces out; v still runs along +z
        // (0 at the cap edge, 1 at the side) so the tangent frame stays right-handed.
        a = w.vertex(bx, by, z0, nx, ny, -s, u1, 1);
        w.vertex(ax, ay, z0, nx, ny, -s, u0, 1);
        w.vertex(inset[e * 2]!, inset[e * 2 + 1]!, -zf, nx, ny, -s, u0, 0);
        w.vertex(inset[f * 2]!, inset[f * 2 + 1]!, -zf, nx, ny, -s, u1, 0);
        w.quad(a, a + 1, a + 2, a + 3);
      }
    }
  }
  return w.finish();
}

// ------------------------------------------------------------------ lathe

export interface LatheOptions extends GeometryOptions {
  /** Steps around the axis (≥ 3). Default 24. */
  segments?: number;
  /** Angle swept, radians. Default 2π (closed ring); less leaves the ends open. */
  angle?: number;
}

/**
 * An open profile of (radius, y) points, ordered along the surface, revolved around +y: smooth
 * normals (adjacent edge normals averaged, outward for a profile traced bottom to top), u around
 * (0 at +z, as `cylinder`), v along the profile by arc length. A zero radius makes a pole.
 */
export function lathe(profile: Profile2D, opts: LatheOptions = {}): Geometry {
  const m = profile.length >> 1;
  if (m < 2) throw new Error(`geom: lathe needs a profile of at least 2 points, got ${m}`);
  const p = new Float32Array(m * 2);
  for (let i = 0; i < m * 2; i++) p[i] = profile[i]!;
  const cols = Math.floor(opts.segments ?? 24);
  if (!(cols >= 3)) throw new Error(`geom: lathe segments must be at least 3, got ${cols}`);
  const angle = opts.angle ?? TAU;
  const w = new GeometryWriter(m * (cols + 1), (m - 1) * cols * 6, opts);
  const nrm = vertexNormals2(p, false);
  const frac = lengthFractions(p, false);
  for (let j = 0; j < m; j++) {
    const r = p[j * 2]!;
    const y = p[j * 2 + 1]!;
    const nr = nrm[j * 2]!;
    const ny = nrm[j * 2 + 1]!;
    for (let i = 0; i <= cols; i++) {
      const phi = (i / cols) * angle;
      const s = Math.sin(phi);
      const c = Math.cos(phi);
      w.vertex(r * s, y, r * c, nr * s, ny, nr * c, i / cols, frac[j]!);
    }
  }
  for (let j = 0; j < m - 1; j++) {
    const a = j * (cols + 1);
    const b = a + cols + 1;
    for (let i = 0; i < cols; i++) w.quad(a + i, a + i + 1, b + i + 1, b + i);
  }
  return w.finish();
}

/**
 * Carry a frame normal from path point `q` to `o` (float offsets) by double reflection: across
 * the chord's bisector plane, then across the plane between the reflected and the new tangent.
 */
function carryNormal(
  path: ArrayLike<number>,
  T: Float64Array,
  q: number,
  o: number,
  rx: number,
  ry: number,
  rz: number,
): [number, number, number] {
  const v1x = path[o]! - path[q]!;
  const v1y = path[o + 1]! - path[q + 1]!;
  const v1z = path[o + 2]! - path[q + 2]!;
  const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
  let tlx = T[q]!;
  let tly = T[q + 1]!;
  let tlz = T[q + 2]!;
  if (c1 > 0) {
    const k = (2 / c1) * (v1x * rx + v1y * ry + v1z * rz);
    rx -= k * v1x;
    ry -= k * v1y;
    rz -= k * v1z;
    const kt = (2 / c1) * (v1x * tlx + v1y * tly + v1z * tlz);
    tlx -= kt * v1x;
    tly -= kt * v1y;
    tlz -= kt * v1z;
  }
  const v2x = T[o]! - tlx;
  const v2y = T[o + 1]! - tly;
  const v2z = T[o + 2]! - tlz;
  const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
  if (c2 > 0) {
    const k = (2 / c2) * (v2x * rx + v2y * ry + v2z * rz);
    rx -= k * v2x;
    ry -= k * v2y;
    rz -= k * v2z;
  }
  return [rx, ry, rz];
}

// ------------------------------------------------------------------ sweep

export interface SweepOptions extends GeometryOptions {
  /** The path loops: the last ring joins the first and no end is left open. Default false. */
  closed?: boolean;
  /**
   * How the profile's plane turns along the path: `'rmf'` (rotation-minimising frames by double
   * reflection, no twist, the default) or `'frenet'` (the curvature direction, which flips at
   * inflections and is undefined on straight runs, where the previous frame is kept).
   */
  frames?: 'frenet' | 'rmf';
}

/**
 * A closed outline carried along `path` (x, y, z triples, at least 2 points; the first and last
 * point of a closed path are distinct). Each path point gets a ring of the outline in its frame
 * (outline x along the frame's normal, y along its binormal), smooth normals across the outline,
 * u around the outline by arc length, v along the path by point index. A closed sweep spreads the
 * frame's end-to-start twist over the rings so the seam matches.
 */
export function sweep(
  profile: Profile2D,
  path: ArrayLike<number>,
  opts: SweepOptions = {},
): Geometry {
  const p = ccwProfile(profile, 'sweep');
  const n = p.length >> 1;
  const m = path.length / 3;
  if (!(m >= 2) || m !== Math.floor(m)) {
    throw new Error(`geom: sweep needs a path of at least 2 xyz points, got ${path.length} floats`);
  }
  const closed = opts.closed ?? false;
  const frenet = opts.frames === 'frenet';
  const rings = m;
  const spans = closed ? m : m - 1;
  const w = new GeometryWriter(rings * (n + 1), spans * n * 6, opts);
  const nrm = vertexNormals2(p, true);
  const frac = lengthFractions(p, true);

  // Tangents, central differences (wrapping when closed).
  const T = new Float64Array(m * 3);
  for (let j = 0; j < m; j++) {
    let a = j - 1;
    let b = j + 1;
    if (closed) {
      a = (a + m) % m;
      b %= m;
    } else {
      if (a < 0) a = 0;
      if (b >= m) b = m - 1;
    }
    let tx = path[b * 3]! - path[a * 3]!;
    let ty = path[b * 3 + 1]! - path[a * 3 + 1]!;
    let tz = path[b * 3 + 2]! - path[a * 3 + 2]!;
    const l = Math.hypot(tx, ty, tz);
    if (l > 0) {
      tx /= l;
      ty /= l;
      tz /= l;
    } else if (j > 0) {
      tx = T[(j - 1) * 3]!;
      ty = T[(j - 1) * 3 + 1]!;
      tz = T[(j - 1) * 3 + 2]!;
    } else {
      tz = 1;
    }
    T[j * 3] = tx;
    T[j * 3 + 1] = ty;
    T[j * 3 + 2] = tz;
  }

  // Normals N (perpendicular to T) per ring; B = T × N.
  const N = new Float64Array(m * 3);
  // Start: the world axis least aligned with T0, made perpendicular.
  {
    const tx = T[0]!;
    const ty = T[1]!;
    const tz = T[2]!;
    const ax = Math.abs(tx);
    const ay = Math.abs(ty);
    const az = Math.abs(tz);
    let ux = 0;
    let uy = 0;
    let uz = 0;
    if (ay <= ax && ay <= az) uy = 1;
    else if (ax <= az) ux = 1;
    else uz = 1;
    const d = ux * tx + uy * ty + uz * tz;
    ux -= d * tx;
    uy -= d * ty;
    uz -= d * tz;
    const l = Math.hypot(ux, uy, uz);
    N[0] = ux / l;
    N[1] = uy / l;
    N[2] = uz / l;
  }
  for (let j = 1; j < m; j++) {
    const o = j * 3;
    const q = o - 3;
    if (frenet) {
      // Curvature direction: the change in tangent, perpendicular to T.
      const a = closed ? ((j - 1 + m) % m) * 3 : Math.max(0, j - 1) * 3;
      const b = closed ? ((j + 1) % m) * 3 : Math.min(m - 1, j + 1) * 3;
      let kx = T[b]! - T[a]!;
      let ky = T[b + 1]! - T[a + 1]!;
      let kz = T[b + 2]! - T[a + 2]!;
      const d = kx * T[o]! + ky * T[o + 1]! + kz * T[o + 2]!;
      kx -= d * T[o]!;
      ky -= d * T[o + 1]!;
      kz -= d * T[o + 2]!;
      const l = Math.hypot(kx, ky, kz);
      if (l > 1e-9) {
        N[o] = kx / l;
        N[o + 1] = ky / l;
        N[o + 2] = kz / l;
        continue;
      }
    }
    // Double reflection: the previous normal carried across the chord (see `carryNormal`).
    const [rx0, ry0, rz0] = carryNormal(path, T, q, o, N[q]!, N[q + 1]!, N[q + 2]!);
    let rx = rx0;
    let ry = ry0;
    let rz = rz0;
    // Re-orthogonalise against T to stop drift.
    const d = rx * T[o]! + ry * T[o + 1]! + rz * T[o + 2]!;
    rx -= d * T[o]!;
    ry -= d * T[o + 1]!;
    rz -= d * T[o + 2]!;
    const l = Math.hypot(rx, ry, rz) || 1;
    N[o] = rx / l;
    N[o + 1] = ry / l;
    N[o + 2] = rz / l;
  }

  // Closed: the frame carried once more around to ring 0 differs from N0 by a twist; spread the
  // correction over the rings so ring m-1 meets ring 0 without a step.
  let twist = 0;
  if (closed && !frenet) {
    const q = (m - 1) * 3;
    const [rx, ry, rz] = carryNormal(path, T, q, 0, N[q]!, N[q + 1]!, N[q + 2]!);
    // Angle from the carried normal to N0 about T0.
    const bx = T[1]! * N[2]! - T[2]! * N[1]!;
    const by = T[2]! * N[0]! - T[0]! * N[2]!;
    const bz = T[0]! * N[1]! - T[1]! * N[0]!;
    const cosA = rx * N[0]! + ry * N[1]! + rz * N[2]!;
    const sinA = rx * bx + ry * by + rz * bz;
    twist = Math.atan2(sinA, cosA);
  }

  for (let j = 0; j < rings; j++) {
    const o = j * 3;
    const tx = T[o]!;
    const ty = T[o + 1]!;
    const tz = T[o + 2]!;
    let nx = N[o]!;
    let ny = N[o + 1]!;
    let nz = N[o + 2]!;
    let bx = ty * nz - tz * ny;
    let by = tz * nx - tx * nz;
    let bz = tx * ny - ty * nx;
    if (twist !== 0) {
      // Rotate N, B about T by the share of the twist this ring takes.
      const a = (twist * j) / m;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rnx = nx * ca + bx * sa;
      const rny = ny * ca + by * sa;
      const rnz = nz * ca + bz * sa;
      bx = bx * ca - nx * sa;
      by = by * ca - ny * sa;
      bz = bz * ca - nz * sa;
      nx = rnx;
      ny = rny;
      nz = rnz;
    }
    const px = path[o]!;
    const py = path[o + 1]!;
    const pz = path[o + 2]!;
    const v = j / spans;
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const x2 = p[k * 2]!;
      const y2 = p[k * 2 + 1]!;
      const nx2 = nrm[k * 2]!;
      const ny2 = nrm[k * 2 + 1]!;
      w.vertex(
        px + nx * x2 + bx * y2,
        py + ny * x2 + by * y2,
        pz + nz * x2 + bz * y2,
        nx * nx2 + bx * ny2,
        ny * nx2 + by * ny2,
        nz * nx2 + bz * ny2,
        frac[i]!,
        v,
      );
    }
  }
  for (let j = 0; j < spans; j++) {
    const a = j * (n + 1);
    const b = ((j + 1) % rings) * (n + 1);
    for (let i = 0; i < n; i++) w.quad(a + i, a + i + 1, b + i + 1, b + i);
  }
  return w.finish();
}

// ------------------------------------------------------------------ tube

export interface TubeOptions extends SweepOptions {
  /** Radius of the circular section. Default 0.1. */
  radius?: number;
  /** Points around the section (≥ 3). Default 12. */
  segments?: number;
}

/** `sweep` of a circle: a round tube along `path` (`SweepOptions` apply). */
export function tube(path: ArrayLike<number>, opts: TubeOptions = {}): Geometry {
  const r = opts.radius ?? 0.1;
  const k = Math.floor(opts.segments ?? 12);
  if (!(k >= 3)) throw new Error(`geom: tube segments must be at least 3, got ${k}`);
  const circle = new Float32Array(k * 2);
  for (let i = 0; i < k; i++) {
    const a = (i / k) * TAU;
    circle[i * 2] = r * Math.cos(a);
    circle[i * 2 + 1] = r * Math.sin(a);
  }
  return sweep(circle, path, opts);
}

// ------------------------------------------------------------------ polygon

export interface PolygonOptions extends GeometryOptions {
  /** Height of the plane. Default 0. */
  y?: number;
  /** Also draw the underside (its own vertices, facing -y). Default false. */
  doubleSided?: boolean;
}

/**
 * A flat outline in the xz plane facing +y: outline x → x, outline y → -z (so a counter-clockwise
 * outline stays counter-clockwise seen from above), ear-clipped, uv the outline's box in 0..1.
 */
export function polygon(points: Profile2D, opts: PolygonOptions = {}): Geometry {
  const p = ccwProfile(points, 'polygon');
  const n = p.length >> 1;
  const tris = triangulate(p);
  const two = opts.doubleSided ?? false;
  const y = opts.y ?? 0;
  const w = new GeometryWriter(two ? n * 2 : n, two ? tris.length * 2 : tris.length, opts);
  const [minX, minY, sx, sy] = bounds2(p);
  for (let i = 0; i < n; i++) {
    const x = p[i * 2]!;
    const z = p[i * 2 + 1]!;
    w.vertex(x, y, -z, 0, 1, 0, (x - minX) / sx, (z - minY) / sy);
  }
  if (two) {
    for (let i = 0; i < n; i++) {
      const x = p[i * 2]!;
      const z = p[i * 2 + 1]!;
      w.vertex(x, y, -z, 0, -1, 0, 1 - (x - minX) / sx, (z - minY) / sy);
    }
  }
  for (let t = 0; t < tris.length; t += 3) {
    w.tri(tris[t]!, tris[t + 1]!, tris[t + 2]!);
  }
  if (two) {
    for (let t = 0; t < tris.length; t += 3) {
      w.tri(n + tris[t]!, n + tris[t + 2]!, n + tris[t + 1]!);
    }
  }
  return w.finish();
}
