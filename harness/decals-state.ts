/**
 * What the decals page (harness/decals.html) publishes on `window.__harnessDecals` for
 * e2e/decals.spec.ts. Shared by the page (harness/decals.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface DecalProbe {
  x: number;
  y: number;
}

export interface HarnessDecalsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The mode asked for (`?mode=box|quad`, default `auto`). */
  requested: string;
  /** `Decals.activeMode` of the last frame: 'box' or 'quad' (null before the first). */
  mode: string | null;
  /** `Decals.capacity`. */
  capacity: number;
  /** `Decals.count`: live decals. */
  count: number;
  /** Screen position (logical px) of the centre of the oldest live decal added through the api. */
  decalPixel: DecalProbe;
  /** Screen position of a bare floor point no decal covers, lit like the decal spot. */
  floorPixel: DecalProbe;
  /** Ages (seconds) of the live decals added through the api, oldest first. */
  ages: number[];
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessDecalsApi {
  state: HarnessDecalsState;
  /**
   * `Decals.add` at a world point facing along a normal: `size` world units, atlas `tile`
   * (0 ring, 1 splat, 2 cross, 3 square), `color` and `lifetime` (seconds, default forever).
   * Returns the handle.
   */
  add(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    size: number,
    tile?: number,
    color?: [number, number, number, number],
    lifetime?: number,
  ): number;
  /** Place a decal where the pointer ray through a logical-px point hits the floor or a block. */
  placeAt(sx: number, sy: number): number;
  remove(handle: number): boolean;
  has(handle: number): boolean;
  clear(): void;
}

declare global {
  interface Window {
    __harnessDecals?: HarnessDecalsApi;
  }
}
