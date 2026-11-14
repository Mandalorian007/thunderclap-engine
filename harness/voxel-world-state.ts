/**
 * What the voxel-world page (harness/voxel-world.html) publishes on `window.__harnessVoxelWorld`
 * for e2e/voxel-world.spec.ts. Shared by the page (harness/voxel-world.ts) and the spec.
 */
export interface HarnessVoxelWorldState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Sections held around the camera (`?radius=N`, default 16). */
  radius: number;
  /** Mesher Workers. */
  workers: number;
  /** Frames presented. */
  frames: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
  /** Every section put, meshed and uploaded (`world.settled` with the generator done). */
  settled: boolean;
  /** Frames and ms from the first frame to settled. */
  settleFrames: number;
  settleMs: number;
  /** `world.stats`: sections held, drawn, hidden by cave culling, quads per stream. */
  sections: number;
  drawn: number;
  hidden: number;
  opaqueQuads: number;
  foliageQuads: number;
  liquidQuads: number;
  vertexBytes: number;
  /** The core's GPU calls this frame, and the most in any frame since settled. */
  calls: number;
  heldCalls: number;
  /** Bundles executed and compute dispatches this frame; bundles recorded so far. */
  bundles: number;
  dispatches: number;
  bundleBuilds: number;
  /**
   * The longest page time of a frame while streaming (generating and putting sections,
   * `world.update`, `core.prepare` and `draw`), ms; and of `world.update` alone.
   */
  maxStreamFrameMs: number;
  maxUpdateMs: number;
  /** Median page ms of a frame over the last 60 frames. */
  cpuMs: number;
}

declare global {
  interface Window {
    __harnessVoxelWorld?: { state: HarnessVoxelWorldState };
  }
}
