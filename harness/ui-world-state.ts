/**
 * What the ui-world page (harness/ui-world.html) publishes on `window.__harnessUiWorld` for
 * e2e/ui-world.spec.ts. Shared by the page (harness/ui-world.ts) and the spec.
 */

export type UiWorldPoint = [number, number, number];

export interface UiWorldState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  frames: number;
  /** `?stereo`: two eyes, one per half of the canvas; else one camera and the page's DOM copy. */
  stereo: boolean;
  /** Every panel event so far, `id:row:type:value`. */
  events: string[];
  /** The model's keys the presses move. */
  model: { mute: boolean; vol: number; say: string; tab: string; uses: number; log: number };
  /** `viewProjection` per camera (column-major): one, or the two eyes. */
  viewProjections: number[][];
  /** Each camera's `screen` as a fraction of the canvas. */
  screens: { x: number; y: number; width: number; height: number }[];
  /** World point of each word's centre on the quad, by `id` or `id:row`. */
  quad: Record<string, UiWorldPoint>;
  /** World point of each word's centre on the head screen (the HUD and the modal). */
  screen: Record<string, UiWorldPoint>;
  /** The quad presenter's paints (it holds still while nothing changes). */
  paints: number;
  /** Texture uploads over both world panels. */
  uploads: number;
  /** The modal on the head screen is open. */
  modalOpen: boolean;
  /** The focused word on the quad (`id` or `id:row`, '' for none). */
  quadFocus: string;
  gpuErrors: number;
}

export interface UiWorldApi {
  state(): UiWorldState;
  /** Put the model back to its seed and clear `events`. */
  reset(): void;
}

declare global {
  interface Window {
    __harnessUiWorld?: UiWorldApi;
  }
}
