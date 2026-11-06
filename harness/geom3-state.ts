/**
 * What the geometry-pipeline page (harness/geom3.html, ws/geom-3) publishes on
 * `window.__harnessGeom3` for e2e/geom3.spec.ts. Shared by the page and the spec: types only.
 *
 * Modes, by query: `?lod` (default) a rock at four distances, each drawn at the level
 * `selectLod` picks; `?hull` a torus beside its convex hull; `?slice` a cube cut by a plane that
 * sweeps through it, capped; `?tiles` a box on a tile map riding a moving platform. `?still`
 * parks the animation (it combines with any mode: `?slice&still`).
 */

export type Geom3Mode = 'lod' | 'hull' | 'slice' | 'tiles';

/** The rock's distances from the eye in `?lod`, near to far. */
export const LOD_DISTANCES = [3, 8, 20, 50] as const;
/** The projected-size thresholds (px) of the rock's chain, one per level but the last. */
export const LOD_THRESHOLDS_PX = [400, 160, 60] as const;
/** How many plane positions `?slice` precomputes and cycles through. */
export const SLICE_STEPS = 12;

export interface HarnessGeom3State {
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  mode: Geom3Mode;
  still: boolean;
  frames: number;
  /** `?lod`: the level drawn for each rock, near to far. */
  levels: number[];
  /** `?lod`: triangles in each level of the chain, level 0 first. */
  chainTriangles: number[];
  /** `?lod`: triangles drawn this frame across the four rocks. */
  triangles: number;
  /** `?hull`: the torus's triangles and its hull's. */
  sourceTriangles: number;
  hullTriangles: number;
  /** `?slice`: the plane's height, the cap triangles on both halves, both halves closed. */
  sliceD: number;
  capTriangles: number;
  closed: boolean;
  /** `?tiles`: the box stands on something; total x the platform carried it; whether it rides. */
  onGround: boolean;
  carried: number;
  riding: boolean;
  boxX: number;
  boxY: number;
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number; culled: number };
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessGeom3?: { state: HarnessGeom3State };
  }
}
