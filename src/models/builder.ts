/**
 * A triangle soup with a transform stack: the part shapes, written as flat-shaded (or, for
 * round sides, smooth) triangles in the packed model vertex layout. Generalized from Forge
 * Wilds' block-model builder (FW:render/models.ts) with its material codes made the game's.
 */

/** Floats per packed model vertex: position xyz, material; normal xyz, shade; rgb, colour mode. */
export const MODEL_VERTEX_FLOATS = 12;

/**
 * How a vertex is coloured (its last float): its material's colour, its own rgb, the
 * instance's colour or the instance's second colour.
 */
export const COLOR_MODE = { MATERIAL: 0, RGB: 1, INSTANCE: 2, INSTANCE2: 3 } as const;

export type V3 = [number, number, number];
/** 0 x, 1 y, 2 z. */
export type AxisIndex = 0 | 1 | 2;
type Mat3 = [number, number, number, number, number, number, number, number, number];

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
    }
  }
  return r as Mat3;
}

/** The rotation matrix of `angle` radians about a model axis (right-handed). */
export function axisRotation(axis: AxisIndex, a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === 0) return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 1) return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function apply(m: Mat3, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Faces looking down are a little darker: a cheap stand-in for occlusion. */
const DOWN_SHADE = 0.72;

/**
 * Builds triangles under a transform stack. `color` (rgb + `COLOR_MODE`) applies to what is
 * drawn next. Counter-clockwise triangles seen from outside face outward.
 */
export class ModelBuilder {
  private out: number[] = [];
  private m: Mat3 = IDENTITY;
  private o: V3 = [0, 0, 0];
  /** The colour of what is drawn next: r, g, b, `COLOR_MODE`. */
  color: [number, number, number, number] = [0, 0, 0, COLOR_MODE.MATERIAL];

  /** Runs `body` with everything rotated by `angle` about `axis` through `pivot`. */
  rotated(axis: AxisIndex, angle: number, pivot: V3, body: () => void): void {
    const m0 = this.m;
    const o0 = this.o;
    // p' = M0 (R (p - pivot) + pivot) + o0
    const r = axisRotation(axis, angle);
    this.m = mul(m0, r);
    const shift = apply(r, [-pivot[0], -pivot[1], -pivot[2]]);
    const t = apply(m0, [shift[0] + pivot[0], shift[1] + pivot[1], shift[2] + pivot[2]]);
    this.o = [t[0] + o0[0], t[1] + o0[1], t[2] + o0[2]];
    body();
    this.m = m0;
    this.o = o0;
  }

  /** Runs `body` with everything moved by `d`. */
  moved(d: V3, body: () => void): void {
    const o0 = this.o;
    const t = apply(this.m, d);
    this.o = [o0[0] + t[0], o0[1] + t[1], o0[2] + t[2]];
    body();
    this.o = o0;
  }

  private vertex(p: V3, n: V3, mat: number, shade: number): void {
    const q = apply(this.m, p);
    const k = apply(this.m, n);
    const c = this.color;
    this.out.push(
      q[0] + this.o[0],
      q[1] + this.o[1],
      q[2] + this.o[2],
      mat,
      k[0],
      k[1],
      k[2],
      shade * (k[1] < -0.5 ? DOWN_SHADE : 1),
      c[0],
      c[1],
      c[2],
      c[3],
    );
  }

  /** A triangle with its own flat normal (counter-clockwise from outside), or the given ones. */
  tri(a: V3, b: V3, c: V3, mat: number, shade = 1, normals?: readonly [V3, V3, V3]): void {
    let n0: V3;
    let n1: V3;
    let n2: V3;
    if (normals) {
      [n0, n1, n2] = normals;
    } else {
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      const x = uy * vz - uz * vy;
      const y = uz * vx - ux * vz;
      const z = ux * vy - uy * vx;
      const l = Math.hypot(x, y, z) || 1;
      n0 = n1 = n2 = [x / l, y / l, z / l];
    }
    this.vertex(a, n0, mat, shade);
    this.vertex(b, n1, mat, shade);
    this.vertex(c, n2, mat, shade);
  }

  quad(a: V3, b: V3, c: V3, d: V3, mat: number, shade = 1): void {
    this.tri(a, b, c, mat, shade);
    this.tri(a, c, d, mat, shade);
  }

  box(min: V3, max: V3, mat: number, shade = 1): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], mat, shade); // -x
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], mat, shade); // +x
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], mat, shade); // -y
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], mat, shade); // +y
    this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], mat, shade); // -z
    this.quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], mat, shade); // +z
  }

  /**
   * An extruded closed outline about `center` along `axis`: `radii` gives the radius per
   * evenly spaced angle (star-shaped, so the caps fan from the centre).
   */
  extrude(
    center: V3,
    axis: AxisIndex,
    radii: readonly number[],
    halfLength: number,
    mat: number,
    opts: { phase?: number; smooth?: boolean; capMat?: number; shade?: number } = {},
  ): void {
    const n = radii.length;
    const phase = opts.phase ?? 0;
    const shade = opts.shade ?? 1;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const at = (r: number, ang: number, w: number): V3 => {
      const p: V3 = [center[0], center[1], center[2]];
      p[u] += r * Math.cos(ang);
      p[v] += r * Math.sin(ang);
      p[axis] += w;
      return p;
    };
    const dir = (ang: number): V3 => {
      const p: V3 = [0, 0, 0];
      p[u] = Math.cos(ang);
      p[v] = Math.sin(ang);
      return p;
    };
    const ax: V3 = [0, 0, 0];
    ax[axis] = 1;
    const nax: V3 = [-ax[0], -ax[1], -ax[2]];
    const top: V3 = [center[0], center[1], center[2]];
    top[axis] += halfLength;
    const bot: V3 = [center[0], center[1], center[2]];
    bot[axis] -= halfLength;
    const capMat = opts.capMat ?? mat;
    for (let i = 0; i < n; i++) {
      const a0 = phase + (i / n) * 2 * Math.PI;
      const a1 = phase + ((i + 1) / n) * 2 * Math.PI;
      const r0 = radii[i]!;
      const r1 = radii[(i + 1) % n]!;
      const p0 = at(r0, a0, -halfLength);
      const p1 = at(r1, a1, -halfLength);
      const q0 = at(r0, a0, halfLength);
      const q1 = at(r1, a1, halfLength);
      if (opts.smooth) {
        const n0 = dir(a0);
        const n1 = dir(a1);
        this.tri(p0, p1, q1, mat, shade, [n0, n1, n1]);
        this.tri(p0, q1, q0, mat, shade, [n0, n1, n0]);
      } else {
        this.quad(p0, p1, q1, q0, mat, shade);
      }
      // Caps: u × v = axis, so (top, q0, q1) faces +axis.
      this.tri(top, q0, q1, capMat, shade, [ax, ax, ax]);
      this.tri(bot, p1, p0, capMat, shade, [nax, nax, nax]);
    }
  }

  cylinder(
    center: V3,
    axis: AxisIndex,
    radius: number,
    halfLength: number,
    sides: number,
    mat: number,
    capMat?: number,
    shade = 1,
  ): void {
    this.extrude(center, axis, new Array<number>(sides).fill(radius), halfLength, mat, {
      smooth: sides > 6,
      phase: Math.PI / sides,
      shade,
      ...(capMat !== undefined ? { capMat } : {}),
    });
  }

  /** A toothed wheel: `teeth` teeth between `root` and `outer` radius. */
  gear(
    center: V3,
    axis: AxisIndex,
    outer: number,
    root: number,
    teeth: number,
    halfLength: number,
    mat: number,
    shade = 1,
  ): void {
    const radii: number[] = [];
    for (let t = 0; t < teeth; t++) radii.push(root, outer, outer, root);
    this.extrude(center, axis, radii, halfLength, mat, { shade });
  }

  /** An annulus between `inner` and `outer`, `sides` segments. */
  ring(
    center: V3,
    axis: AxisIndex,
    inner: number,
    outer: number,
    halfLength: number,
    sides: number,
    mat: number,
    shade = 1,
  ): void {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const at = (r: number, ang: number, w: number): V3 => {
      const p: V3 = [center[0], center[1], center[2]];
      p[u] += r * Math.cos(ang);
      p[v] += r * Math.sin(ang);
      p[axis] += w;
      return p;
    };
    const h = halfLength;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * 2 * Math.PI;
      const a1 = ((i + 1) / sides) * 2 * Math.PI;
      this.quad(
        at(outer, a0, -h),
        at(outer, a1, -h),
        at(outer, a1, h),
        at(outer, a0, h),
        mat,
        shade,
      );
      this.quad(
        at(inner, a1, -h),
        at(inner, a0, -h),
        at(inner, a0, h),
        at(inner, a1, h),
        mat,
        shade,
      );
      this.quad(at(inner, a0, h), at(outer, a0, h), at(outer, a1, h), at(inner, a1, h), mat, shade);
      this.quad(
        at(inner, a1, -h),
        at(outer, a1, -h),
        at(outer, a0, -h),
        at(inner, a0, -h),
        mat,
        shade,
      );
    }
  }

  /** A square frustum along y centred on (cx, cz): side `s0` at `y0`, `s1` at `y1`; open at the top. */
  frustum(
    cx: number,
    cz: number,
    y0: number,
    s0: number,
    y1: number,
    s1: number,
    mat: number,
    shade = 1,
  ): void {
    const h0 = s0 / 2;
    const h1 = s1 / 2;
    const b: V3[] = [
      [cx - h0, y0, cz - h0],
      [cx + h0, y0, cz - h0],
      [cx + h0, y0, cz + h0],
      [cx - h0, y0, cz + h0],
    ];
    const t: V3[] = [
      [cx - h1, y1, cz - h1],
      [cx + h1, y1, cz - h1],
      [cx + h1, y1, cz + h1],
      [cx - h1, y1, cz + h1],
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(b[j]!, b[i]!, t[i]!, t[j]!, mat, shade);
    }
    this.quad(b[0]!, b[1]!, b[2]!, b[3]!, mat, shade);
  }

  /** A gable between `min` and `max`: two slopes up to a ridge along z over the middle of x. */
  wedge(min: V3, max: V3, mat: number, capMat = mat, shade = 1): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const xm = (x0 + x1) / 2;
    this.quad([x0, y0, z1], [xm, y1, z1], [xm, y1, z0], [x0, y0, z0], mat, shade);
    this.quad([xm, y1, z1], [x1, y0, z1], [x1, y0, z0], [xm, y1, z0], mat, shade);
    this.tri([x0, y0, z0], [xm, y1, z0], [x1, y0, z0], capMat, shade);
    this.tri([x1, y0, z1], [xm, y1, z1], [x0, y0, z1], capMat, shade);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], mat, shade);
  }

  /**
   * An indexed triangle mesh: `vertices` with `stride` floats per vertex, position at 0 and
   * normal at 3 (a `geom` `Geometry`), counter-clockwise from outside.
   */
  mesh(
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
    stride: number,
    mat: number,
    shade = 1,
  ): void {
    const p = (i: number): V3 => [
      vertices[i * stride]!,
      vertices[i * stride + 1]!,
      vertices[i * stride + 2]!,
    ];
    const n = (i: number): V3 => [
      vertices[i * stride + 3]!,
      vertices[i * stride + 4]!,
      vertices[i * stride + 5]!,
    ];
    for (let k = 0; k + 2 < indices.length; k += 3) {
      const a = indices[k]!;
      const b = indices[k + 1]!;
      const c = indices[k + 2]!;
      this.tri(p(a), p(b), p(c), mat, shade, [n(a), n(b), n(c)]);
    }
  }

  /** Vertices written so far. */
  get vertexCount(): number {
    return this.out.length / MODEL_VERTEX_FLOATS;
  }

  /** The vertices written, packed; the builder starts empty again. */
  done(): Float32Array<ArrayBuffer> {
    const v = new Float32Array(this.out);
    this.out = [];
    return v;
  }
}
