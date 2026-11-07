/**
 * What the UI 5 page (harness/ui5.html) publishes on `window.__harnessUi5` for e2e/ui5.spec.ts.
 * Shared by the page (harness/ui5.ts) and the spec.
 */
export type HarnessUi5Mode = 'orb' | 'floats' | 'minimap';

export interface HarnessUi5State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** The page's mode (from the query; `orb` by default). */
  mode: HarnessUi5Mode;
  /** Time-driven motion is parked (`?still`, or `park(true)`). */
  parked: boolean;
  /** Seconds of unparked time. */
  t: number;
  /** `?orb`: per orb, the value over max. */
  value: number[];
  /** `?orb`: per orb, the fill's height over the well's, measured from the DOM each frame. */
  fill: number[];
  /** `?orb`: per orb, the trail band (`meter.trail`) over max. */
  trail: number[];
  /** `?orb`: per orb, the trail band's height over the well's, measured from the DOM. */
  trailDom: number[];
  /**
   * `?orb` (ws/ui-11): per orb, the frames on which the trail stood above the value, and the
   * most the drawn band fell under the model (`trail` − `trailDom`) on them. A test resets both.
   */
  trailGap: number[];
  trailFrames: number[];
  /** `?floats`: `floats.live`, `floats.pooled`, spawns so far, live labels hidden (culled). */
  active: number;
  pooled: number;
  spawned: number;
  culled: number;
  /** `?minimap`: draws so far, the last pick (world x, z) and the player. */
  redraws: number;
  pick: { x: number; z: number } | null;
  player: { x: number; z: number; yaw: number };
  /**
   * `?minimap` (ws/ui-7): the markers that carry a `heading` (an `arrow` kind): the heading set,
   * radians clockwise from north, and `markerAt(id).angle`, the turn drawn on the player-up map.
   */
  headingMarkers: { id: string; heading: number; angle: number }[];
  /** Widget ids in `ui.layout.overflows()` (ws/ui-8: empty in every mode on every row). */
  overflows: string[];
  /**
   * `?orb-rails` (ws/ui-9): the layout region each orb sits in (`left`, `right`) and the side
   * rails' widths, CSS px, as of the last re-layout. Empty and 0 in the other modes.
   */
  orbRegions: string[];
  railWidths: { left: number; right: number };
  /**
   * `?orb-sized` (ws/ui-10): per orb, its measured width and its `size` map's diameter in the
   * current form factor, both CSS px, as of the last re-layout. Empty in the other modes.
   */
  orbWidths: number[];
  orbWant: number[];
  /**
   * `?minimap-rail` (ws/ui-11): the map's region, its measured width and its `size` in CSS px,
   * as of the last re-layout. Empty and 0 in the other modes.
   */
  mapRegion: string;
  mapWidth: number;
  mapWant: number;
}

export interface HarnessUi5Api {
  state: HarnessUi5State;
  /** Park or resume the time-driven motion (E-017). */
  park(on: boolean): void;
  /** `?orb`: set orb `i` to `v` (of its max, 100). */
  setOrb(i: number, v: number): void;
  /** `?orb`: move orb `i` to a layout region (`meter.setPlace`, ws/ui-11). */
  moveOrb(i: number, region: 'top' | 'bottom' | 'left' | 'right'): void;
  /** `?minimap`: the world point under map px (u, v), from the top-left in the map's size. */
  toWorld(u: number, v: number): { x: number; z: number };
  /** `?minimap`: the map's design size. */
  mapSize: number;
}

declare global {
  interface Window {
    __harnessUi5?: HarnessUi5Api;
  }
}
