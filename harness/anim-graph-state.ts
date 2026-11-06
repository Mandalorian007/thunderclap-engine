/**
 * What the animation graph page (harness/anim-graph.html) publishes on `window.__harnessAnimGraph`
 * for e2e/anim-graph.spec.ts. Shared by the page (harness/anim-graph.ts) and the spec.
 */

export interface HarnessAnimGraphState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** Fixed-step updates run. */
  updates: number;
  /** `graph.state`: `'move'` (the 1D blend space) or `'jump'`. */
  state: string;
  /** The `speed` parameter, 0..1. */
  speed: number;
  /**
   * Effective mixer weights of the `move` state's three clips (idle, walk, run), in `at` order.
   * They sum to `graph.weight('move')`: 1 once a fade into `move` has settled.
   */
  weights: [number, number, number];
  /** `graph.weight('jump')`. */
  jumpWeight: number;
  /** `graph.phase('move')`: the shared normalised phase of the blend space. */
  phase: number;
  /** Times `jump` was entered (`onEnter('jump')`). */
  jumps: number;
  /** Times `move` was entered (`onEnter('move')`): the exit-time transition back from `jump`. */
  returns: number;
  /** Whether the page drives `speed` and pulses `jump` itself (E-017: parked by the spec). */
  auto: boolean;
  /** `renderer.stats.instances` of the last frame. */
  instances: number;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessAnimGraphApi {
  state: HarnessAnimGraphState;
  /** Keep (true) or stop (false) cycling `speed` 0→1→0 and pulsing `jump`. */
  setAuto(on: boolean): void;
  /** Set the `speed` parameter (meaningful with `auto` off). */
  setSpeed(speed: number): void;
  /** Pulse the `jump` parameter: true until the graph enters `jump`. */
  jump(): void;
}

declare global {
  interface Window {
    __harnessAnimGraph?: HarnessAnimGraphApi;
  }
}
