/**
 * `@thunderclap/engine/nav`: grid navigation on the XZ plane. A `NavGrid` of walkable cells with
 * costs (and an edge-cost hook, 4 or 8 neighbours), A* (`findPath`) and string pulling
 * (`smoothPath`) into a reusable `NavPath`, a flow field one build serves every agent with,
 * budget-bounded reachability with parents (`reachable`, on a grid or a `NavMesh`, with
 * `reachableOutline` for a mesh range's boundary), a path follower and local steering.
 * Pure CPU, no imports from other engine modules, no allocation per query after warm-up.
 */
export type { FindPathOptions } from './astar';
export { findPath } from './astar';
export { type Corridor, createCorridor } from './corridor';
export type {
  Crowd,
  CrowdAgent,
  CrowdAgentOptions,
  CrowdAttachOptions,
  CrowdOptions,
} from './crowd';
export { createCrowd } from './crowd';
export type { FlowDirection, FlowField, FlowFieldOptions } from './flow';
export { createFlowField } from './flow';
export type { Cell, EdgeCost, NavGrid, NavGridOptions, NavPoint } from './grid';
export { createNavGrid } from './grid';
// ws/nav-4: areas, obstacles, queue, corridors, mesh flow field.
export {
  type AreaBox,
  type AreaPolygon,
  type AreaShape,
  type AreaStamp,
  areaShapeContains,
  createAreaCosts,
  createAreaMask,
  markArea,
  OBSTACLE_AREA,
} from './mesh/areas';
export { createFlowField3, type FlowField3, type FlowField3Options } from './mesh/flow3';
export type { OffMeshLink, OffMeshLinkOptions } from './mesh/links';
export { addOffMeshLink, getOffMeshLink, removeOffMeshLink } from './mesh/links';
export type { FindMeshPathOptions, NavPath3, NavPathLink } from './mesh/mesh-path';
export {
  type AreaQueryOptions,
  areaAllowed,
  clearPath3,
  createNavPath3,
  findMeshPath,
  followPath3,
  MeshSearch,
  type MeshSearchState,
  pathDistance3,
  pathPoint3,
  pullString,
  reservePath3,
  reservePolys3,
} from './mesh/mesh-path';
export {
  createMeshReach,
  createReachOutline,
  type MeshReach,
  type MeshReachOptions,
  type ReachOutline,
  reachableOutline,
} from './mesh/mesh-reach';
export type { NavBakeAreaOptions, NavBounds, NavPoint3 } from './mesh/navmesh';
export { bakeNavMesh, NavMesh } from './mesh/navmesh';
export { exportNavMesh, importNavMesh, loadNavMesh } from './mesh/serialize';
export type { NavBakeOptions, NavBakeSource } from './mesh/voxelize';
export {
  createObstacleSet,
  type Obstacle,
  type ObstacleBox,
  type ObstacleDisc,
  type ObstacleSet,
  type ObstacleSetOptions,
  type ObstacleShape,
} from './obstacles';
export type { FollowResult, LineOfWalkableOptions, NavPath } from './path';
export {
  clearPath,
  createNavPath,
  followPath,
  hasLineOfWalkable,
  pathDistance,
  pathPoint,
  reservePath,
  smoothPath,
} from './path';
export {
  createPathQueue,
  type PathQueue,
  type PathQueueOptions,
  type PathRequestOptions,
  type PathStatus,
} from './query-queue';
export type { Reach } from './reach';
export { createReach, reachable } from './reach';
export type { Disc } from './steer';
export { arrive, avoidDisc, separate, steer } from './steer';
