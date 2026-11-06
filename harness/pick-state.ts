/**
 * What the pick page (harness/pick.html) publishes on `window.__harnessPick` for
 * e2e/pick.spec.ts. Shared by the page (harness/pick.ts) and the spec.
 */

export interface HarnessPickState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** Id of the mesh the last select landed on, or `null` (sky, or no select yet). */
  hit: string | null;
  /** World point of that hit, or `null`. */
  hitPoint: [number, number, number] | null;
  /** World normal of that hit, or `null`. */
  hitNormal: [number, number, number] | null;
  /** World distance of that hit, or 0. */
  hitDistance: number;
  /** Selects seen (hits and sky alike). */
  selects: number;
  /** Id of the mesh under the primary pointer now, or `null`. */
  hover: string | null;
  /** Screen position (logical px) of each mesh's centre, recomputed every frame. */
  screenPositions: Record<string, { x: number; y: number }>;
  /** `renderer.stats.instances` and `renderer.stats.culled` of the last frame. */
  instances: number;
  culled: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessPickApi {
  state: HarnessPickState;
  /** Forget the last select (`hit` back to `null`, `selects` to 0). */
  clear(): void;
}

declare global {
  interface Window {
    __harnessPick?: HarnessPickApi;
  }
}
