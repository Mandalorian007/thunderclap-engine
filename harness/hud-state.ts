/**
 * What the HUD demo page (harness/hud.html) publishes on `window.__harnessHud` for
 * e2e/hud.spec.ts. Shared by the page (harness/hud.ts) and the spec.
 */
export interface HarnessHudState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** The draining meter's value (0..100), as the page last set it. */
  meterValue: number;
  /** The selected slot index. */
  selected: number;
  /** The orbiting camera's yaw, radians, as handed to `heading.setYaw`. */
  yaw: number;
  /** The heading strip's offset for that yaw (theme px). */
  headingOffset: number;
  /** `reticle.visible` and not hidden by a modal (`data-modal` absent). */
  reticleVisible: boolean;
  /** `ui.stack.hasModal`. */
  modal: boolean;
  /** Time-driven motion (orbit, drain, slot cycling) is parked. */
  parked: boolean;
}

export interface HarnessHudApi {
  state: HarnessHudState;
  /** Open (or close) a modal panel through the overlay's stack. */
  openModal(): void;
  closeModal(): void;
  /** Park or resume the time-driven motion (E-017). */
  park(on: boolean): void;
  /** `reticle.pulse()`; returns whether the pulse class is on right after. */
  pulse(): boolean;
}

declare global {
  interface Window {
    __harnessHud?: HarnessHudApi;
  }
}
