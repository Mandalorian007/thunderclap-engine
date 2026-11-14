/**
 * What the stereo page (harness/stereo.html) publishes on `window.__harnessStereo` for
 * e2e/stereo.spec.ts (ws/xr-merge). Shared by the page and the spec.
 */
export interface HarnessStereoState {
  /** True once the page booted and entered the emulated session (or failed). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** `ctx.xr.active`. */
  active: boolean;
  /** XR frames rendered (counted in `hooks.afterRender` while the session runs). */
  frames: number;
  /** Frames the emulator copied onto the mirror canvas. */
  mirrored: number;
  /** The most cull dispatches the core ran in any one XR frame, and in the last one. */
  maxDispatches: number;
  dispatches: number;
  /** Eye views in the core's cull group last frame, and their eye positions (metres). */
  views: number;
  eyes: [number, number, number][];
  /** Core passes drawn last frame (one per eye). */
  draws: number;
  /** The mirror canvas size (both eyes side by side). */
  mirror: { width: number; height: number };
  gpuErrors: number;
  /** `?passes=1` (ws/core-passes): the sun's shadow and post per eye. */
  passes: boolean;
  /** Core shadow passes last frame (one for both eyes with `passes`). */
  shadowPasses: number;
  /** Post resolves last frame (one per eye with `passes`). */
  resolves: number;
}

declare global {
  interface Window {
    __harnessStereo?: { state: HarnessStereoState };
  }
}
