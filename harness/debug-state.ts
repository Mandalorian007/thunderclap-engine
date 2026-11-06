/**
 * What the debug-draw page (harness/debug.html) publishes on `window.__harnessDebug` for
 * e2e/debug.spec.ts. Shared by the page (harness/debug.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface DebugProbe {
  x: number;
  y: number;
}

export interface HarnessDebugState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `DebugDraw.count` as recorded this frame, before `draw` cleared it. */
  segments: number;
  /** `DebugDraw.uploads`: `writeBuffer` calls so far. */
  uploads: number;
  /** `DebugDraw.capacity` (segments). */
  capacity: number;
  /** Whether the page appends its shapes this frame. */
  shapes: boolean;
  /** Whether the box, sphere and arrow move (`?still` parks them). */
  spinning: boolean;
  /**
   * Screen position (logical px) of a point on the +x axis line (`axes` at the origin), where
   * a red pixel is drawn over the clear colour and no grid line crosses.
   */
  probes: { axis: DebugProbe };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessDebugApi {
  state: HarnessDebugState;
  /** Append (true) or skip (false) every shape; `draw` still runs each frame. */
  setShapes(on: boolean): void;
  /** Move (true) or park (false) the box, sphere and arrow. */
  setSpinning(on: boolean): void;
  /** `DebugDraw.clear()`. */
  clear(): void;
}

declare global {
  interface Window {
    __harnessDebug?: HarnessDebugApi;
  }
}
