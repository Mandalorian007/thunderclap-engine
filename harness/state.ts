/**
 * What the harness page publishes on `window.__harness` for the engine e2e specs.
 * Shared by the page (harness/main.ts) and the specs (e2e/), so both agree on the shape.
 */
export interface HarnessTap {
  /** Logical (design-space) position of the press. */
  x: number;
  y: number;
  /** `Input.lastDevice` at the press. */
  device: string;
}

export interface HarnessState {
  /** True once boot finished (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', or the boot failure reason. */
  gpu: string;
  /** Swapchain format when `gpu === 'ok'`. */
  format: string | null;
  /** `window !== window.top`. */
  embedded: boolean;
  /** Rendered frames (each one clears and presents the swapchain). */
  frames: number;
  /** `Surface.onResize` calls (the first fires on subscribe). */
  resizes: number;
  /** Surface letterbox rect, CSS px relative to the root. */
  rect: { x: number; y: number; width: number; height: number; scale: number };
  /** Root (container) size, CSS px. */
  container: { width: number; height: number };
  /** Surface backbuffer, device px. */
  backbuffer: { width: number; height: number; pixelRatio: number };
  /** Size of the last presented swapchain texture. */
  presented: { width: number; height: number };
  /** Every `tap` action press, in order. */
  taps: HarnessTap[];
}

declare global {
  interface Window {
    __harness?: HarnessState;
  }
}
