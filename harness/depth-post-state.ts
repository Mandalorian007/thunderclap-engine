/**
 * What the depth post page (harness/depth-post.html) publishes on `window.__harnessDepthPost`
 * for e2e/depth-post.spec.ts. Shared by the page (harness/depth-post.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface DepthPostProbe {
  x: number;
  y: number;
}

export interface HarnessDepthPostState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `post.settings.ao.enabled` / `dof.enabled` after the query switches (`?ao=0`, `?dof=0`). */
  aoEnabled: boolean;
  dofEnabled: boolean;
  /** Labels of the post passes the stack recorded last frame, in order (`post-ao`, ...). */
  passes: string[];
  /** Whether the stack was handed a depth buffer last frame (`PostInputs.depth !== null`). */
  depth: boolean;
  /**
   * Screen positions (logical px) of world points, recomputed every frame. `near` and `far`
   * are the mesh page's (the near block's front face, the far block above it). `crease`: ground
   * at the foot of the far block's front face, inside the AO radius. `farGroundA` / `B`: two
   * patches of far ground either side of a checker edge, out of focus, for DoF contrast.
   * `ground`: open ground near the eye, in focus and away from any wall.
   */
  probes: {
    near: DepthPostProbe;
    far: DepthPostProbe;
    crease: DepthPostProbe;
    farGroundA: DepthPostProbe;
    farGroundB: DepthPostProbe;
    ground: DepthPostProbe;
  };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessDepthPostApi {
  state: HarnessDepthPostState;
}

declare global {
  interface Window {
    __harnessDepthPost?: HarnessDepthPostApi;
  }
}
