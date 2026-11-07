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

/**
 * Floats in the WGSL `EngineCamera` block: 112 used (`jitter` ends at byte 448), padded
 * to 512 bytes so the lights block that follows it in the view's uniform buffer stays on a
 * 256-byte boundary (`minUniformBufferOffsetAlignment`).
 */
export const CAMERA_BLOCK_FLOATS = 128;
/** Float offset of `inv_view_proj` inside the camera block (byte 240). */
export const CAMERA_INV_VIEW_PROJ_OFFSET = 60;
/** Float offset of `prev_view_proj` (last frame's unjittered `view_proj`) inside the block. */
export const CAMERA_PREV_VIEW_PROJ_OFFSET = 76;
/** Float offset of `prev_view` (last frame's `view`) inside the block. */
export const CAMERA_PREV_VIEW_OFFSET = 92;
/** Float offset of `jitter` (clip-space dx, dy; the pixel offset x, y) inside the block. */
export const CAMERA_JITTER_OFFSET = 108;

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
  /**
   * Scales the projected size the renderer picks `MeshLod` levels by (ws/render-5): above 1
   * keeps finer levels farther out, below 1 drops to coarser ones sooner. Default 1.
   */
  lodBias = 1;
  /**
   * Last frame's unjittered `viewProjection`, copied by the renderer at the start of each view
   * it draws this camera through (`recordHistory`), before the camera is read; identity until
   * the first frame. What a reprojecting post pass (TAA, motion blur) reads through
   * `PostInputs.view.previousViewProj`. Read-only (`Float32Array(16)`).
   */
  readonly previousViewProj: Mat4 = mat4.create();
  /** Last frame's `view`, kept like `previousViewProj`. Read-only. */
  readonly previousView: Mat4 = mat4.create();

  private readonly viewM = mat4.create();
  /** `viewProjM` before the jitter offset (what `previousViewProj` and the frustum use). */
  private readonly steadyViewProjM = mat4.create();
  /** What the last `recordHistory` saw: the matrices the next one moves into `previous*`. */
  private readonly historyViewProjM = mat4.create();
  private readonly historyViewM = mat4.create();
  private hasHistory = false;
  /** Sub-pixel jitter in pixels of the current target (`setJitter`). */
  private jitterX = 0;
  private jitterY = 0;
  /** The target size the jitter is measured against; 0 × 0 (the default) applies none. */
  private jitterW = 0;
  private jitterH = 0;
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
   * `Infinity`. Depth test, depth write and frustum culling are on (`setPerspective` sets them).
   */
  static perspective(fovY: number, aspect: number, near: number, far: number): Camera {
    const c = new Camera().setPerspective(fovY, aspect, near, far);
    c.setView(mat4.identity(c.viewM));
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

  /**
   * Replace the projection with a perspective one (radians; `far` may be `Infinity`) and
   * configure the camera the way `Camera.perspective` does: `depthTest`, `depthWrite` and
   * `cull` on (ws/camera-ergo). The view is untouched, so `cam.setPerspective(...)` on a
   * default camera renders like `Camera.perspective(...)`; `setProjection` stays raw.
   */
  setPerspective(fovY: number, aspect: number, near: number, far: number): this {
    mat4.perspective(this.projM, fovY, aspect, near, far);
    this.projSource = 'custom';
    this.depthTest = true;
    this.depthWrite = true;
    this.cull = true;
    return this.touch();
  }

  /** Replace the projection matrix (copied). Raw: no depth or cull flag changes. */
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

  /**
   * Clip → world (`viewProjection⁻¹`), column-major like `viewProj`; cached and recomputed
   * lazily after any view or projection change. Identity when `viewProjection` is singular.
   * Read-only.
   */
  get invViewProj(): Mat4 {
    this.update();
    if (this.invDirty) {
      this.invDirty = false;
      if (!mat4.invert(this.invViewProjM, this.viewProjM)) mat4.identity(this.invViewProjM);
    }
    return this.invViewProjM;
  }

  /**
   * Offset the projection by `(x, y)` pixels of the current target (a TAA sample sequence):
   * `viewProjection` and `invViewProj` carry it, `previousViewProj` and the frustum never do.
   * Zero by default. The renderer applies it only when its post processor declares
   * `wantsJitter` (and never through the 2D `ortho2d` projection), so a page without one
   * draws exactly as before. +x moves the image right, +y down.
   */
  setJitter(x: number, y: number): this {
    if (x === this.jitterX && y === this.jitterY) return this;
    this.jitterX = x;
    this.jitterY = y;
    if (this.jitterW > 0) this.touch();
    return this;
  }

  /** `setJitter(0, 0)`. */
  clearJitter(): this {
    return this.setJitter(0, 0);
  }

  /** The jitter set by `setJitter`, in pixels: `[x, y]`. */
  get jitter(): [number, number] {
    return [this.jitterX, this.jitterY];
  }

  /** `jitter` into `out` (no allocation): the pixels applied, `0, 0` when not applied. */
  getJitter(out: [number, number] | Float32Array): void {
    const on = this.jitterW > 0 && this.projSource !== 'ortho2d';
    out[0] = on ? this.jitterX : 0;
    out[1] = on ? this.jitterY : 0;
  }

  /**
   * The target size the jitter applies against (0 × 0 ignores it). Engine-internal: the
   * renderer sets it per view from the viewport when the post processor wants jitter.
   */
  setJitterTarget(width: number, height: number): void {
    if (width === this.jitterW && height === this.jitterH) return;
    this.jitterW = width;
    this.jitterH = height;
    if (this.jitterX !== 0 || this.jitterY !== 0) this.touch();
  }

  /** The clip-space offset the current jitter adds: `[dx, dy]` (0 when not applied). */
  jitterClip(out: [number, number] | Float32Array): void {
    const on = this.jitterW > 0 && this.projSource !== 'ortho2d';
    out[0] = on ? (2 * this.jitterX) / this.jitterW : 0;
    out[1] = on ? (-2 * this.jitterY) / this.jitterH : 0;
  }

  /**
   * Move the (unjittered) `viewProjection` and `view` seen by the last call into
   * `previousViewProj` and `previousView`, and remember the current ones for the next call.
   * Engine-internal: the renderer calls it at the start of each view, before reading the
   * camera, so a post pass sees last frame's matrices beside this frame's. The first call
   * (a camera's first view) sets previous = current: no motion.
   */
  recordHistory(): void {
    this.update();
    if (this.hasHistory) {
      this.previousViewProj.set(this.historyViewProjM);
      this.previousView.set(this.historyViewM);
    } else {
      this.previousViewProj.set(this.steadyViewProjM);
      this.previousView.set(this.viewM);
      this.hasHistory = true;
    }
    this.historyViewProjM.set(this.steadyViewProjM);
    this.historyViewM.set(this.viewM);
  }

  /** Is a draw with layer mask `mask` seen by this camera? */
  sees(mask: number): boolean {
    return (this.layers & mask) !== 0;
  }

  /**
   * View-space depth of a world point: its distance along the view axis, positive in front of
   * the eye. Reads the view matrix's third row and negates it (`perspective` and `lookAt`
   * look down -z). `ortho2d` looks down +z, so there it is `-worldZ` at rest. Allocates nothing.
   */
  viewZ(x: number, y: number, z = 0): number {
    const v = this.view;
    return -(v[2]! * x + v[6]! * y + v[10]! * z + v[14]!);
  }

  /**
   * `worldToScreen` for many points without the per-point object: reads `count` points from
   * `points` (x, y, z at `i * stride`; `stride` ≥ 3, default 3, `count` defaults to what fits)
   * and writes screen x, screen y and clip depth as 3 floats per point at `out[i * 3]`, the
   * same values `worldToScreen` returns. Returns how many landed inside the viewport: in
   * front of the eye, within `screen` and with clip depth in 0..1. Allocates nothing.
   */
  projectMany(
    points: ArrayLike<number>,
    out: Float32Array,
    count = Math.floor(points.length / 3),
    stride = 3,
  ): number {
    const vp = this.viewProjection;
    const s = this.screen;
    const n = Math.min(count, Math.floor(points.length / stride), Math.floor(out.length / 3));
    let inside = 0;
    for (let i = 0; i < n; i++) {
      const p = i * stride;
      const w = mat4.transformPoint(tmp, vp, points[p]!, points[p + 1]!, points[p + 2]!);
      const cx = tmp[0]!;
      const cy = tmp[1]!;
      const cz = tmp[2]!;
      const o = i * 3;
      out[o] = s.x + ((cx + 1) / 2) * s.width;
      out[o + 1] = s.y + ((1 - cy) / 2) * s.height;
      out[o + 2] = cz;
      if (w > 0 && cx >= -1 && cx <= 1 && cy >= -1 && cy <= 1 && cz >= 0 && cz <= 1) inside++;
    }
    return inside;
  }

  /**
   * The eight world-space corners of the view frustum into `out` (24 floats, x y z each):
   * near plane first, then far, each as bottom-left, bottom-right, top-right, top-left in
   * clip space (clip depth 0 then 1, through `invViewProj`). With `far = Infinity` the far
   * corners have no finite position (w = 0) and come back as the undivided homogeneous
   * coordinates, which are directions. Allocates nothing.
   */
  frustumCorners(out: Float32Array): Float32Array {
    const inv = this.invViewProj;
    let o = 0;
    for (let d = 0; d <= 1; d++) {
      for (let k = 0; k < 4; k++) {
        mat4.transformPoint(tmp, inv, CORNER_X[k]!, CORNER_Y[k]!, d);
        out[o++] = tmp[0]!;
        out[o++] = tmp[1]!;
        out[o++] = tmp[2]!;
      }
    }
    return out;
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
  screenToWorld(sx: number, sy: number, depth?: number, out?: CameraPoint): CameraPoint;
  /**
   * Screen point (screen units) → the world point on the plane z = 0 under it (ws/api-render),
   * the 2D pick: a tap on an `ortho2d` or tilted camera lands on the sprites' plane with no
   * depth to choose. A ray parallel to the plane gives the near-plane point. Writes `out`.
   */
  screenToWorld(sx: number, sy: number, out: CameraPoint): CameraPoint;
  screenToWorld(
    sx: number,
    sy: number,
    depthOrOut: number | CameraPoint = 0,
    out: CameraPoint = { x: 0, y: 0, z: 0 },
  ): CameraPoint {
    if (typeof depthOrOut === 'object') return this.screenToPlane(sx, sy, depthOrOut);
    const inv = this.invViewProj;
    const s = this.screen;
    const nx = ((sx - s.x) / s.width) * 2 - 1;
    const ny = 1 - ((sy - s.y) / s.height) * 2;
    mat4.transformPoint(tmp, inv, nx, ny, depthOrOut);
    out.x = tmp[0]!;
    out.y = tmp[1]!;
    out.z = tmp[2]!;
    return out;
  }

  /** The pick ray through a screen point, met with the plane z = 0. No allocation. */
  private screenToPlane(sx: number, sy: number, out: CameraPoint): CameraPoint {
    this.screenToWorld(sx, sy, 1, out);
    const fx = out.x;
    const fy = out.y;
    const fz = out.z;
    this.screenToWorld(sx, sy, 0, out);
    const dz = fz - out.z;
    if (Math.abs(dz) < 1e-12) return out;
    const t = -out.z / dz;
    out.x += (fx - out.x) * t;
    out.y += (fy - out.y) * t;
    out.z = 0;
    return out;
  }

  /**
   * Write the WGSL `EngineCamera` block (`CAMERA_BLOCK_FLOATS` floats) at float offset `o`:
   * `view`, `proj`, `view_proj`, `camera_pos`, `viewport` (target px: x, y, w, h),
   * `view_index`, at `CAMERA_INV_VIEW_PROJ_OFFSET` `inv_view_proj`, then `prev_view_proj`,
   * `prev_view` and `jitter` (clip dx, dy, pixel x, y). `u32` must view the same buffer as
   * `f32`. Engine-internal.
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
    f32[o + 57] = 0;
    f32[o + 58] = 0;
    f32[o + 59] = 0;
    f32.set(this.invViewProj, o + CAMERA_INV_VIEW_PROJ_OFFSET);
    f32.set(this.previousViewProj, o + CAMERA_PREV_VIEW_PROJ_OFFSET);
    f32.set(this.previousView, o + CAMERA_PREV_VIEW_OFFSET);
    const j = o + CAMERA_JITTER_OFFSET;
    this.jitterClip(jitterScratch);
    f32[j] = jitterScratch[0];
    f32[j + 1] = jitterScratch[1];
    f32[j + 2] = this.jitterW > 0 ? this.jitterX : 0;
    f32[j + 3] = this.jitterW > 0 ? this.jitterY : 0;
    for (let i = CAMERA_JITTER_OFFSET + 4; i < CAMERA_BLOCK_FLOATS; i++) f32[o + i] = 0;
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
      extractFrustum(this.frustumM, this.steadyViewProjM);
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
    this.steadyViewProjM.set(this.viewProjM);
    if (
      this.jitterW > 0 &&
      this.projSource !== 'ortho2d' &&
      (this.jitterX !== 0 || this.jitterY !== 0)
    ) {
      // A clip-space translation by (dx, dy): add dx·w, dy·w to x and y, column by column.
      const dx = (2 * this.jitterX) / this.jitterW;
      const dy = (-2 * this.jitterY) / this.jitterH;
      const m = this.viewProjM;
      for (let c = 0; c < 16; c += 4) {
        m[c] = m[c]! + dx * m[c + 3]!;
        m[c + 1] = m[c + 1]! + dy * m[c + 3]!;
      }
    }
  }
}

const jitterScratch: [number, number] = [0, 0];

const UP = [0, 1, 0] as const;
/** Clip-space corner order for `frustumCorners`: bottom-left, bottom-right, top-right, top-left. */
const CORNER_X = [-1, 1, 1, -1] as const;
const CORNER_Y = [-1, -1, 1, 1] as const;

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
