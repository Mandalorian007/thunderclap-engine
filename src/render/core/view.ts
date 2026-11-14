/**
 * Views (D1 §3.1, §3.5, §3.8, P2): what the core prepares once and draws once per view. A view is
 * a view-projection matrix, its frustum planes and an eye position; the core writes every view of
 * a frame into one uniform buffer (one 256-byte slot each) and culls them in one dispatch.
 *
 * - **Cull groups.** Views come in groups. A stereo pair is one group, culled once by the union of
 *   its frusta (`unionPlanesInto`): one cull, one argument set and one bundle serve both eyes.
 *   Split screens or a minimap are separate groups.
 * - **Camera-relative origin.** With `RenderCoreOptions.originGrid`, the core keeps a frame origin
 *   (the first view's eye snapped to the grid) and hands the GPU everything relative to it: the
 *   view-projection, the eye, the planes and each slot's origin. World positions stay float64 on
 *   the CPU (`RenderView.eye`, `SlotDesc.origin`), so a camera 100 km out keeps full precision.
 */
import type { Camera } from '../camera';

/** Bytes per view slot in the core's view buffer (one uniform binding each). */
export const VIEW_SLOT_BYTES = 256;
/** Floats per view slot. */
export const VIEW_SLOT_FLOATS = VIEW_SLOT_BYTES / 4;
/** Views one frame can prepare (a stereo pair, split screens, a minimap). */
export const MAX_VIEWS = 8;

/** Float offsets inside a view slot. */
export const VIEW_SLOT = {
  viewProj: 0,
  position: 16,
  planes: 20,
  index: 44,
  origin: 48,
} as const;

/**
 * The WGSL a draw set's shader sees for its view: `view.viewProj`, `view.position` (xyz, w 1),
 * `view.planes` (six, unit normals pointing in), `view.index` (which view of the frame) and
 * `view.origin` (the frame origin, xyz, w 1; zero without `originGrid`). With an origin,
 * `viewProj`, `position` and `planes` are relative to it. The core prepends it to every draw
 * set's shader.
 */
export const CORE_VIEW_WGSL = /* wgsl */ `
struct CoreView {
  viewProj: mat4x4f,
  position: vec4f,
  planes: array<vec4f, 6>,
  index: u32,
  _a: u32,
  _b: u32,
  _c: u32,
  origin: vec4f,
  _pad: array<vec4f, 3>,
};
`;

/** One view: fill it from a camera (`setViewFromCamera`) or write its arrays directly. */
export interface RenderView {
  /** Column-major view-projection matrix (16 floats). */
  readonly viewProj: Float32Array;
  /** Six planes `(a, b, c, d)` with unit normals pointing inside (24 floats; `Camera.frustum`). */
  readonly planes: Float32Array;
  /** Eye position `(x, y, z, 1)`. */
  readonly position: Float32Array;
  /**
   * The projection alone (16 floats). With `view`, what a union frustum and a camera-relative
   * origin are built from; `createRenderView` and `setViewFromCamera` fill it.
   */
  readonly proj?: Float32Array;
  /** The world-to-eye matrix alone (16 floats, rigid). Its translation is ignored when `eye` is used. */
  readonly view?: Float32Array;
  /**
   * The eye in world space, float64: what a camera-relative origin subtracts at full precision.
   * Without it the eye is read from `position` (float32).
   */
  readonly eye?: Float64Array;
}

/**
 * A cull group (D1 §3.1, P2): views prepared together. `'union'` (default) culls them once by
 * the union of their frusta, so they share one cull, one argument set and one bundle per set;
 * `'each'` culls every view on its own (as if each were a group of one).
 */
export interface CullGroup {
  readonly views: readonly RenderView[];
  readonly planes?: 'union' | 'each';
}

/** A view with an identity matrix and planes that reject nothing. */
export function createRenderView(): RenderView {
  const viewProj = new Float32Array(16);
  viewProj[0] = viewProj[5] = viewProj[10] = viewProj[15] = 1;
  const planes = new Float32Array(24);
  for (let i = 0; i < 24; i += 4) planes[i + 3] = 1;
  const position = new Float32Array([0, 0, 0, 1]);
  const proj = new Float32Array(16);
  proj[0] = proj[5] = proj[10] = proj[15] = 1;
  const view = new Float32Array(16);
  view[0] = view[5] = view[10] = view[15] = 1;
  return { viewProj, planes, position, proj, view, eye: new Float64Array(3) };
}

/**
 * Copy `camera`'s view-projection, frustum and position into `view`, and its projection, view
 * matrix and eye when `view` has them (nothing allocates). `eye`, when given, is the eye in world
 * space at float64 (a game's own double-precision position), used instead of `camera.position`.
 */
export function setViewFromCamera(
  view: RenderView,
  camera: Camera,
  eye?: ArrayLike<number>,
): RenderView {
  view.viewProj.set(camera.viewProjection);
  view.planes.set(camera.frustum);
  const p = eye ?? camera.position;
  view.position[0] = p[0]!;
  view.position[1] = p[1]!;
  view.position[2] = p[2]!;
  view.position[3] = 1;
  view.proj?.set(camera.projection);
  view.view?.set(camera.view);
  const e = view.eye;
  if (e) {
    e[0] = p[0]!;
    e[1] = p[1]!;
    e[2] = p[2]!;
  }
  return view;
}

/**
 * Fill `view` from a projection, a rigid world-to-eye matrix and the eye at float64 (an XR view:
 * `XRView.projectionMatrix`, `transform.inverse.matrix` and `transform.position`). Builds
 * `viewProj`, `planes` and `position` too. Nothing allocates.
 */
export function setViewFromMatrices(
  view: RenderView,
  proj: ArrayLike<number>,
  worldToEye: ArrayLike<number>,
  eye: ArrayLike<number>,
): RenderView {
  view.proj?.set(proj as ArrayLike<number>);
  view.view?.set(worldToEye as ArrayLike<number>);
  const e = view.eye;
  if (e) {
    e[0] = eye[0]!;
    e[1] = eye[1]!;
    e[2] = eye[2]!;
  }
  mul4(m64, proj, worldToEye);
  view.viewProj.set(m64);
  planesInto(view.planes, 0, m64);
  view.position[0] = eye[0]!;
  view.position[1] = eye[1]!;
  view.position[2] = eye[2]!;
  view.position[3] = 1;
  return view;
}

/** Is a sphere at least partly inside the six planes (24 floats) at `planes[at..]`? */
export function sphereInPlanes(
  planes: Float32Array,
  at: number,
  x: number,
  y: number,
  z: number,
  r: number,
): boolean {
  for (let i = at; i < at + 24; i += 4) {
    if (planes[i]! * x + planes[i + 1]! * y + planes[i + 2]! * z + planes[i + 3]! < -r) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------ core-facing (internal)

const m64 = new Float64Array(16);
const v64 = new Float64Array(16);
const rel64 = new Float64Array(16);
const head64 = new Float64Array(16);
const proj64 = new Float64Array(16);

/** Does `view` carry what a relative or union build needs? */
function hasBasis(view: RenderView): boolean {
  return view.proj !== undefined && view.view !== undefined;
}

/** `out = a · b` (column-major 4×4), float64. */
function mul4(out: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!;
    const b1 = b[c * 4 + 1]!;
    const b2 = b[c * 4 + 2]!;
    const b3 = b[c * 4 + 3]!;
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b0 + a[4 + r]! * b1 + a[8 + r]! * b2 + a[12 + r]! * b3;
    }
  }
  return out;
}

/**
 * Six planes of a view-projection (WebGPU depth 0..1) into `out[at..]`: left, right, bottom, top,
 * near, far, unit normals pointing in (as `Camera.frustum`). A zero-length normal (an infinite
 * far plane) keeps its raw `d`, which never rejects.
 */
function planesInto(out: Float32Array, at: number, m: ArrayLike<number>): void {
  plane(out, at, m, 3, 0, 1);
  plane(out, at + 4, m, 3, 0, -1);
  plane(out, at + 8, m, 3, 1, 1);
  plane(out, at + 12, m, 3, 1, -1);
  plane(out, at + 16, m, 2, 2, 0);
  plane(out, at + 20, m, 3, 2, -1);
}

function plane(
  out: Float32Array,
  o: number,
  m: ArrayLike<number>,
  a: number,
  b: number,
  sign: number,
): void {
  let x = m[a]! + sign * m[b]!;
  let y = m[4 + a]! + sign * m[4 + b]!;
  let z = m[8 + a]! + sign * m[8 + b]!;
  let d = m[12 + a]! + sign * m[12 + b]!;
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len > 0) {
    const k = 1 / len;
    x *= k;
    y *= k;
    z *= k;
    d *= k;
  }
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = d;
}

/** The eye of `view` (float64 when it has one). */
function eyeOf(view: RenderView, k: number): number {
  return view.eye ? view.eye[k]! : view.position[k]!;
}

/**
 * `out` = `view`'s world-to-eye matrix relative to `origin`: the rotation of `view.view` and the
 * translation `R · (origin − eye)`, computed at float64 so a far eye loses nothing.
 */
function relativeView(out: Float64Array, view: RenderView, origin: ArrayLike<number>): void {
  const v = view.view!;
  for (let i = 0; i < 16; i++) out[i] = v[i]!;
  const dx = origin[0]! - eyeOf(view, 0);
  const dy = origin[1]! - eyeOf(view, 1);
  const dz = origin[2]! - eyeOf(view, 2);
  out[12] = v[0]! * dx + v[4]! * dy + v[8]! * dz;
  out[13] = v[1]! * dx + v[5]! * dy + v[9]! * dz;
  out[14] = v[2]! * dx + v[6]! * dy + v[10]! * dz;
}

/**
 * Write `view` into slot `index` of `out` (a `VIEW_SLOT_FLOATS`-strided Float32Array), relative to
 * `origin` when `relative` (the core's `originGrid` is on). A relative view with `proj` and `view`
 * is rebuilt at float64 from them and its eye; one without is shifted (its `viewProj` times
 * `translate(origin)`), which is exact only as far as its float32 matrix is.
 */
export function writeViewSlot(
  out: Float32Array,
  u32: Uint32Array,
  index: number,
  view: RenderView,
  origin: Float64Array,
  relative: boolean,
): void {
  const o = index * VIEW_SLOT_FLOATS;
  u32[o + VIEW_SLOT.index] = index;
  out[o + VIEW_SLOT.origin] = origin[0]!;
  out[o + VIEW_SLOT.origin + 1] = origin[1]!;
  out[o + VIEW_SLOT.origin + 2] = origin[2]!;
  out[o + VIEW_SLOT.origin + 3] = 1;
  if (!relative) {
    out.set(view.viewProj, o);
    out.set(view.position, o + VIEW_SLOT.position);
    out.set(view.planes, o + VIEW_SLOT.planes);
    return;
  }
  if (hasBasis(view)) {
    relativeView(rel64, view, origin);
    mul4(m64, view.proj!, rel64);
  } else {
    // viewProj · translate(origin): only the last column changes.
    const vp = view.viewProj;
    for (let i = 0; i < 12; i++) m64[i] = vp[i]!;
    for (let r = 0; r < 4; r++) {
      m64[12 + r] =
        vp[r]! * origin[0]! + vp[4 + r]! * origin[1]! + vp[8 + r]! * origin[2]! + vp[12 + r]!;
    }
  }
  for (let i = 0; i < 16; i++) out[o + i] = m64[i]!;
  out[o + VIEW_SLOT.position] = eyeOf(view, 0) - origin[0]!;
  out[o + VIEW_SLOT.position + 1] = eyeOf(view, 1) - origin[1]!;
  out[o + VIEW_SLOT.position + 2] = eyeOf(view, 2) - origin[2]!;
  out[o + VIEW_SLOT.position + 3] = 1;
  planesInto(out, o + VIEW_SLOT.planes, m64);
}

/**
 * The planes of a frustum holding every view's frustum (D1 §3.5; generalized from Forge's
 * `unionPlanesInto` and TC's XR head camera) into `out[at..at + 24)`, relative to `origin` when
 * `relative`. Built in view 0's eye space: the widest tangent any view's corner rays reach on each
 * side, the apex pulled back along view 0's forward until every eye lies inside, view 0's depth
 * terms. Returns false (writing nothing) when a view has no `proj`/`view` or a corner ray does not
 * point forward; the caller then culls with planes that reject nothing. Nothing allocates.
 */
export function unionPlanesInto(
  out: Float32Array,
  at: number,
  views: readonly RenderView[],
  first: number,
  count: number,
  origin: Float64Array,
  relative: boolean,
): boolean {
  for (let i = 0; i < count; i++) if (!hasBasis(views[first + i]!)) return false;
  const zero = relative ? origin : ZERO;
  const v0 = views[first]!;
  if (relative) relativeView(head64, v0, zero);
  else for (let i = 0; i < 16; i++) head64[i] = v0.view![i]!;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let bo = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  let zb = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count; i++) {
      const v = views[first + i]!;
      if (relative) relativeView(v64, v, zero);
      else for (let k = 0; k < 16; k++) v64[k] = v.view![k]!;
      // rel64 = head · inverse(v): the view's eye space into view 0's.
      invertRigid(m64, v64);
      mul4(rel64, head64, m64);
      if (pass === 0) {
        const p = v.proj!;
        const l = (p[8]! - 1) / p[0]!;
        const r = (p[8]! + 1) / p[0]!;
        const b = (p[9]! - 1) / p[5]!;
        const t = (p[9]! + 1) / p[5]!;
        for (let c = 0; c < 4; c++) {
          const ex = c & 1 ? r : l;
          const ey = c & 2 ? t : b;
          const dx = rel64[0]! * ex + rel64[4]! * ey - rel64[8]!;
          const dy = rel64[1]! * ex + rel64[5]! * ey - rel64[9]!;
          const dz = rel64[2]! * ex + rel64[6]! * ey - rel64[10]!;
          if (!(dz < -1e-6)) return false;
          const tx = dx / -dz;
          const ty = dy / -dz;
          if (tx < lo) lo = tx;
          if (tx > hi) hi = tx;
          if (ty < bo) bo = ty;
          if (ty > to) to = ty;
        }
      } else {
        const ox = rel64[12]!;
        const oy = rel64[13]!;
        const oz = rel64[14]!;
        if (lo < 0) zb = Math.max(zb, oz + ox / lo);
        if (hi > 0) zb = Math.max(zb, oz + ox / hi);
        if (bo < 0) zb = Math.max(zb, oz + oy / bo);
        if (to > 0) zb = Math.max(zb, oz + oy / to);
      }
    }
    if (pass === 0 && !(hi > lo && to > bo)) return false;
  }
  // frustum(lo, hi, bo, to) · translate(0, 0, −zb), column-major; view 0's depth terms.
  const p0 = v0.proj!;
  const a = 2 / (hi - lo);
  const c8 = (hi + lo) / (hi - lo);
  const b5 = 2 / (to - bo);
  const c9 = (to + bo) / (to - bo);
  const e = p0[10]!;
  const f = p0[14]!;
  proj64.fill(0);
  proj64[0] = a;
  proj64[5] = b5;
  proj64[8] = c8;
  proj64[9] = c9;
  proj64[10] = e;
  proj64[11] = -1;
  proj64[12] = -zb * c8;
  proj64[13] = -zb * c9;
  proj64[14] = f - zb * e;
  proj64[15] = zb;
  mul4(m64, proj64, head64);
  planesInto(out, at, m64);
  return true;
}

const ZERO = new Float64Array(3);

/** `out` = the inverse of a rigid (rotation + translation) column-major matrix. */
function invertRigid(out: Float64Array, m: Float64Array): void {
  // Rᵀ
  out[0] = m[0]!;
  out[1] = m[4]!;
  out[2] = m[8]!;
  out[3] = 0;
  out[4] = m[1]!;
  out[5] = m[5]!;
  out[6] = m[9]!;
  out[7] = 0;
  out[8] = m[2]!;
  out[9] = m[6]!;
  out[10] = m[10]!;
  out[11] = 0;
  const tx = m[12]!;
  const ty = m[13]!;
  const tz = m[14]!;
  out[12] = -(out[0]! * tx + out[4]! * ty + out[8]! * tz);
  out[13] = -(out[1]! * tx + out[5]! * ty + out[9]! * tz);
  out[14] = -(out[2]! * tx + out[6]! * ty + out[10]! * tz);
  out[15] = 1;
}

/** Planes that reject nothing, into `out[at..at + 24)`. */
export function openPlanesInto(out: Float32Array, at: number): void {
  for (let i = 0; i < 24; i += 4) {
    out[at + i] = 0;
    out[at + i + 1] = 0;
    out[at + i + 2] = 0;
    out[at + i + 3] = 1;
  }
}
