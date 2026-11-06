/**
 * What the render-4 page (harness/render4.html) publishes on `window.__harnessRender4` for
 * e2e/render4.spec.ts. Shared by the page (harness/render4.ts) and the spec.
 */

/** The page's modes, one per flag (`?jitter`, `?aux`, `?ranges`, `?depth-test-off`). */
export type Render4Mode = 'jitter' | 'aux' | 'ranges' | 'depth-test-off';

export interface HarnessRender4State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  mode: Render4Mode;
  /** The scene target's size in texture px (what the jitter is measured against). */
  target: { width: number; height: number };
  /**
   * `?jitter`: how far, in target px, the quad's centre moved between the last two frames as
   * projected through the camera (`worldToScreen`). The page alternates `setJitter(±0.25,
   * ±0.25)`, so with the jitter applied this is √0.5 ≈ 0.71; 0 when it is not.
   */
  shiftPx: number;
  /** `PostInputs.view.jitter` of the last frame (`[0, 0]` when no jitter was applied). */
  jitter: [number, number];
  /**
   * `?aux`: the `rg8unorm` rough-metal attachment sampled under the gradient quad at `u = 0.75`
   * (roughness, metalness), read back through the page's debug blit; null before the first
   * readback.
   */
  roughSample: [number, number] | null;
  /** `?aux`: the `rg16float` velocity attachment sampled at the moving cube's centre (uv/frame). */
  velocitySample: [number, number] | null;
  /** `?aux`: the largest `|velocitySample|` seen so far (the cube turns around twice a cycle). */
  velocityPeak: number;
  /** `renderer.stats` of the last frame. */
  drawCalls: number;
  instances: number;
  /**
   * `?depth-test-off`: the scene colour at the panel's centre reads the panel's green tint
   * (through the debug blit), not the red cube it sits inside; null before the first readback.
   */
  panelVisible: boolean | null;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
  /** Readbacks completed. */
  readbacks: number;
}

export interface HarnessRender4Api {
  state: HarnessRender4State;
}

declare global {
  interface Window {
    __harnessRender4?: HarnessRender4Api;
  }
}
