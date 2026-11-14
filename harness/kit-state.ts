/**
 * What the kit page (harness/kit.html) publishes on `window.__harnessKit` for e2e/kit.spec.ts.
 * Shared by the page (harness/kit.ts) and the spec.
 */
export interface HarnessKitState {
  /** `host` (default): the loop runs on the host's frames. `client` (`?client`): the page's own rAF calls `ctx.frame(now)`. */
  mode: 'host' | 'client';
  /** True once `composeGame` resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** The ctx fields the lean kit has (sorted): the core only. */
  fields: string[];
  /** `renderer.post === null`: the built-in present pass draws. */
  postNull: boolean;
  /** Frames rendered (scene `render` calls). */
  frames: number;
  /** Fixed steps (`hooks.update`). */
  updates: number;
  /** `client` mode: `ctx.frame(now)` calls the page made. */
  driven: number;
  /** `ctx.clock.now()` (ms of game time). */
  clockMs: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessKitApi {
  state: HarnessKitState;
}

declare global {
  interface Window {
    __harnessKit?: HarnessKitApi;
  }
}
