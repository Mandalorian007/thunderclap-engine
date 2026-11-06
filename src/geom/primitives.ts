/**
 * Primitive builders, all in `VERTEX_LAYOUT_3D`, centred on the origin, y up, with outward
 * normals and counter-clockwise triangles seen from outside. Each takes `{ color?, uvScale? }`
 * (`GeometryOptions`) plus its own sizes and segment counts; every size defaults to a unit
 * extent, so a `Transform`'s scale is the object's size in world units.
 *
 * Normals: `box`, `plane` and cylinder caps are flat (a vertex per face corner); `sphere`,
 * `icosphere`, `capsule`, `torus` and cylinder sides are smooth (the analytic surface normal).
 */
import { type Geometry, type GeometryOptions, GeometryWriter } from './geometry';

const TAU = Math.PI * 2;

type Vec3Opt = number | [number, number, number];
type Vec2Opt = number | [number, number];

function v3(v: Vec3Opt | undefined, d: number): [number, number, number] {
  if (v === undefined) return [d, d, d];
  return typeof v === 'number' ? [v, v, v] : [v[0], v[1], v[2]];
}
function v2(v: Vec2Opt | undefined, d0: number, d1: number): [number, number] {
  if (v === undefined) return [d0, d1];
  return typeof v === 'number' ? [v, v] : [v[0], v[1]];
}
function atLeast(name: string, value: number, min: number): number {
  const n = Math.floor(value);
  if (!(n >= min)) throw new Error(`geom: ${name} segments must be at least ${min}, got ${value}`);
  return n;
}

/**
 * Stitch two rings of `cols + 1` vertices (indices `a + i` and `b + i`, `b` the later ring along
 * the surface) with quads, or triangles where one ring is a pole (every vertex at one point).
 * The rings are ordered so that a vertex moves along the ring with `i` and across it from `a`
 * to `b` in a right-handed sense with the outward normal.
 */
function stitch(
  w: GeometryWriter,
  cols: number,
  a: number,
  b: number,
  poleA = false,
  poleB = false,
) {
  for (let i = 0; i < cols; i++) {
    if (poleA) w.tri(a + i, b + i + 1, b + i);
    else if (poleB) w.tri(a + i, a + i + 1, b + i + 1);
    else w.quad(a + i, a + i + 1, b + i + 1, b + i);
  }
}

// ------------------------------------------------------------------ box

export interface BoxOptions extends GeometryOptions {
  /** Extent on each axis (one number for a cube). Default 1. */
  size?: Vec3Opt;
  /** Subdivisions per axis (x, y, z). Default 1: 24 vertices, 12 triangles. */
  segments?: Vec3Opt;
}

/** Face table: normal axis and sign, then the axes that run right and up across the face. */
// biome-ignore format: table
const BOX_FACES: [number, number, number, number, number, number][] = [
  // nAxis, nSign, rAxis, rSign, uAxis, uSign   (r × u = n)
  [2,  1, 0,  1, 1,  1], // +z
  [2, -1, 0, -1, 1,  1], // -z
  [0,  1, 2, -1, 1,  1], // +x
  [0, -1, 2,  1, 1,  1], // -x
  [1,  1, 0,  1, 2, -1], // +y
  [1, -1, 0,  1, 2,  1], // -y
];

/** An axis-aligned box centred on the origin, flat normals, each face uv 0..1 (v = 0 at the top). */
export function box(opts: BoxOptions = {}): Geometry {
  const size = v3(opts.size, 1);
  const seg = v3(opts.segments, 1).map((n, k) => atLeast('xyz'[k]!, n, 1)) as [
    number,
    number,
    number,
  ];
  let vCount = 0;
  let iCount = 0;
  for (const f of BOX_FACES) {
    const sr = seg[f[2]]!;
    const su = seg[f[4]]!;
    vCount += (sr + 1) * (su + 1);
    iCount += sr * su * 6;
  }
  const w = new GeometryWriter(vCount, iCount, opts);
  const p = [0, 0, 0];
  for (const [nAxis, nSign, rAxis, rSign, uAxis, uSign] of BOX_FACES) {
    const sr = seg[rAxis]!;
    const su = seg[uAxis]!;
    const base = w.count;
    for (let j = 0; j <= su; j++) {
      for (let i = 0; i <= sr; i++) {
        p[nAxis] = nSign * 0.5 * size[nAxis]!;
        p[rAxis] = rSign * (i / sr - 0.5) * size[rAxis]!;
        p[uAxis] = uSign * (j / su - 0.5) * size[uAxis]!;
        const nx = nAxis === 0 ? nSign : 0;
        const ny = nAxis === 1 ? nSign : 0;
        const nz = nAxis === 2 ? nSign : 0;
        w.vertex(p[0]!, p[1]!, p[2]!, nx, ny, nz, i / sr, 1 - j / su);
      }
    }
    for (let j = 0; j < su; j++) {
      const row = base + j * (sr + 1);
      stitch(w, sr, row, row + sr + 1);
    }
  }
  return w.finish();
}

// ------------------------------------------------------------------ plane

export interface PlaneOptions extends GeometryOptions {
  /** Extent along x and z (one number for a square). Default 1. */
  size?: Vec2Opt;
  /** Subdivisions along x and z. Default 1. */
  segments?: Vec2Opt;
}

/**
 * A flat grid in the xz plane at y = 0 facing +y, centred on the origin; u runs along +x and
 * v along +z, 0..1 across the plane.
 */
export function plane(opts: PlaneOptions = {}): Geometry {
  const [sx, sz] = v2(opts.size, 1, 1);
  const [nx, nz] = v2(opts.segments, 1, 1);
  const cx = atLeast('x', nx, 1);
  const cz = atLeast('z', nz, 1);
  const w = new GeometryWriter((cx + 1) * (cz + 1), cx * cz * 6, opts);
  for (let j = 0; j <= cz; j++) {
    for (let i = 0; i <= cx; i++) {
      w.vertex((i / cx - 0.5) * sx, 0, (j / cz - 0.5) * sz, 0, 1, 0, i / cx, j / cz);
    }
  }
  for (let j = 0; j < cz; j++) {
    for (let i = 0; i < cx; i++) {
      const a = j * (cx + 1) + i;
      // (i, j) → (i, j+1) → (i+1, j+1) → (i+1, j): +z then +x, so the normal comes out +y.
      w.quad(a, a + cx + 1, a + cx + 2, a + 1);
    }
  }
  return w.finish();
}

// ------------------------------------------------------------------ sphere (UV)

export interface SphereOptions extends GeometryOptions {
  /** Default 0.5 (a unit diameter). */
  radius?: number;
  /** Segments around (≥ 3) and from pole to pole (≥ 2). Default `[32, 16]`. */
  segments?: Vec2Opt;
}

/**
 * A UV sphere: rings of latitude from the bottom pole to the top, smooth normals, u around
 * (0 at +z, increasing towards +x), v = 0 at the top pole and 1 at the bottom.
 */
export function sphere(opts: SphereOptions = {}): Geometry {
  const r = opts.radius ?? 0.5;
  const [ws, hs] = v2(opts.segments, 32, 16);
  const cols = atLeast('width', ws, 3);
  const rows = atLeast('height', hs, 2);
  const w = new GeometryWriter((cols + 1) * (rows + 1), cols * (rows - 1) * 6, opts);
  for (let j = 0; j <= rows; j++) {
    const lat = -Math.PI / 2 + (j / rows) * Math.PI;
    const cl = j === 0 || j === rows ? 0 : Math.cos(lat);
    const sl = Math.sin(lat);
    for (let i = 0; i <= cols; i++) {
      const phi = (i / cols) * TAU;
      const nx = cl * Math.sin(phi);
      const nz = cl * Math.cos(phi);
      w.vertex(r * nx, r * sl, r * nz, nx, sl, nz, i / cols, 1 - j / rows);
    }
  }
  for (let j = 0; j < rows; j++) {
    const a = j * (cols + 1);
    stitch(w, cols, a, a + cols + 1, j === 0, j === rows - 1);
  }
  return w.finish();
}

// ------------------------------------------------------------------ icosphere

export interface IcosphereOptions extends GeometryOptions {
  /** Default 0.5. */
  radius?: number;
  /** Subdivision passes (each splits every triangle in four). Default 2: 162 vertices, 320 triangles. */
  subdivisions?: number;
}

const ICO_T = (1 + Math.sqrt(5)) / 2;
// biome-ignore format: table
const ICO_VERTS = [
  -1,  ICO_T, 0,   1,  ICO_T, 0,   -1, -ICO_T, 0,   1, -ICO_T, 0,
   0, -1,  ICO_T,  0,  1,  ICO_T,   0, -1, -ICO_T,  0,  1, -ICO_T,
   ICO_T, 0, -1,   ICO_T, 0,  1,   -ICO_T, 0, -1,  -ICO_T, 0,  1,
];
// biome-ignore format: table
const ICO_TRIS = [
  0, 11, 5,   0, 5, 1,   0, 1, 7,    0, 7, 10,   0, 10, 11,
  1, 5, 9,    5, 11, 4,  11, 10, 2,  10, 7, 6,   7, 1, 8,
  3, 9, 4,    3, 4, 2,   3, 2, 6,    3, 6, 8,    3, 8, 9,
  4, 9, 5,    2, 4, 11,  6, 2, 10,   8, 6, 7,    9, 8, 1,
];

/**
 * A sphere from a subdivided icosahedron: evenly sized triangles, welded vertices, smooth
 * normals. uv is the spherical mapping of the normal (u = atan2 around y, v from the top), with
 * a seam at -x; prefer `sphere` when the texture matters.
 */
export function icosphere(opts: IcosphereOptions = {}): Geometry {
  const r = opts.radius ?? 0.5;
  const n = atLeast('subdivision', opts.subdivisions ?? 2, 0);
  const pow = 4 ** n;
  const vCount = 10 * pow + 2;
  const tCount = 20 * pow;
  // Unit positions, welded through a midpoint cache keyed by the edge's vertex pair.
  const pos = new Float64Array(vCount * 3);
  let pc = 0;
  for (let i = 0; i < ICO_VERTS.length; i += 3) {
    const l = Math.hypot(ICO_VERTS[i]!, ICO_VERTS[i + 1]!, ICO_VERTS[i + 2]!);
    pos[pc++] = ICO_VERTS[i]! / l;
    pos[pc++] = ICO_VERTS[i + 1]! / l;
    pos[pc++] = ICO_VERTS[i + 2]! / l;
  }
  let tris = Uint32Array.from(ICO_TRIS);
  const cache = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * vCount + b : b * vCount + a;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let x = pos[a * 3]! + pos[b * 3]!;
    let y = pos[a * 3 + 1]! + pos[b * 3 + 1]!;
    let z = pos[a * 3 + 2]! + pos[b * 3 + 2]!;
    const l = Math.hypot(x, y, z);
    x /= l;
    y /= l;
    z /= l;
    const idx = pc / 3;
    pos[pc++] = x;
    pos[pc++] = y;
    pos[pc++] = z;
    cache.set(key, idx);
    return idx;
  };
  for (let s = 0; s < n; s++) {
    const next = new Uint32Array(tris.length * 4);
    let o = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!;
      const b = tris[t + 1]!;
      const c = tris[t + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], o);
      o += 12;
    }
    tris = next;
  }
  const w = new GeometryWriter(vCount, tCount * 3, opts);
  for (let i = 0; i < vCount; i++) {
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    const u = 0.5 + Math.atan2(z, x) / TAU;
    const v = Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI;
    w.vertex(r * x, r * y, r * z, x, y, z, u, v);
  }
  for (let t = 0; t < tris.length; t += 3) w.tri(tris[t]!, tris[t + 1]!, tris[t + 2]!);
  return w.finish();
}

// ------------------------------------------------------------------ capsule

export interface CapsuleOptions extends GeometryOptions {
  /** Default 0.25. */
  radius?: number;
  /** Total height, caps included, along y; at most `2 × radius` gives a sphere. Default 1. */
  height?: number;
  /** Segments around (≥ 3) and rings per hemisphere (≥ 1). Default `[16, 8]`. */
  segments?: Vec2Opt;
}

/**
 * A capsule along y centred on the origin: two hemispheres joined by a cylinder, smooth normals,
 * u around (0 at +z), v = 0 at the top and 1 at the bottom.
 */
export function capsule(opts: CapsuleOptions = {}): Geometry {
  const r = opts.radius ?? 0.25;
  const height = opts.height ?? 1;
  const half = Math.max(0, height / 2 - r);
  const [rs, cs] = v2(opts.segments, 16, 8);
  const cols = atLeast('radial', rs, 3);
  const rings = atLeast('ring', cs, 1);
  const rowCount = 2 * (rings + 1);
  const total = 2 * (half + r);
  const w = new GeometryWriter((cols + 1) * rowCount, cols * (3 + 3 + (rowCount - 3) * 6), opts);
  for (let row = 0; row < rowCount; row++) {
    // Rows 0..rings: the bottom hemisphere (latitude -90°..0°); rings+1..: the top (0°..90°).
    const top = row > rings;
    const k = top ? row - rings - 1 : row;
    const lat = top ? (k / rings) * (Math.PI / 2) : -Math.PI / 2 + (k / rings) * (Math.PI / 2);
    const pole = row === 0 || row === rowCount - 1;
    const cl = pole ? 0 : Math.cos(lat);
    const sl = Math.sin(lat);
    const y0 = top ? half : -half;
    for (let i = 0; i <= cols; i++) {
      const phi = (i / cols) * TAU;
      const nx = cl * Math.sin(phi);
      const nz = cl * Math.cos(phi);
      const y = y0 + r * sl;
      w.vertex(r * nx, y, r * nz, nx, sl, nz, i / cols, 0.5 - y / total);
    }
  }
  for (let row = 0; row < rowCount - 1; row++) {
    const a = row * (cols + 1);
    stitch(w, cols, a, a + cols + 1, row === 0, row === rowCount - 2);
  }
  return w.finish();
}

// ------------------------------------------------------------------ cylinder

export interface CylinderOptions extends GeometryOptions {
  /** Radius, or `[top, bottom]` for a taper (0 at one end makes a cone). Default 0.5. */
  radius?: Vec2Opt;
  /** Height along y. Default 1. */
  height?: number;
  /** Segments around (≥ 3) and along the height (≥ 1). Default `[24, 1]`. */
  segments?: Vec2Opt;
  /** Close the ends with flat discs. Default true. */
  caps?: boolean;
}

/**
 * A cylinder (or cone, or truncated cone) along y centred on the origin. The side has smooth
 * normals that lean with the taper, u around (0 at +z) and v = 0 at the top; each cap is a flat
 * disc with its own vertices, uv the disc in 0..1.
 */
export function cylinder(opts: CylinderOptions = {}): Geometry {
  const [rt, rb] = v2(opts.radius, 0.5, 0.5);
  const height = opts.height ?? 1;
  const [rs, hs] = v2(opts.segments, 24, 1);
  const cols = atLeast('radial', rs, 3);
  const rows = atLeast('height', hs, 1);
  const caps = opts.caps ?? true;
  const capTop = caps && rt > 0;
  const capBottom = caps && rb > 0;
  const poleTop = rt === 0;
  const poleBottom = rb === 0;
  let iCount = cols * rows * 6;
  if (poleTop) iCount -= cols * 3;
  if (poleBottom) iCount -= cols * 3;
  const capV = (capTop ? 1 : 0) + (capBottom ? 1 : 0);
  const w = new GeometryWriter(
    (cols + 1) * (rows + 1) + capV * (cols + 2),
    iCount + capV * cols * 3,
    opts,
  );
  // Side normal: perpendicular to the slanted side, (1, slope, 1) scaled, then unit.
  const slope = (rb - rt) / height;
  const nl = Math.hypot(1, slope);
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const y = (t - 0.5) * height;
    const rad = rb + (rt - rb) * t;
    for (let i = 0; i <= cols; i++) {
      const phi = (i / cols) * TAU;
      const sx = Math.sin(phi);
      const cz = Math.cos(phi);
      w.vertex(rad * sx, y, rad * cz, sx / nl, slope / nl, cz / nl, i / cols, 1 - t);
    }
  }
  for (let j = 0; j < rows; j++) {
    const a = j * (cols + 1);
    stitch(w, cols, a, a + cols + 1, poleBottom && j === 0, poleTop && j === rows - 1);
  }
  if (capTop) disc(w, cols, rt, height / 2, 1);
  if (capBottom) disc(w, cols, rb, -height / 2, -1);
  return w.finish();
}

/** A flat disc of `cols` triangles at height `y`, facing `ny` (±1). */
function disc(w: GeometryWriter, cols: number, radius: number, y: number, ny: number): void {
  const centre = w.vertex(0, y, 0, 0, ny, 0, 0.5, 0.5);
  const ring = w.count;
  for (let i = 0; i <= cols; i++) {
    const phi = (i / cols) * TAU;
    const sx = Math.sin(phi);
    const cz = Math.cos(phi);
    w.vertex(radius * sx, y, radius * cz, 0, ny, 0, 0.5 + 0.5 * sx, 0.5 - 0.5 * cz * ny);
  }
  for (let i = 0; i < cols; i++) {
    if (ny > 0) w.tri(centre, ring + i, ring + i + 1);
    else w.tri(centre, ring + i + 1, ring + i);
  }
}

// ------------------------------------------------------------------ torus

export interface TorusOptions extends GeometryOptions {
  /** Distance from the centre to the middle of the tube. Default 0.5. */
  radius?: number;
  /** Radius of the tube. Default 0.2. */
  tube?: number;
  /** Segments around the tube's section (≥ 3) and around the ring (≥ 3). Default `[12, 24]`. */
  segments?: Vec2Opt;
}

/**
 * A torus in the xz plane around y, centred on the origin, smooth normals; u runs around the
 * ring, v around the tube's section.
 */
export function torus(opts: TorusOptions = {}): Geometry {
  const R = opts.radius ?? 0.5;
  const r = opts.tube ?? 0.2;
  const [rs, ts] = v2(opts.segments, 12, 24);
  const radial = atLeast('radial', rs, 3);
  const tubular = atLeast('tubular', ts, 3);
  const w = new GeometryWriter((tubular + 1) * (radial + 1), tubular * radial * 6, opts);
  for (let i = 0; i <= tubular; i++) {
    const phi = (i / tubular) * TAU;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    for (let j = 0; j <= radial; j++) {
      const theta = (j / radial) * TAU;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const nx = ct * cp;
      const ny = st;
      const nz = ct * sp;
      w.vertex(R * cp + r * nx, r * ny, R * sp + r * nz, nx, ny, nz, i / tubular, j / radial);
    }
  }
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      // (i, j) → (i, j+1) → (i+1, j+1) → (i+1, j): around the section, then around the ring.
      w.quad(a, a + 1, a + radial + 2, a + radial + 1);
    }
  }
  return w.finish();
}
