/**
 * What the nav-5 harness page (harness/nav5.html) publishes on `window.__harnessNav5` for
 * e2e/nav5.spec.ts. Shared by the page (harness/nav5.ts) and the spec.
 */

export type Nav5Mode = 'range';

export interface HarnessNav5State {
  ready: boolean;
  /** `'range'` (the default page, also `?range`). */
  mode: Nav5Mode;
  /** Fixed steps run so far (rAF and `advance` alike). */
  ticks: number;
  /** `?still`: the animation loop does not step (`advance` does). */
  still: boolean;
  logical: { width: number; height: number };
  /** The stage's letterbox rect in CSS px, relative to the page. */
  rect: { x: number; y: number; width: number; height: number; scale: number };
  /** Polygons in the baked mesh. */
  polyCount: number;
  /** The unit's movement budget (world units, mud priced at `mudCost`). */
  budget: number;
  mudCost: number;
  /** The unit's position (on the floor). */
  unit: { x: number; z: number };
  /** Polygons in range, outline loops, and outline points, from the last range query. */
  polys: number;
  outlineLoops: number;
  outlinePoints: number;
  /** The last `reachable` + `reachableOutline` time, and the most expensive one so far. */
  ms: number;
  maxMs: number;
  /** Range queries run so far (one per step). */
  queries: number;
}

export interface HarnessNav5Api {
  state: HarnessNav5State;
  /** Runs `steps` fixed steps now (each recomputes the range). */
  advance(steps: number): void;
  /** Sets the movement budget; the next step recomputes the range. */
  setBudget(budget: number): void;
  /** Moves the unit to `(x, z)` and parks its patrol; the next step recomputes the range. */
  moveUnit(x: number, z: number): void;
}

declare global {
  interface Window {
    __harnessNav5?: HarnessNav5Api;
  }
}
