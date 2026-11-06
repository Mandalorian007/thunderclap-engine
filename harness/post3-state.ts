/**
 * What the post 3 page (harness/post3.html) publishes on `window.__harnessPost3` for
 * e2e/post3.spec.ts. Shared by the page (harness/post3.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface Post3Point {
  x: number;
  y: number;
}

/** The query flags the page honours (each switches one post-3 feature on, `still` parks the orbit). */
export interface Post3Flags {
  taa: boolean;
  ssr: boolean;
  autoexp: boolean;
  /** Kelvin from `?wb=`, or 0 for the default white balance. */
  wb: number;
  mblur: boolean;
  dirt: boolean;
  still: boolean;
}

export interface HarnessPost3State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  flags: Post3Flags;
  /** `post.exposure`: the current EV (eased in auto mode, `log2(grade.exposure)` otherwise). */
  exposure: number;
  /** `post.taaActive` / `post.ssrActive` after the last frame. */
  taaActive: boolean;
  ssrActive: boolean;
  /** `post.historyResets`. */
  historyResets: number;
  /** Labels of the post passes the stack recorded last frame, in order (render and compute). */
  passes: string[];
  /** Milliseconds of the last frame (`time.frameDt` × 1000). */
  frameMs: number;
  /**
   * Where the spec measures, logical px, recomputed every frame. `edge`: the grey block's right
   * silhouette against the dark backdrop, top to bottom (TAA: rows across it over frames).
   * `floor`: a point on the mirror floor whose reflection of the eye lands on the sky patch
   * (SSR). `grey`: the centre of the grey block's front face, `greyHalf` the half side of the
   * patch inside it (white balance). `bloom`: a point in the sky patch's halo on the backdrop,
   * `bloomHalf` the half side of a patch wide enough to hold several lens-dirt spots (dirt).
   */
  probes: {
    edge: { top: Post3Point; bottom: Post3Point };
    floor: Post3Point;
    grey: Post3Point;
    greyHalf: number;
    bloom: Post3Point;
    bloomHalf: number;
  };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessPost3Api {
  state: HarnessPost3State;
}

declare global {
  interface Window {
    __harnessPost3?: HarnessPost3Api;
  }
}
