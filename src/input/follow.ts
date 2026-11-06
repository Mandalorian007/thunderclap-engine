import type { Camera } from '../render/camera';
import type { Look } from './look';
import type { Vec3 } from './rays';

/** The part of `Camera` a `Follow` drives: it only ever calls `lookAt`. */
export type FollowCamera = Pick<Camera, 'lookAt'>;

/** `'third'`: orbit behind the target. `'first'`: through its eyes, same yaw and pitch. */
export type FollowMode = 'first' | 'third';

/** What the camera follows. The game owns the object and moves it; `Follow` reads it each frame. */
export interface FollowTarget {
  /** The target's feet (or centre), world units. `eyeHeight` is added for the pivot. */
  position: ArrayLike<number>;
  /**
   * The target's facing, radians (same convention as `yaw`: 0 is -z, positive turns right).
   * With `realign` set, the orbit eases back to it while nobody is looking around.
   */
  yaw?: number;
}

/**
 * The game's line-of-sight test (the engine has no world). `from` is the pivot, `to` the camera
 * position the orbit wants. Return true and write the first obstacle point into `outHit` to pull
 * the camera in to `outHit` minus `margin`; return false for a clear line.
 */
export type FollowObstacle = (from: Vec3, to: Vec3, outHit: Vec3) => boolean;

export interface FollowOptions {
  /** Orbit radius wanted, world units. Default 4. */
  distance?: number;
  /** `zoom()` floor. Default 1. */
  minDistance?: number;
  /** `zoom()` ceiling. Default 12. */
  maxDistance?: number;
  /** Over-the-shoulder offset of the pivot, camera right and up, world units. Default `[0, 0]`. */
  shoulder?: readonly [number, number];
  /** Pitch floor, radians (negative looks down; the orbit rises above the target). Default -1.2. */
  pitchMin?: number;
  /** Pitch ceiling, radians. Default 1.2. */
  pitchMax?: number;
  /**
   * Time constant, seconds, of the pivot's approach to the target and of the distance's recovery
   * after an obstacle (it snaps in, eases out). 0 follows exactly. Default 0.12.
   */
  smoothing?: number;
  /** Height of the pivot (and the first-person eye) above `target.position`. Default 1.6. */
  eyeHeight?: number;
  /** World units one `zoom(1)` step changes `distance` by. Default 0.5. */
  zoomStep?: number;
  /** Line-of-sight test from the pivot to the wanted camera position. Default none. */
  obstacle?: FollowObstacle;
  /** Pull-back from an obstacle point along the line to the pivot, world units. Default 0.2. */
  margin?: number;
  /**
   * Time constant, seconds, of the orbit yaw easing back to `target.yaw` while the look input
   * is still. 0 (default) never realigns.
   */
  realign?: number;
  /** Starting orbit yaw, radians. Default 0 (behind a target facing -z). */
  yaw?: number;
  /** Starting pitch, radians. Default -0.35 (a little above, looking down). */
  pitch?: number;
  /** Starting mode. Default `'third'`. */
  mode?: FollowMode;
}

/** Longest `dt` one `update` integrates over, seconds. */
const MAX_DT = 0.1;

/**
 * A third-person camera that follows a target, orbits from the same `look` deltas `Look` reports,
 * swings in on obstacles the game reports, and becomes a first-person camera with one
 * assignment (`mode = 'first'`). Each `update(dt)` reads the linked `Look` (or the yaw and pitch
 * the game set), places the eye and calls `camera.lookAt`. Nothing allocates per frame.
 *
 * Conventions match `Look` and the look harness: yaw 0 looks down -z and positive yaw turns
 * right; positive pitch looks up (so in third person the camera sinks below the pivot; negative
 * pitch raises it). The pivot is `target.position + (0, eyeHeight, 0)` shifted by `shoulder`
 * along the camera's right and up; the eye sits `distance` behind it along the view direction.
 *
 * ```ts
 * const follow = new Follow(camera, { distance: 5, shoulder: [0.6, 0], obstacle: world.raycast });
 * follow.target = player;              // { position: Float32Array(3), yaw }
 * follow.setLook(look);
 * // each tick, after input.update():
 * follow.update(dt);
 * if (input.pressed('view')) follow.mode = follow.mode === 'third' ? 'first' : 'third';
 * if (input.pressed('zoomOut')) follow.zoom(1);
 * ```
 */
export class Follow {
  /** What to follow. Until set, the pivot is at the origin. */
  target: FollowTarget | null = null;
  /** Orbit yaw, radians (0 is -z, positive turns right). The `Look` adds to it. */
  yaw: number;
  /** View pitch, radians, clamped to `pitchMin..pitchMax` each update. */
  pitch: number;
  /** Orbit radius wanted; `currentDistance` is what an obstacle left of it. `zoom()` steps it. */
  distance: number;
  mode: FollowMode;
  minDistance: number;
  maxDistance: number;
  pitchMin: number;
  pitchMax: number;
  smoothing: number;
  eyeHeight: number;
  zoomStep: number;
  margin: number;
  realign: number;
  obstacle: FollowObstacle | null;
  /** Shoulder offset (camera right, up). Mutate in place. */
  readonly shoulder: [number, number];
  /** The eye placed by the last `update`, world units. Read-only. */
  readonly position: Vec3 = [0, 0, 0];
  /** The smoothed pivot the camera orbits (and looks at) as of the last `update`. Read-only. */
  readonly pivot: Vec3 = [0, 0, 0];
  /** The unit view direction of the last `update`. Read-only. */
  readonly forward: Vec3 = [0, 0, -1];
  /** The orbit radius the last `update` used: `distance`, shortened by an obstacle. */
  currentDistance: number;

  private readonly camera: FollowCamera;
  private look: Look | null = null;
  private pivotSet = false;
  private readonly wanted: Vec3 = [0, 0, 0];
  private readonly hit: Vec3 = [0, 0, 0];
  private readonly aim: Vec3 = [0, 0, 0];

  constructor(camera: FollowCamera, opts: FollowOptions = {}) {
    this.camera = camera;
    this.distance = opts.distance ?? 4;
    this.minDistance = opts.minDistance ?? 1;
    this.maxDistance = opts.maxDistance ?? 12;
    this.shoulder = [opts.shoulder?.[0] ?? 0, opts.shoulder?.[1] ?? 0];
    this.pitchMin = opts.pitchMin ?? -1.2;
    this.pitchMax = opts.pitchMax ?? 1.2;
    this.smoothing = opts.smoothing ?? 0.12;
    this.eyeHeight = opts.eyeHeight ?? 1.6;
    this.zoomStep = opts.zoomStep ?? 0.5;
    this.obstacle = opts.obstacle ?? null;
    this.margin = opts.margin ?? 0.2;
    this.realign = opts.realign ?? 0;
    this.yaw = opts.yaw ?? 0;
    this.pitch = opts.pitch ?? -0.35;
    this.mode = opts.mode ?? 'third';
    this.currentDistance = this.distance;
  }

  /** Read yaw and pitch deltas from this `Look` each update (`null` stops reading). */
  setLook(look: Look | null): void {
    this.look = look;
  }

  /** Step `distance` by `steps × zoomStep` (positive zooms out), clamped to min..max. */
  zoom(steps: number): void {
    this.distance = clamp(
      this.distance + steps * this.zoomStep,
      this.minDistance,
      this.maxDistance,
    );
  }

  /** Forget the smoothed pivot so the next `update` snaps to the target (teleports, scene changes). */
  snap(): void {
    this.pivotSet = false;
    this.currentDistance = this.distance;
  }

  /**
   * Advance one frame: apply the look deltas, clamp the pitch, follow the target, test the line
   * of sight and aim the camera. `dt` in seconds.
   */
  update(dt: number): void {
    const step = Math.min(MAX_DT, Math.max(0, dt));
    const look = this.look;
    let turned = false;
    if (look) {
      const dx = look.look.dx;
      const dy = look.look.dy;
      this.yaw += dx;
      this.pitch += dy;
      turned = dx !== 0 || dy !== 0;
    }
    this.pitch = clamp(this.pitch, this.pitchMin, this.pitchMax);
    this.distance = clamp(this.distance, this.minDistance, this.maxDistance);

    const t = this.target;
    const tp = t?.position;
    const tx = tp ? tp[0]! : 0;
    const ty = (tp ? tp[1]! : 0) + this.eyeHeight;
    const tz = tp ? tp[2]! : 0;

    if (this.realign > 0 && !turned && t && t.yaw !== undefined) {
      this.yaw += angleDelta(this.yaw, t.yaw) * ease(step, this.realign);
    }

    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch);
    const cp = Math.cos(this.pitch);
    const f = this.forward;
    f[0] = sy * cp;
    f[1] = sp;
    f[2] = -cy * cp;

    const eye = this.position;
    const pivot = this.pivot;
    const aim = this.aim;

    if (this.mode === 'first') {
      // Head-mounted: no lag, no shoulder; the pivot sits on the eye.
      eye[0] = pivot[0] = tx;
      eye[1] = pivot[1] = ty;
      eye[2] = pivot[2] = tz;
      this.pivotSet = true;
      this.currentDistance = 0;
      aim[0] = eye[0] + f[0];
      aim[1] = eye[1] + f[1];
      aim[2] = eye[2] + f[2];
      this.camera.lookAt(eye, aim);
      return;
    }

    // Camera right (yaw only) and up (perpendicular to forward in the yaw plane).
    const rx = cy;
    const rz = sy;
    const ux = -sy * sp;
    const uy = cp;
    const uz = cy * sp;
    const sh = this.shoulder;
    const px = tx + rx * sh[0] + ux * sh[1];
    const py = ty + uy * sh[1];
    const pz = tz + rz * sh[0] + uz * sh[1];

    if (this.pivotSet && this.smoothing > 0) {
      const k = ease(step, this.smoothing);
      pivot[0] += (px - pivot[0]) * k;
      pivot[1] += (py - pivot[1]) * k;
      pivot[2] += (pz - pivot[2]) * k;
    } else {
      pivot[0] = px;
      pivot[1] = py;
      pivot[2] = pz;
      this.pivotSet = true;
    }

    const wanted = this.wanted;
    const d = this.distance;
    wanted[0] = pivot[0] - f[0] * d;
    wanted[1] = pivot[1] - f[1] * d;
    wanted[2] = pivot[2] - f[2] * d;

    let allowed = d;
    const ob = this.obstacle;
    if (ob) {
      const hit = this.hit;
      if (ob(pivot, wanted, hit)) {
        const hd = Math.hypot(hit[0] - pivot[0], hit[1] - pivot[1], hit[2] - pivot[2]);
        allowed = Math.max(0, Math.min(d, hd - this.margin));
      }
    }
    // Snap in on an obstacle; ease back out when the line clears.
    let cur = this.currentDistance;
    if (allowed < cur || this.smoothing <= 0) cur = allowed;
    else cur += (allowed - cur) * ease(step, this.smoothing);
    this.currentDistance = cur;

    eye[0] = pivot[0] - f[0] * cur;
    eye[1] = pivot[1] - f[1] * cur;
    eye[2] = pivot[2] - f[2] * cur;
    if (cur > 0) {
      this.camera.lookAt(eye, pivot);
    } else {
      aim[0] = eye[0] + f[0];
      aim[1] = eye[1] + f[1];
      aim[2] = eye[2] + f[2];
      this.camera.lookAt(eye, aim);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The fraction of the gap to close this step for an exponential approach with time constant `tau`. */
function ease(dt: number, tau: number): number {
  return tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
}

/** Shortest signed turn from `from` to `to`, radians in -π..π. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
