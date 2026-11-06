/**
 * What the nav-4 harness page (harness/nav4.html) publishes on `window.__harnessNav4` for
 * e2e/nav4.spec.ts. Shared by the page (harness/nav4.ts) and the spec.
 */

export type Nav4Mode = 'crowd' | 'queue' | 'areas' | 'flow3';

export interface HarnessNav4State {
  ready: boolean;
  /** `'crowd'` (the default page), `'queue'`, `'areas'` or `'flow3'`. */
  mode: Nav4Mode;
  /** Fixed steps run so far (rAF and `advance` alike). */
  ticks: number;
  /** Simulated seconds (`ticks / 60`). */
  simTime: number;
  /** `?still`: the animation loop does not step (`advance` does). */
  still: boolean;
  logical: { width: number; height: number };
  /** The stage's letterbox rect in CSS px, relative to the page. */
  rect: { x: number; y: number; width: number; height: number; scale: number };
  /** The baked mesh (every mode but `?queue`): polygons, bake time and the current version. */
  polyCount: number;
  bakeMs: number;
  meshVersion: number;
  /** `?crowd`: agents in the crowd, those standing on a polygon, those at their target, and corridor replans. */
  agents: number;
  onMesh: number;
  reached: number;
  replans: number;
  /** `?crowd&carve`: true once the obstacle was applied (at 2 s of sim time). */
  carved: boolean;
  /** `?queue`: requests issued and dropped (queue full), tickets pending and finished, failed tickets, and `update()` times. */
  requested: number;
  dropped: number;
  pending: number;
  doneTotal: number;
  failedTotal: number;
  lastUpdateMs: number;
  maxUpdateMs: number;
  /** `?areas`: the probe path's length with mud priced at 3× and with every area at 1. */
  lengthMud: number;
  lengthPlain: number;
  /** `?areas`: polygons stamped as mud. */
  mudPolys: number;
  /** `?flow3`: walkers within half a unit of the goal, and polygons the field reached. */
  arrived: number;
  fieldReached: number;
}

export interface HarnessNav4Api {
  state: HarnessNav4State;
  /** Runs `steps` fixed 1/60 s steps now. */
  advance(steps: number): void;
}

declare global {
  interface Window {
    __harnessNav4?: HarnessNav4Api;
  }
}
