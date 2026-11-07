/**
 * What the render-7 page (harness/render7.html) publishes on `window.__harnessRender7` for
 * e2e/render7.spec.ts. Shared by the page (harness/render7.ts) and the spec.
 */

/**
 * The page's modes, one per flag (`?lod-keys`, the default, `?instanced-velocity`, or
 * `?single-velocity`, ws/render-8).
 */
export type Render7Mode = 'lod-keys' | 'instanced-velocity' | 'single-velocity';

export interface HarnessRender7State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  mode: Render7Mode;
  /**
   * `?still`: `?instanced-velocity`'s moving rocks are parked (the churn goes on), or
   * `?single-velocity`'s rock.
   */
  still: boolean;
  /** False with `&unkeyed`: the list carries no keys (the control: memory goes by index). */
  keyed: boolean;
  /** `renderer.stats.instances` / `drawCalls` / `lodCounts` of the last frame. */
  instances: number;
  drawCalls: number;
  lodCounts: number[];
  /** Swap-remove-and-append reorders of the list since load (one per frame, both modes). */
  churns: number;
  /**
   * `?lod-keys`: times a rock's level (`renderer.lodLevelOf`, followed by rock, not slot)
   * changed from one frame to the next since the last `reset()`. The rocks never move, so it
   * stays 0 when the level memory follows the key.
   */
  levelChanges: number;
  /**
   * `?instanced-velocity`: the mean |velocity| (uv per frame) at the moving rocks' centres and
   * at the static rocks' centres, over the readbacks since the last `reset()`, and the largest
   * single static sample since then. `?single-velocity`: the same at points on the one
   * sliding rock and at background points.
   */
  velocityMoving: number;
  velocityStatic: number;
  velocityStaticPeak: number;
  /** The velocity modes: probe readbacks since the last `reset()`. */
  readbacks: number;
  /** The rocks' screen rect in logical px (the screenshot clip), and the logical size. */
  window: { x: number; y: number; width: number; height: number };
  logical: { width: number; height: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessRender7Api {
  state: HarnessRender7State;
  /** Zero `levelChanges` and the velocity means; returns `state.frames` (read in the same call). */
  reset(): number;
}

declare global {
  interface Window {
    __harnessRender7?: HarnessRender7Api;
  }
}
