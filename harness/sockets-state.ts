/**
 * What the sockets demo page (harness/sockets.html) publishes on `window.__harnessSockets` for
 * e2e/sockets.spec.ts. Shared by the page (harness/sockets.ts) and the spec.
 */

export type Vec3 = [number, number, number];

export interface HarnessSocketsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number };
  /** True while `setPaused(true)` parks the animation and the rig's turn (E-017). */
  paused: boolean;
  /** The cube attached by index to the end joint: its socket's world position and the joint's. */
  socketWorldPos: Vec3;
  jointWorldPos: Vec3;
  /** `|offset.position|` of that socket: the distance the two positions must keep. */
  offsetLength: number;
  /** The cube attached by name: the node the name resolved to, its socket and joint positions. */
  namedJoint: number;
  namedSocketWorldPos: Vec3;
  namedJointWorldPos: Vec3;
  namedOffsetLength: number;
}

export interface HarnessSocketsApi {
  state: HarnessSocketsState;
  /** Park (or resume) every time-driven motion on the page, so a spec can read a still value. */
  setPaused(paused: boolean): void;
}

declare global {
  interface Window {
    __harnessSockets?: HarnessSocketsApi;
  }
}
