/**
 * What the morph targets demo page (harness/morph.html) publishes on `window.__harnessMorph`
 * for e2e/morph.spec.ts. Shared by the page (harness/morph.ts) and the spec.
 */

export interface HarnessMorphState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `GltfMorph.targetCount` of the sphere (2: squash, bulge). */
  targetCount: number;
  /** The sphere's current morph weights, as sampled from the clip this frame. */
  weights: number[];
  /** How many times `apply()` reported a change (and so a vertex buffer upload). */
  applied: number;
  /** The clip's duration in seconds; the page loops `time % duration`. */
  duration: number;
  /** Clip time this frame, seconds. */
  time: number;
  /** The sphere mesh's bounds as the renderer holds them (recomputed on each upload). */
  bounds: { center: [number, number, number]; radius: number };
  /**
   * Screen position (logical px) of the world point (0, 1.2, 0): above the resting sphere's
   * silhouette, inside the bulged one, well outside the squashed one.
   */
  probe: { x: number; y: number };
  /** The frame's linear clear colour, so the spec knows what "background" looks like. */
  clear: [number, number, number];
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessMorph?: { state: HarnessMorphState };
  }
}
