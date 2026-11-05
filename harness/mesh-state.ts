/**
 * What the mesh demo page (harness/mesh.html) publishes on `window.__harnessMesh` for
 * e2e/mesh.spec.ts. Shared by the page (harness/mesh.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface MeshProbe {
  x: number;
  y: number;
}

export interface HarnessMeshState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The orbit: yaw and pitch in radians, distance in world units, and the eye it places. */
  camera: { yaw: number; pitch: number; distance: number; eye: [number, number, number] };
  /** `renderer.camera.depthTest` / `depthWrite` as the renderer saw them. */
  depth: { test: boolean; write: boolean };
  /**
   * Screen positions (logical px) of three world points, recomputed every frame:
   * `near`: the front face of the near block; `far`: the front face of the tall far block, above
   * the near one; `ground`: a bare patch of ground. The far block is drawn after the near one
   * and is behind it, so `near` is red only if the depth test holds.
   */
  probes: { near: MeshProbe; far: MeshProbe; ground: MeshProbe };
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
  /** Ticks a zoom action was active, by source. */
  zoom: { in: number; out: number };
  /**
   * The lighting block the page hands the renderer (`frame.lights`): whether the sun has a
   * colour, how many point lights, and the circling lamp's world position (it moves each frame).
   */
  lights: { sun: boolean; points: number; lamp: [number, number, number] };
}

export interface HarnessMeshApi {
  state: HarnessMeshState;
  /** Replace the gamepad with a fake one: `axes[2..3]` is the right stick, buttons 6/7 the triggers. */
  setPad(axes: number[], pressed: number[]): void;
}

declare global {
  interface Window {
    __harnessMesh?: HarnessMeshApi;
  }
}
