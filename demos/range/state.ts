/**
 * What the range demo publishes on `window.__demo` for `e2e/demos/range.spec.ts`. Shared by the
 * page (`main.ts`) and the spec. The spec reads it through a cast, so no global `Window` type is
 * declared here (other demos publish their own shapes on the same name).
 */

export interface RangeDemoStats {
  drawCalls: number;
  instances: number;
  culled: number;
}

export interface RangeDemoState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frame: number;
  /** Running average of frames per second (exponential, from the real frame delta). */
  fps: number;
  /** `renderer.stats` of the last frame. */
  stats: RangeDemoStats;
  /** Targets knocked over so far. */
  score: number;
  /** Shots fired (hits and misses). */
  shots: number;
  /** Targets standing (12 when every one is up). */
  targetsUp: number;
  /** Index of the target the last shot hit, or null when it missed (or none fired). */
  lastHit: number | null;
  /** The unit direction the shot ray takes: the camera's forward. */
  aimDir: [number, number, number];
  /** The view: yaw (+ turns right) and pitch (+ looks up), radians. */
  yaw: number;
  pitch: number;
  /** `look.locked`: the pointer lock is held. */
  locked: boolean;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface RangeDemoApi {
  state: RangeDemoState;
  /** Set the view directly: yaw (+ turns right) and pitch (+ looks up, clamped), radians. */
  aim(yaw: number, pitch: number): void;
  /** Turn the view so the shot ray passes through target `index`'s plate centre. */
  aimAt(index: number): void;
  /** Fire one shot along the current aim (what a click, tap or trigger does). */
  fire(): void;
}

/** Number of targets on the range. */
export const TARGET_COUNT = 12;
/** Seconds a knocked-over target stays down before it rises again. */
export const RESET_SECONDS = 3;
