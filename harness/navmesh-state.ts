/**
 * What the navmesh page (harness/navmesh.html) publishes on `window.__harnessNavmesh` for
 * e2e/navmesh.spec.ts. Shared by the page (harness/navmesh.ts) and the spec.
 */

export interface HarnessNavmeshState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** Polygons in the baked mesh. */
  polyCount: number;
  /** Wall-clock time of `bakeNavMesh` on this page, ms. */
  bakeMs: number;
  /** Whether `findMeshPath` reached the goal from the start. */
  pathFound: boolean;
  /** `pathDistance3` of the current path (world units). */
  pathLength: number;
  /** The path's waypoints, `x, y, z` per point. */
  pathPoints: number[];
  /** Whether the current path crosses the off-mesh "jump down" link. */
  linkUsed: boolean;
  /** The link's traversal cost (`setLinkCost`). */
  linkCost: number;
  /** Agents in the crowd (`?crowd=N`, default 0). */
  crowd: number;
  /** Fixed steps the crowd has taken. */
  crowdSteps: number;
  /**
   * Agent pairs found closer than the sum of their radii (minus 1 cm) over every step so far.
   * Cumulative: once it reads 0 after some seconds, no step ever overlapped.
   */
  crowdOverlaps: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessNavmeshApi {
  state: HarnessNavmeshState;
  /** Move the path's goal (a click does the same with the point under the pointer). */
  setGoal(x: number, y: number, z: number): void;
  /** Move the path's start. */
  setStart(x: number, y: number, z: number): void;
  /** Set the off-mesh link's cost and replan. */
  setLinkCost(cost: number): void;
  /** `NavMesh.findNearestPoly` within `radius`: the polygon index, or -1. */
  probeNearest(x: number, y: number, z: number, radius: number): number;
  /** `NavMesh.height(x, z)`: NaN off the mesh. */
  probeHeight(x: number, z: number): number;
  /** Move the crowd's target (the pointer does the same while it moves over the floor). */
  setCrowdTarget(x: number, z: number): void;
}

declare global {
  interface Window {
    __harnessNavmesh?: HarnessNavmeshApi;
  }
}
