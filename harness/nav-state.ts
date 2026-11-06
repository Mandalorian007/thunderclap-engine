/**
 * What the nav harness page (harness/nav.html) publishes on `window.__harnessNav` for
 * e2e/nav.spec.ts. Shared by the page (harness/nav.ts) and the spec.
 */

export interface NavAgentInfo {
  /** World position (logical stage px: world x is stage x, world z is stage y). */
  x: number;
  z: number;
  /** Within three cells of the goal; sticky until the goal moves. */
  arrived: boolean;
}

export type NavHarnessMode = 'flow' | 'reach' | 'multi';

export interface HarnessNavState {
  ready: boolean;
  /** `'flow'` (the default page), `'reach'` (`?reach`) or `'multi'` (`?multi`). */
  mode: NavHarnessMode;
  /** Fixed steps run so far (rAF and `advance` alike). */
  ticks: number;
  /** Simulated seconds (`ticks / 60`). */
  simTime: number;
  logical: { width: number; height: number };
  /** The stage's letterbox rect in CSS px, relative to the page. */
  rect: { x: number; y: number; width: number; height: number; scale: number };
  grid: { width: number; height: number; cellSize: number };
  /** Unwalkable cells. */
  walls: number;
  gridVersion: number;
  /** The goal cell. */
  goal: { x: number; y: number };
  agents: NavAgentInfo[];
  /** Agents with `arrived` set. */
  arrived: number;
  /** The probe path (A* then string pulling) from `pathStart` to the goal. */
  pathStart: { x: number; y: number };
  pathFound: boolean;
  /** Waypoints after smoothing (0 when none). */
  pathLength: number;
  /** Waypoints A* gave before smoothing. */
  rawPathLength: number;
  /** World length of the smoothed path. */
  pathDistance: number;
  /** Milliseconds the last flow-field build took (`performance.now`). */
  buildMs: number;
  /** Flow-field builds so far (`update()` calls included). */
  builds: number;
  /** The grid's neighbourhood in use (`?reach` toggles it; 8 elsewhere). */
  neighbours: 4 | 8;
  /** `?reach`: the budget, the cells reached from the start, the hovered cell and its path. */
  budget: number;
  reachCount: number;
  reachStart: { x: number; y: number };
  hover: { x: number; y: number };
  /** Waypoints of the hovered cell's path from the start (0 when out of reach). */
  hoverPathLength: number;
  /** Milliseconds the last `reachable` (or multi-goal `update`) query took. */
  queryMs: number;
  /** `?multi`: the goal cells, row-major indices, and whether the field lags the grid. */
  goals: number[];
  fieldStale: boolean;
}

export interface HarnessNavApi {
  state: HarnessNavState;
  /** Moves the goal to a cell (as a click does), rebuilds the field and the probe path. */
  setGoal(cx: number, cy: number): void;
  /** Flips a cell between wall and floor, then rebuilds (`?multi`: the next step rebuilds). */
  toggleWall(cx: number, cy: number): void;
  /** Runs `steps` fixed steps now (1/60 s each), independent of the frame rate. */
  advance(steps: number): void;
  /** Agents back to their start positions, not arrived; the goal and walls stay. */
  reset(): void;
  /** `?reach`: the move budget (the slider), then a new query. */
  setBudget(budget: number): void;
  /** `?reach`: 4 or 8 neighbours (the toggle), then a new query. */
  setNeighbours(n: 4 | 8): void;
  /** `?reach`: the hovered cell; its path from the start is drawn. */
  hover(cx: number, cy: number): void;
  /** `?multi`: the field's direction and distance at a cell. */
  fieldAt(cx: number, cy: number): { x: number; z: number; distance: number };
}

declare global {
  interface Window {
    __harnessNav?: HarnessNavApi;
  }
}
