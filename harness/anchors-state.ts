/**
 * What the anchors demo page (harness/anchors.html) publishes on `window.__harnessAnchors` for
 * e2e/anchors.spec.ts. Shared by the page (harness/anchors.ts) and the spec.
 */

/** A box in the page's client CSS px (the frame the page runs in). */
export interface AnchorsBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnchorsLabel {
  /** `label-<i>` for the cube labels, `behind` for the point behind the camera, `marker`. */
  id: string;
  /** The anchored world point. */
  world: [number, number, number];
  /** The element's bounding box (client px). Zero-sized while hidden. */
  rect: AnchorsBox;
  hidden: boolean;
  /** `data-anchor-clamped`: the clamp holds it at the viewport's edge. */
  clamped: boolean;
}

export interface HarnessAnchorsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Frames rendered. */
  frames: number;
  logical: { width: number; height: number };
  /** The canvas box (client px). */
  canvas: AnchorsBox;
  /** `camera.viewProjection` (column-major) and `camera.screen` (logical px) as of this read. */
  viewProjection: number[];
  screen: AnchorsBox;
  labels: AnchorsLabel[];
}

export interface HarnessAnchorsApi {
  /** The state as of this call (rects measured now). */
  state(): HarnessAnchorsState;
  /** Place the camera at `eye` looking at `target`. */
  aim(eye: [number, number, number], target: [number, number, number]): void;
}

declare global {
  interface Window {
    __harnessAnchors?: HarnessAnchorsApi;
  }
}
