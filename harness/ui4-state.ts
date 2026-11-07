/**
 * What the UI 4 page (harness/ui4.html) publishes on `window.__harnessUi4` for e2e/ui4.spec.ts.
 * Shared by the page (harness/ui4.ts) and the spec.
 */
export type HarnessUi4Mode = 'floats' | 'ring' | 'compass' | 'minimap' | 'modal';

export interface HarnessUi4State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** The page's mode (from the query; `floats` by default). */
  mode: HarnessUi4Mode;
  /** Time-driven motion is parked (`?still`, or `park(true)`). */
  parked: boolean;
  /** Seconds of unparked time. */
  t: number;
  /** `?floats`: the overlay floats' `live` and `pooled`. */
  live: number;
  pooled: number;
  /** `?ring`: the ring's value (fills over 3 s, then wraps). */
  value: number;
  /** `?compass`: the compass heading (degrees) and each marker's offset from the centre, design px. */
  heading: number;
  markers: Record<string, number | null>;
  /** `?minimap`: markers held on the rim, by `markerAt`. */
  onRim: number;
  /**
   * `?minimap`: every distinct `onRim` value seen so far, in the order first seen (written on
   * the frame it happens: a count of 3 lasts about 0.37 s of each 2.6 s, too short to sample).
   */
  onRimSeen: number[];
  /** `?minimap`: the map's own rim count as drawn (`rim`), and the markers it holds. */
  rimDrawn: number;
  mapMarkers: number;
  /** `?modal`: `ui.padOwner`, the cursor's latch and how many owner transitions fired. */
  padOwner: 'stack' | 'game';
  cursorLatched: boolean;
  /** `?modal`: the cursor's latch on the frame the modal opened (true: it held right). */
  latchedBeforeModal: boolean;
  padOwnerChanges: number;
}

export interface HarnessUi4Api {
  state: HarnessUi4State;
  /** Park or resume the time-driven motion (E-017). */
  park(on: boolean): void;
  /** `?modal`: close the modal panel the page opened. */
  closeModal(): void;
  /** `?modal`: press or release a button on the page's fake gamepad (standard layout index). */
  press(button: number, down: boolean): void;
}

declare global {
  interface Window {
    __harnessUi4?: HarnessUi4Api;
  }
}
