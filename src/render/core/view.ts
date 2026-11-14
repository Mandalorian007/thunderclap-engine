/**
 * Views (D1 §3.1, P2): what the core prepares once and draws once per view. A view is a
 * view-projection matrix, its frustum planes and an eye position; the core writes every view of
 * a frame into one uniform buffer (one 256-byte slot each) and culls them in one dispatch.
 */
import type { Camera } from '../camera';

/** Bytes per view slot in the core's view buffer (one uniform binding each). */
export const VIEW_SLOT_BYTES = 256;
/** Floats per view slot. */
export const VIEW_SLOT_FLOATS = VIEW_SLOT_BYTES / 4;
/** Views one frame can prepare (a stereo pair, split screens, a minimap). */
export const MAX_VIEWS = 8;

/**
 * The WGSL a draw set's shader sees for its view: `view.viewProj`, `view.position` (xyz, w 1),
 * `view.planes` (six, unit normals pointing in) and `view.index` (which view of the frame).
 * The core prepends it to every draw set's shader.
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
  _pad: array<vec4f, 4>,
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
}

/** A view with an identity matrix and planes that reject nothing. */
export function createRenderView(): RenderView {
  const viewProj = new Float32Array(16);
  viewProj[0] = viewProj[5] = viewProj[10] = viewProj[15] = 1;
  const planes = new Float32Array(24);
  for (let i = 0; i < 24; i += 4) planes[i + 3] = 1;
  const position = new Float32Array([0, 0, 0, 1]);
  return { viewProj, planes, position };
}

/** Copy `camera`'s view-projection, frustum and position into `view` (nothing allocates). */
export function setViewFromCamera(view: RenderView, camera: Camera): RenderView {
  view.viewProj.set(camera.viewProjection);
  view.planes.set(camera.frustum);
  const p = camera.position;
  view.position[0] = p[0]!;
  view.position[1] = p[1]!;
  view.position[2] = p[2]!;
  view.position[3] = 1;
  return view;
}

/** Write `view` into slot `index` of `out` (a `VIEW_SLOT_FLOATS`-strided Float32Array). */
export function writeViewSlot(
  out: Float32Array,
  u32: Uint32Array,
  index: number,
  view: RenderView,
): void {
  const o = index * VIEW_SLOT_FLOATS;
  out.set(view.viewProj, o);
  out.set(view.position, o + 16);
  out.set(view.planes, o + 20);
  u32[o + 44] = index;
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
