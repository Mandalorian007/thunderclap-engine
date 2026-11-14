/**
 * A turn about the head (ws/xr-merge, from Forge Wilds' XR2b): the stick turns the body's yaw,
 * and the tracking space turns with it about the body's place, so a head standing away from that
 * place (a step to the side in the room, a lean) would swing round it. `HeadPivot` carries the
 * drawn place by what the head would have swung, so the head stays put and only the view turns.
 *
 * The body is the game's; it isn't moved. What moves is the drawn eye, by `offset` (world x, z).
 * A carry further than `maxCarry` from the body, or one the game's `blocked` test refuses (the
 * carried body would stand in a wall), isn't made: that turn is about the body (`fallbacks`).
 * `check` drops a carry the game now refuses (`drops`).
 *
 * Yaw convention: the body faces (sin yaw, cos yaw) on the ground; the tracking space's +x is
 * the body's right (-cos yaw, sin yaw) and its -z the body's forward. Pure, allocation-free.
 */

/** The furthest the drawn place is carried from the body's (metres, on the ground). */
export const PIVOT_MAX = 1.0;

/**
 * Whether the body would be blocked with its eye at (x, y, z): the game's collision test (a
 * capsule against the world, a voxel box: `cellBoxBlocked`).
 */
export type PivotBlocked = (x: number, y: number, z: number) => boolean;

/** Whether a grid cell is solid. */
export type SolidAt = (x: number, y: number, z: number) => boolean;

/** A body's box on a unit grid: half-width, height and the eye's height over the feet. */
export interface BodyBox {
  half: number;
  height: number;
  eye: number;
}

/**
 * Whether a box (`box`) with its eye at (x, y, z) overlaps a solid cell of a unit grid: a ready
 * `PivotBlocked` for grid worlds. A hair inside the faces, so standing on or against a cell isn't
 * being in it.
 */
export function cellBoxBlocked(
  x: number,
  y: number,
  z: number,
  box: BodyBox,
  solid: SolidAt,
): boolean {
  const e = 1e-3;
  const feet = y - box.eye;
  const x0 = Math.floor(x - box.half + e);
  const x1 = Math.floor(x + box.half - e);
  const y0 = Math.floor(feet + e);
  const y1 = Math.floor(feet + box.height - e);
  const z0 = Math.floor(z - box.half + e);
  const z1 = Math.floor(z + box.half - e);
  for (let bx = x0; bx <= x1; bx++) {
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) if (solid(bx, by, bz)) return true;
    }
  }
  return false;
}

export class HeadPivot {
  /** The drawn eye's carry from the body's (world x, z). */
  readonly offset: [number, number] = [0, 0];
  /** Turns made about the head, about the body (refused), and carries dropped. */
  turns = 0;
  fallbacks = 0;
  drops = 0;
  /** The furthest carry, metres. */
  maxCarry: number;
  private readonly next: [number, number] = [0, 0];

  constructor(opts: { maxCarry?: number } = {}) {
    this.maxCarry = opts.maxCarry ?? PIVOT_MAX;
  }

  /**
   * The body's yaw turned from `before` to `after` with the head at (hx, hz) in the tracking
   * space and the body's eye at `eye`: the carry moved so the head stays put, unless refused.
   * True: about the head.
   */
  turn(
    eye: ArrayLike<number>,
    before: number,
    after: number,
    hx: number,
    hz: number,
    blocked?: PivotBlocked,
  ): boolean {
    const fa = Math.sin(before);
    const ca = Math.cos(before);
    const fb = Math.sin(after);
    const cb = Math.cos(after);
    const n = this.next;
    n[0] = this.offset[0] + (hx * -ca - hz * fa) - (hx * -cb - hz * fb);
    n[1] = this.offset[1] + (hx * fa - hz * ca) - (hx * fb - hz * cb);
    const m = this.maxCarry;
    if (
      n[0] * n[0] + n[1] * n[1] > m * m ||
      (blocked !== undefined && blocked(eye[0]! + n[0], eye[1]!, eye[2]! + n[1]))
    ) {
      this.fallbacks++;
      return false;
    }
    this.offset[0] = n[0];
    this.offset[1] = n[1];
    this.turns++;
    return true;
  }

  /** Each frame, with the body's eye: a carry the game now refuses is dropped. */
  check(eye: ArrayLike<number>, blocked: PivotBlocked): void {
    if (this.offset[0] === 0 && this.offset[1] === 0) return;
    if (blocked(eye[0]! + this.offset[0], eye[1]!, eye[2]! + this.offset[1])) {
      this.drops++;
      this.reset();
    }
  }

  reset(): void {
    this.offset[0] = 0;
    this.offset[1] = 0;
  }
}
