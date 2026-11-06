/**
 * What the geometry page (harness/geom.html) publishes on `window.__harnessGeom` for
 * e2e/geom.spec.ts. Shared by the page (harness/geom.ts) and the spec, so this file stays pure:
 * types, the ground's constants and the bump map both sides evaluate.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface GeomProbe {
  x: number;
  y: number;
}

/** The names of the primitive builders the page draws on the front row, left to right. */
export const SHAPE_NAMES = [
  'box',
  'plane',
  'sphere',
  'icosphere',
  'capsule',
  'cylinder',
  'torus',
] as const;
/** The sweep-kit shapes on the row behind, left to right (ws/geom-2). */
export const SHAPE_NAMES_2 = ['extrude', 'lathe', 'tube', 'stairs', 'arch'] as const;
/** Every shape the page draws: front row, then back row. */
export const ALL_SHAPE_NAMES = [...SHAPE_NAMES, ...SHAPE_NAMES_2] as const;
export type ShapeName = (typeof ALL_SHAPE_NAMES)[number];

/**
 * The ground: a `GROUND_SAMPLES`² heightfield, `GROUND_SPACING` world units apart, starting at
 * `GROUND_ORIGIN` on x and z, heights from `bumpHeight` at each sample. The spec reads the height
 * under the camera from the page and checks it against this map at the page's sampled point.
 */
export const GROUND_SAMPLES = 33;
export const GROUND_SPACING = 0.5;
export const GROUND_ORIGIN = -8;

/** The sine bump map, in world units: x and z in, height out. */
export function bumpHeight(x: number, z: number): number {
  return 0.35 * Math.sin(x * 0.8) * Math.cos(z * 0.6) + 0.25 * Math.sin((x + z) * 0.5);
}

export interface HarnessGeomState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** How many builder shapes the page draws (one instance each, plus the ground). */
  shapes: number;
  /** `heightAt(ground, sample.x, sample.z)`: the ground under the camera's eye. */
  heightUnderCamera: number;
  /** The x, z the page sampled for `heightUnderCamera` (a grid node of the ground). */
  sample: [number, number];
  /** Screen positions (logical px) of a point on each shape, and of the sky behind the ground. */
  probes: Record<ShapeName, GeomProbe> & { sky: GeomProbe };
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number; culled: number };
  /**
   * Tangent-space probe: `computeTangents` over the extruded star, the sum of every vertex's
   * handedness sign (`tangent.w`) and the vertex count. The star's uvs run u around and v along
   * every face, so all its frames are right-handed and the two are equal.
   */
  tangentW: number;
  tangentVertices: number;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessGeomApi {
  state: HarnessGeomState;
  /** The ground's `heightAt` at a world x, z. */
  heightAt(x: number, z: number): number;
}

declare global {
  interface Window {
    __harnessGeom?: HarnessGeomApi;
  }
}
