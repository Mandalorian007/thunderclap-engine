/**
 * What the world-panel page (harness/world-panel.html) publishes on `window.__harnessWorldPanel`
 * for e2e/world-panel.spec.ts. Shared by the page (harness/world-panel.ts) and the spec.
 */

/** A box in the page's client CSS px (the frame the page runs in). */
export interface WorldPanelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WorldPoint = [number, number, number];

export interface HarnessWorldPanelState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Frames rendered. */
  frames: number;
  logical: { width: number; height: number };
  /** The canvas box (client px). */
  canvas: WorldPanelBox;
  /** `camera.viewProjection` (column-major) and `camera.screen` (logical px) as of this read. */
  viewProjection: number[];
  screen: WorldPanelBox;
  /** Presses per button id (`a-button`, `a-button2`, `b-button`, `hud-button`). */
  pressed: Record<string, number>;
  /** The `a-toggle` value. */
  toggle: boolean;
  /** The `a-slider` value (0..100). */
  slider: number;
  /** The `a-list` selected row, -1 for none. */
  listSelected: number;
  /** Texture uploads summed over the three panels. */
  uploads: number;
  /** Repaints summed over the three panels. */
  repaints: number;
  /** Id of the widget under a pointer now, or null. */
  hover: string | null;
  /** Distance from the eye to the head-locked panel's centre along the view axis. */
  headLockedDistance: number;
  /** World point of the centre of each widget's rect, by id. */
  widgets: Record<string, WorldPoint>;
  /** World points of the `a-slider` track at value 0 and value 100 (the knob's travel). */
  sliderTrack: { from: WorldPoint; to: WorldPoint };
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessWorldPanelApi {
  /** The state as of this call. */
  state(): HarnessWorldPanelState;
  /** Place the camera at `eye` looking at `target`. */
  aim(eye: WorldPoint, target: WorldPoint): void;
  /** `?pad` only: set the fake gamepad the pad cursor reads (standard mapping buttons). */
  setPad(axes: number[], pressed: number[]): void;
  /** `?pad` only: put the pad cursor at logical px. */
  cursorTo(x: number, y: number): void;
}

declare global {
  interface Window {
    __harnessWorldPanel?: HarnessWorldPanelApi;
  }
}
