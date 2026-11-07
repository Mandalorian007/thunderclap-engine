/**
 * What the render-10 page (harness/render10.html) publishes on `window.__harnessRender10` for
 * e2e/render10.spec.ts. Shared by the page (harness/render10.ts) and the spec.
 */

/** The scene target's aux set, one per load: `?aux=velocity` (default), `all` or `none`. */
export type Render10Aux = 'velocity' | 'all' | 'none';

export interface HarnessRender10State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  aux: Render10Aux;
  /** `renderer.target.auxKey`: bit 0 rough-metal, bit 1 velocity. */
  auxKey: number;
  /** `renderer.sceneTargets().length`: the scene pass's colour attachment count. */
  sceneTargets: number;
  /** `renderer.stats.drawCalls` / `drawables` of the last frame. */
  drawCalls: number;
  drawables: number;
  /** Live particles of the world system (`countAlive`). */
  particles: number;
  /** `gpuDiagnostics.errorCount`: GPU validation errors since load. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessRender10?: { state: HarnessRender10State };
  }
}
