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

export interface HarnessNavState {
  ready: boolean;
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
  /** Flow-field builds so far. */
  builds: number;
}

export interface HarnessNavApi {
  state: HarnessNavState;
  /** Moves the goal to a cell (as a click does), rebuilds the field and the probe path. */
  setGoal(cx: number, cy: number): void;
  /** Flips a cell between wall and floor, then rebuilds. */
  toggleWall(cx: number, cy: number): void;
  /** Runs `steps` fixed steps now (1/60 s each), independent of the frame rate. */
  advance(steps: number): void;
  /** Agents back to their start positions, not arrived; the goal and walls stay. */
  reset(): void;
}

declare global {
  interface Window {
    __harnessNav?: HarnessNavApi;
  }
}
