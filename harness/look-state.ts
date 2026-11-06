/**
 * What the look controls page (harness/look.html) publishes on `window.__harnessLook` for
 * e2e/look.spec.ts. Shared by the page (harness/look.ts) and the spec.
 */

export interface HarnessLookState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** The first-person view: yaw (+ turns right) and pitch (+ looks up), radians. */
  yaw: number;
  pitch: number;
  /** The eye, world units. Starts at (0, 1.6, 8) looking down -z. */
  position: [number, number, number];
  /** `look.locked`. */
  locked: boolean;
  /** `look.stick.active`: a touch is driving the move stick. */
  stick: boolean;
  /** `renderer.stats.instances` of the last frame. */
  instances: number;
  /** `renderer.stats.culled` of the last frame (mesh draws outside the frustum, ws/cull). */
  culled: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessLookApi {
  state: HarnessLookState;
  /** `look.request()` (outside a user gesture the browser normally refuses it). */
  request(): Promise<boolean>;
  /** `look.release()`. */
  release(): void;
}

declare global {
  interface Window {
    __harnessLook?: HarnessLookApi;
  }
}
