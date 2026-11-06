/**
 * What the finishing post page (harness/post2.html) publishes on `window.__harnessPost2` for
 * e2e/post2.spec.ts. Shared by the page (harness/post2.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface Post2Point {
  x: number;
  y: number;
}

/** The finishing passes `?pass=` can switch on, one at a time; `none` is the baseline. */
export type Post2Pass = 'none' | 'fxaa' | 'lut' | 'grain' | 'aberration' | 'sharpen' | 'outline';

export interface HarnessPost2State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The pass the query switched on. */
  pass: Post2Pass;
  /** Labels of the post passes the stack recorded last frame, in order. */
  passes: string[];
  /** Whether the stack was handed a depth buffer last frame. */
  depth: boolean;
  /**
   * Where the spec measures, logical px, recomputed every frame. `edge`: the cube's right
   * silhouette against the backdrop, from its top vertex to its bottom one (the spec walks rows
   * across it for `edgeContrast`, `aberrationSplit` and `outlineHits`). `face`: the centre of
   * the cube's brighter visible face, a flat patch for `lutShift` and `grainVariance`;
   * `faceHalf` is half the side of the patch that stays inside the face.
   */
  probes: {
    edge: { top: Post2Point; bottom: Post2Point };
    face: Post2Point;
    faceHalf: number;
  };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessPost2Api {
  state: HarnessPost2State;
}

declare global {
  interface Window {
    __harnessPost2?: HarnessPost2Api;
  }
}
