import { type Mat4, mat4 } from '../core/math';

/** A rectangle: origin at top-left, y down. Matches `platform`'s and `ui`'s `Rect`. */
export interface CameraRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point; `worldToScreen` and `screenToWorld` fill one. */
export interface CameraPoint {
  x: number;
  y: number;
  z: number;
}

/** Every layer bit set: the default `Camera.layers`. */
export const ALL_LAYERS = 0xffffffff;

/**
 * Half the depth range of `Camera.ortho2d`, in design units: its near plane is at world
 * z = -ORTHO2D_HALF_DEPTH, the far plane at +ORTHO2D_HALF_DEPTH, z = 0 at clip depth 0.5.
 */
export const ORTHO2D_HALF_DEPTH = 1024;

/** Floats in the WGSL `EngineCamera` block (256 bytes). */
export const CAMERA_BLOCK_FLOATS = 64;

/** Floats in `Camera.frustum`: six planes × (a, b, c, d). */
export const FRUSTUM_FLOATS = 24;

const tmp: number[] = [0, 0, 0];
/** `fitFreeRect`'s viewport in screen units (one per module; the camera reads it synchronously). */
const freeScratch: CameraRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * A view-projection camera. Matrices are column-major `Float32Array(16)` (see `mat4` in
 * `@thunderclap/engine/core`), computed on read and cached until something changes.
 *
 * Two presets:
 *
 * - `Camera.ortho2d(designW, designH)`: 1 world unit = 1 design px, origin top-left, y down,
 *   z into the screen (right-handed with y down): world z in `±ORTHO2D_HALF_DEPTH` spans the
 *   depth buffer, z = 0 sits at clip depth 0.5 and larger z is farther. The 2D controls `x`,
 *   `y`, `zoom` and `rotation` move it over that space exactly like the engine's earlier 2D
 *   camera; `fitRect` frames a world rect.
 *   `Transform.z` is thus a stacking axis for 2D draws under a depth camera.
 * - `Camera.perspective(fovY, aspect, near, far)`: right-handed, looking down -z; place it with
 *   `lookAt` or `setView`.
 *
 * `screen` is the rect the clip space spans, in the units `worldToScreen` returns and
 * `screenToWorld` takes: the logical (design px) space for `ortho2d`, normalised 0..1 for
 * `perspective` until a caller sets it.
 *
 * ```ts
 * const cam = renderer.camera;          // Camera.ortho2d(1920, 1080) by default
 * cam.x = 120; cam.zoom = 1.5;          // pan and zoom, as before
 * const p = cam.screenToWorld(tapX, tapY); // logical px (surface.clientToLogical) → world
 * ```
 */
export class Camera {
  /** Depth test for draws through this camera. The 2D preset leaves it off. */
  depthTest = false;
  /** Depth write for draws through this camera. The 2D preset leaves it off. */
  depthWrite = false;
  /**
   * Layer membership mask (u32): a draw is seen when `draw.layers & camera.layers` is nonzero.
   * Default: every bit. Draw order within a camera is a separate sort key, not this mask.
   */
  layers = ALL_LAYERS;
  /** The rect clip space spans, in screen units (see the class comment). */
  readonly screen: CameraRect = { x: 0, y: 0, width: 1, height: 1 };
  /**
   * The `view_index` the camera block carries (u32): 0 by default; a stereo pair sets 0 and 1
   * so a material can tell the eyes apart. The renderer writes it as given, whatever the order
   * of the frame's `render` calls.
   */
  viewIndex = 0;
  /**
   * Frustum-cull mesh draws through this camera: a draw whose bounding sphere (`mesh.bounds`
   * through its instance matrix) lies outside any plane of `frustum` is skipped before the sort
   * and counted in `renderer.stats.culled`. Off for `ortho2d` (the 2D path is untouched), on
   * for `perspective`. Sprites and meshes without bounds are never culled.
   */
  cull = false;

  private readonly viewM = mat4.create();
  private readonly projM = mat4.create();
  private readonly viewProjM = mat4.create();
  private readonly invViewProjM = mat4.create();
  private readonly invViewM = mat4.create();
  private readonly pos = new Float32Array(3);
  /** 'view2d': the view comes from x/y/zoom/rotation; 'custom': from setView/lookAt. */
  private viewSource: 'view2d' | 'custom' = 'view2d';
  /** 'ortho2d': design-space ortho; 'custom': setProjection/setPerspective. */
  private projSource: 'ortho2d' | 'custom' = 'ortho2d';
  private designW = 1;
  private designH = 1;
  private _x = 0;
  private _y = 0;
  private _zoom = 1;
  private _rotation = 0;
  private dirty = true;
  private invDirty = true;
  private posDirty = true;
  private frustumDirty = true;
  private readonly frustumM = new Float32Array(FRUSTUM_FLOATS);

  /** 1 world unit = 1 design px over a `designW × designH` space, origin top-left, y down. */
  static ortho2d(designW: number, designH: number): Camera {
    return new Camera().setOrtho2d(designW, designH);
  }

  /**
   * Perspective camera at the origin looking down -z. `fovY` in radians; `far` may be
   * `Infinity`. Depth test, depth write and frustum culling are on.
   */
  static perspective(fovY: number, aspect: number, near: number, far: number): Camera {
    const c = new Camera().setPerspective(fovY, aspect, near, far);
    c.setView(mat4.identity(c.viewM));
    c.depthTest = true;
    c.depthWrite = true;
    c.cull = true;
    return c;
  }

  /**
   * Switch to the 2D preset over `designW × designH` (resets `screen` to that space; keeps the
   * 2D controls). Depth flags are left as they are.
   */
  setOrtho2d(designW: number, designH: number): this {
    this.designW = designW;
    this.designH = designH;
    this.projSource = 'ortho2d';
    this.viewSource = 'view2d';
    const s = this.screen;
    s.x = 0;
    s.y = 0;
    s.width = designW;
    s.height = designH;
    return this.touch();
  }

  /** Replace the projection with a perspective one (radians; `far` may be `Infinity`). */
  setPerspective(fovY: number, aspect: number, near: number, far: number): this {
    mat4.perspective(this.projM, fovY, aspect, near, far);
    this.projSource = 'custom';
    return this.touch();
  }

  /** Replace the projection matrix (copied). */
  setProjection(m: ArrayLike<number>): this {
    mat4.copy(this.projM, m);
    this.projSource = 'custom';
    return this.touch();
  }

  /** Replace the view matrix (copied). The 2D controls stop applying until `setOrtho2d`. */
  setView(m: ArrayLike<number>): this {
    if (m !== this.viewM) mat4.copy(this.viewM, m);
    this.viewSource = 'custom';
    return this.touch();
  }

  /**
   * Replace the view matrix (copied); the same as `setView`, named for an XR eye whose
   * `XRView.transform.inverse.matrix` is handed over as-is each frame (ws/xr).
   */
  setViewMatrix(m: ArrayLike<number>): this {
    return this.setView(m);
  }

  /** Place the camera at `eye` looking at `target` (`up` defaults to +y). */
  lookAt(eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number> = UP): this {
    mat4.lookAt(this.viewM, eye, target, up);
    this.viewSource = 'custom';
    return this.touch();
  }

  // ------------------------------------------------------------------ 2D controls

  /** 2D pan (design px): the world point at the view centre is `designW/2 + x`. */
  get x(): number {
    return this._x;
  }
  set x(v: number) {
    if (v !== this._x) {
      this._x = v;
      this.touch2d();
    }
  }
  /** 2D pan (design px). */
  get y(): number {
    return this._y;
  }
  set y(v: number) {
    if (v !== this._y) {
      this._y = v;
      this.touch2d();
    }
  }
  /** 2D zoom about the view centre. */
  get zoom(): number {
    return this._zoom;
  }
  set zoom(v: number) {
    if (v !== this._zoom) {
      this._zoom = v;
      this.touch2d();
    }
  }
  /** 2D view rotation about the view centre, radians (the view turns clockwise, the world counter-clockwise). */
  get rotation(): number {
    return this._rotation;
  }
  set rotation(v: number) {
    if (v !== this._rotation) {
      this._rotation = v;
      this.touch2d();
    }
  }

  /**
   * Frame the world rect `rect` (z = 0) into `viewport` (screen units; default `screen`),
   * contained and centred, with rotation reset. Needs the 2D view (`ortho2d`); for the
   * world space a layout leaves, convert `layout.freeRect` to screen units first.
   */
  fitRect(rect: CameraRect, viewport: CameraRect = this.screen): this {
    if (this.projSource !== 'ortho2d') {
      throw new Error('Camera.fitRect needs the ortho2d preset');
    }
    const s = this.screen;
    const W = this.designW;
    const H = this.designH;
    // The viewport in design px (the space the 2D view maps into).
    const kx = W / s.width;
    const ky = H / s.height;
    const vw = viewport.width * kx;
    const vh = viewport.height * ky;
    const vcx = (viewport.x - s.x) * kx + vw / 2;
    const vcy = (viewport.y - s.y) * ky + vh / 2;
    const zoom = Math.min(vw / rect.width, vh / rect.height);
    if (!(zoom > 0) || !Number.isFinite(zoom)) return this;
    this.viewSource = 'view2d';
    this._rotation = 0;
    this._zoom = zoom;
    // A world point p lands on W/2 + zoom (p - cx); put the rect centre on the viewport centre.
    this._x = rect.x + rect.width / 2 - (vcx - W / 2) / zoom - W / 2;
    this._y = rect.y + rect.height / 2 - (vcy - H / 2) / zoom - H / 2;
    return this.touch();
  }

  /**
   * `fitRect` into the part of the surface a layout leaves free: `free` is in CSS px relative to
   * the surface's parent (`ui.layout.freeRect`), `surface.rect` is where the canvas sits in the
   * same CSS px (`Surface.rect`); the free rect is mapped onto `screen` (its share of the canvas)
   * and the world rect is fitted into that. Allocates nothing.
   */
  fitFreeRect(rect: CameraRect, free: CameraRect, surface: { readonly rect: CameraRect }): this {
    const r = surface.rect;
    if (!(r.width > 0) || !(r.height > 0) || !(free.width > 0) || !(free.height > 0)) return this;
    const s = this.screen;
    const kx = s.width / r.width;
    const ky = s.height / r.height;
    freeScratch.x = s.x + (free.x - r.x) * kx;
    freeScratch.y = s.y + (free.y - r.y) * ky;
    freeScratch.width = free.width * kx;
    freeScratch.height = free.height * ky;
    return this.fitRect(rect, freeScratch);
  }

  // ------------------------------------------------------------------ matrices

  /** World → view. Read-only; change it with the 2D controls, `setView` or `lookAt`. */
  get view(): Mat4 {
    this.update();
    return this.viewM;
  }

  /** View → clip. Read-only; change it with a preset or `setProjection`. */
  get projection(): Mat4 {
    this.update();
    return this.projM;
  }

  /** World → clip (`projection × view`). Read-only. */
  get viewProjection(): Mat4 {
    this.update();
    return this.viewProjM;
  }

  /** The eye position in world space (from the inverse view). Read-only. */
  get position(): Float32Array {
    this.update();
    if (this.posDirty) {
      this.posDirty = false;
      if (mat4.invert(this.invViewM, this.viewM)) {
        this.pos[0] = this.invViewM[12]!;
        this.pos[1] = this.invViewM[13]!;
        this.pos[2] = this.invViewM[14]!;
      }
    }
    return this.pos;
  }

  /** Is a draw with layer mask `mask` seen by this camera? */
  sees(mask: number): boolean {
    return (this.layers & mask) !== 0;
  }

  /**
   * World point → screen units (see `screen`); `z` of the result is clip depth (0 near, 1
   * far). Pass `out` to avoid allocating.
   */
  worldToScreen(x: number, y: number, z = 0, out: CameraPoint = { x: 0, y: 0, z: 0 }): CameraPoint {
    mat4.transformPoint(tmp, this.viewProjection, x, y, z);
    const s = this.screen;
    out.x = s.x + ((tmp[0]! + 1) / 2) * s.width;
    out.y = s.y + ((1 - tmp[1]!) / 2) * s.height;
    out.z = tmp[2]!;
    return out;
  }

  /**
   * Screen point (screen units) → world, at clip depth `depth` (0 = near plane, which for
   * `ortho2d` is world z = -ORTHO2D_HALF_DEPTH; 0.5 is z = 0). Call it at depth 0 and 1 for
   * a pick ray. Pass `out` to avoid allocating.
   */
  screenToWorld(
    sx: number,
    sy: number,
    depth = 0,
    out: CameraPoint = { x: 0, y: 0, z: 0 },
  ): CameraPoint {
    this.update();
    if (this.invDirty) {
      this.invDirty = false;
      if (!mat4.invert(this.invViewProjM, this.viewProjM)) mat4.identity(this.invViewProjM);
    }
    const s = this.screen;
    const nx = ((sx - s.x) / s.width) * 2 - 1;
    const ny = 1 - ((sy - s.y) / s.height) * 2;
    mat4.transformPoint(tmp, this.invViewProjM, nx, ny, depth);
    out.x = tmp[0]!;
    out.y = tmp[1]!;
    out.z = tmp[2]!;
    return out;
  }

  /**
   * Write the WGSL `EngineCamera` block (`CAMERA_BLOCK_FLOATS` floats) at float offset `o`:
   * `view`, `proj`, `view_proj`, `camera_pos`, `viewport` (target px: x, y, w, h) and
   * `view_index`. `u32` must view the same buffer as `f32`. Engine-internal.
   */
  writeBlock(
    f32: Float32Array,
    u32: Uint32Array,
    o: number,
    viewport: CameraRect,
    viewIndex = this.viewIndex,
  ): void {
    this.update();
    f32.set(this.viewM, o);
    f32.set(this.projM, o + 16);
    f32.set(this.viewProjM, o + 32);
    const p = this.position;
    f32[o + 48] = p[0]!;
    f32[o + 49] = p[1]!;
    f32[o + 50] = p[2]!;
    f32[o + 51] = 1;
    f32[o + 52] = viewport.x;
    f32[o + 53] = viewport.y;
    f32[o + 54] = viewport.width;
    f32[o + 55] = viewport.height;
    u32[o + 56] = viewIndex >>> 0;
    for (let i = 57; i < CAMERA_BLOCK_FLOATS; i++) f32[o + i] = 0;
  }

  /**
   * The six frustum planes of `viewProjection` as `FRUSTUM_FLOATS` (24) floats: left, right,
   * bottom, top, near, far, each `(a, b, c, d)` with a unit normal pointing inside, so a point
   * `p` is inside when `a·x + b·y + c·z + d >= 0` on every plane and a sphere of radius `r`
   * is outside when that is `< -r` on any. Cached like the matrices. An infinite far plane
   * (`far = Infinity`) is all zeros but `d > 0`, which never rejects. Read-only.
   */
  get frustum(): Float32Array {
    this.update();
    if (this.frustumDirty) {
      this.frustumDirty = false;
      extractFrustum(this.frustumM, this.viewProjM);
    }
    return this.frustumM;
  }

  /**
   * Is a world-space sphere at least partly inside the frustum? `radius` 0 tests a point. Pure
   * plane tests; nothing allocates.
   */
  seesSphere(x: number, y: number, z: number, radius: number): boolean {
    const f = this.frustum;
    for (let i = 0; i < FRUSTUM_FLOATS; i += 4) {
      if (f[i]! * x + f[i + 1]! * y + f[i + 2]! * z + f[i + 3]! < -radius) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ internals

  private touch2d(): void {
    if (this.viewSource === 'view2d') this.touch();
  }

  private touch(): this {
    this.dirty = true;
    this.invDirty = true;
    this.posDirty = true;
    this.frustumDirty = true;
    return this;
  }

  private update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const W = this.designW;
    const H = this.designH;
    if (this.viewSource === 'view2d') {
      mat4.view2d(this.viewM, this._x, this._y, this._zoom, this._rotation, W, H);
    }
    if (this.projSource === 'ortho2d') {
      // y down; z into the screen: ±ORTHO2D_HALF_DEPTH → clip 0..1 (near at -D, far at +D).
      mat4.ortho(this.projM, 0, W, H, 0, ORTHO2D_HALF_DEPTH, -ORTHO2D_HALF_DEPTH);
    }
    if (this.viewSource === 'view2d' && this.projSource === 'ortho2d') {
      ortho2dViewProj(this.viewProjM, this._x, this._y, this._zoom, this._rotation, W, H);
    } else {
      mat4.multiply(this.viewProjM, this.projM, this.viewM);
    }
  }
}

const UP = [0, 1, 0] as const;

/**
 * `ortho × view2d` in one step, with the same arithmetic the renderer used before the matrix
 * camera, so the 2D path stays bit-identical (multiplying the two f32 matrices would round
 * differently).
 */
function ortho2dViewProj(
  g: Mat4,
  x: number,
  y: number,
  zoom: number,
  rotation: number,
  W: number,
  H: number,
): void {
  const sx = 2 / W;
  const sy = 2 / H;
  const c = Math.cos(-rotation) * zoom;
  const s = Math.sin(-rotation) * zoom;
  const cx = W / 2 + x;
  const cy = H / 2 + y;
  g.fill(0);
  g[0] = c * sx;
  g[1] = -s * sy;
  g[4] = -s * sx;
  g[5] = -c * sy;
  g[10] = 1 / (2 * ORTHO2D_HALF_DEPTH);
  g[12] = -c * sx * cx + s * sx * cy;
  g[13] = s * sy * cx + c * sy * cy;
  g[14] = 0.5;
  g[15] = 1;
}

/**
 * The six planes of a column-major clip matrix `m` (WebGPU clip space: `-w ≤ x, y ≤ w`,
 * `0 ≤ z ≤ w`) into `out` (24 floats), normals normalised and pointing inside. Row `i` of `m`
 * is `(m[i], m[4+i], m[8+i], m[12+i])`; the planes are `row3 ± row0`, `row3 ± row1`, `row2`
 * and `row3 - row2`. A degenerate plane (an infinite far plane) is left unnormalised.
 */
function extractFrustum(out: Float32Array, m: ArrayLike<number>): void {
  const r0 = 0;
  const r1 = 1;
  const r2 = 2;
  const r3 = 3;
  plane(out, 0, m, r3, r0, 1);
  plane(out, 4, m, r3, r0, -1);
  plane(out, 8, m, r3, r1, 1);
  plane(out, 12, m, r3, r1, -1);
  plane(out, 16, m, r2, r2, 0);
  plane(out, 20, m, r3, r2, -1);
}

/** `out[o..o+4) = normalise(row a + sign · row b)` of `m`; `sign` 0 copies row `a`. */
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
  const len = Math.hypot(x, y, z);
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
