/**
 * What the follow camera page (harness/follow.html) publishes on `window.__harnessFollow` for
 * e2e/follow.spec.ts. Shared by the page (harness/follow.ts) and the spec.
 */

export interface HarnessFollowState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** `follow.mode`. Starts `'third'`; key `V` toggles it. */
  mode: 'first' | 'third';
  /** The camera eye (`follow.position`), world units. */
  position: [number, number, number];
  /** `follow.currentDistance`: the orbit radius after obstacles (0 in first person). */
  distance: number;
  /** `follow.distance`: the radius wanted. */
  wanted: number;
  /** The capsule's feet, world units. Starts at the origin. */
  target: [number, number, number];
  /** `follow.yaw` and `follow.pitch`, radians. */
  yaw: number;
  pitch: number;
  /** `renderer.stats.instances` of the last frame. */
  instances: number;
  /** `renderer.stats.culled` of the last frame. */
  culled: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
  /**
   * `camera.projectMany` over the six draw centres (ground, four walls, capsule): how many
   * landed inside the viewport last frame (ws/camera-ergo).
   */
  projected: number;
  /** `camera.viewZ` of the first `frustumCorners` corner: the near distance (0.1). */
  nearCornerZ: number;
}

export interface HarnessFollowApi {
  state: HarnessFollowState;
  /** `follow.mode = mode` (what key `V` does). */
  setMode(mode: 'first' | 'third'): void;
  /** Move the capsule to (x, z) on the ground and snap the camera to it. */
  teleport(x: number, z: number): void;
  /** Set the orbit yaw, radians. */
  setYaw(yaw: number): void;
}

declare global {
  interface Window {
    __harnessFollow?: HarnessFollowApi;
  }
}
