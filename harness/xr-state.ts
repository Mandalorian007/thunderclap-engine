/**
 * What the XR harness page (harness/xr.ts) publishes on `window.__harnessXr` for e2e/xr.spec.ts.
 * Shared by the page and the spec.
 */
export interface HarnessXrState {
  /** True once `createGame` resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Rendered frames (counted in `hooks.afterRender`). */
  frames: number;
  /** `ctx.xr.supported()`: WebXR with the WebGPU binding and an immersive-vr device. */
  supported: boolean | null;
  /** `ctx.xr.active`. */
  active: boolean;
  /** `onEnter` / `onExit` calls. */
  enters: number;
  exits: number;
  /** The last `enter()` rejection, or null. */
  lastError: string | null;
}

/** `window.__harnessXr`. */
export interface HarnessXrApi {
  state(): HarnessXrState;
  /** What the "Enter VR" button does. */
  enter(): Promise<void>;
  exit(): Promise<void>;
}

declare global {
  interface Window {
    __harnessXr?: HarnessXrApi;
  }
}
