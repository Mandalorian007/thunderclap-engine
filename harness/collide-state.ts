/**
 * What the collision page (harness/collide.html) publishes on `window.__harnessCollide` for
 * e2e/collide.spec.ts. Shared by the page (harness/collide.ts) and the spec, so this file stays
 * pure: types and the level's constants both sides evaluate.
 */

/** The capsule the 3D level drives. */
export const CAPSULE_RADIUS = 0.3;
export const CAPSULE_HALF_HEIGHT = 0.5;
/** Walking speed, world units per second. */
export const WALK_PER_S = 2.5;
/** The fixed simulation step. */
export const STEP = 1 / 60;

/**
 * The stairs: `STAIR_STEPS` of `STAIR_RISE` × `STAIR_RUN` across x -1..1, climbing along -z
 * (away from the camera) from `STAIRS_Z0`, onto a platform at their top.
 */
export const STAIR_STEPS = 5;
export const STAIR_RISE = 0.2;
export const STAIR_RUN = 0.3;
export const STAIRS_Z0 = -2;
/** The wall the capsule pushes against: its near face is the plane x = `WALL_X`, z -1..1. */
export const WALL_X = 2.75;
export const WALL_Z = 0;
/** The ramp's centre (x, z) and tilt about x (radians; the high end is toward -z). */
export const RAMP_X = -4.5;
export const RAMP_Z = 0;
export const RAMP_TILT = (20 * Math.PI) / 180;

/** The 2D corridor (`?grid`): an L of open cells in a solid grid, cell size 1, origin (0, 0). */
export const GRID_WIDTH = 9;
export const GRID_HEIGHT = 12;
/**
 * The open column (along +z, from z 0) and the open row (along +x, to `GRID_WIDTH - 2`) that
 * meet at the bend; the grid's last column stays solid so the row has an end.
 */
export const CORRIDOR_COL = 4;
export const CORRIDOR_ROW = 7;
export const CIRCLE_RADIUS = 0.3;

export interface HarnessCollideState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `'level'`: the 3D level and a capsule. `'grid'` (`?grid`): the 2D corridor and a circle. */
  mode: 'level' | 'grid';
  /** `?still`: the sim steps only through `advance`, never on a frame. */
  still: boolean;
  /** Fixed steps run so far. */
  ticks: number;
  /** The shape's centre (the circle's y is 0). */
  pos: [number, number, number];
  /** The last slide's `grounded` (always false on the grid). */
  grounded: boolean;
  /** The last slide's ground normal. */
  groundNormal: [number, number, number];
  /** The last slide's `hits`. */
  hits: number;
  /** The last slide's `hitWall`. */
  hitWall: boolean;
  /** The collider's triangle count. */
  triangleCount: number;
  /** `t` of the last probe sweep (`sweepProbe`), -1 before the first. */
  lastSweepT: number;
  /** Line segments of the wireframe drawn last frame. */
  wireLines: number;
  /** Which wireframe is drawn. */
  wire: 'triangles' | 'leaves';
  /** The move the sim applies this step, -1..1 (the stick, the keys or `setMove`). */
  move: [number, number];
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessCollideApi {
  state: HarnessCollideState;
  /** Holds a move (x right, y forward, -1..1) until the next call; `null` hands back to the devices. */
  setMove(x: number, y: number): void;
  clearMove(): void;
  /** Runs `steps` fixed steps now (1/60 s each), independent of the frame rate. */
  advance(steps: number): void;
  /** Puts the shape's centre at a point with no velocity (the circle ignores `y`). */
  teleport(x: number, y: number, z: number): void;
  /** Switches the wireframe. */
  setWire(mode: 'triangles' | 'leaves'): void;
  /** Sweeps the shape by a displacement from where it is, without moving it; returns `t` or 1. */
  sweepProbe(dx: number, dy: number, dz: number): number;
}

declare global {
  interface Window {
    __harnessCollide?: HarnessCollideApi;
  }
}
