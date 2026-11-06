/**
 * `@thunderclap/engine/nav`: grid navigation on the XZ plane. A `NavGrid` of walkable cells with
 * costs, A* (`findPath`) and string pulling (`smoothPath`) into a reusable `NavPath`, a flow
 * field one build serves every agent with, a path follower and local steering. Pure CPU, no
 * imports from other engine modules, no allocation per query after warm-up.
 */
export type { FindPathOptions } from './astar';
export { findPath, smoothPath } from './astar';
export type { Crowd, CrowdAgent, CrowdAgentOptions, CrowdOptions } from './crowd';
export { createCrowd } from './crowd';
export type { FlowField } from './flow';
export { createFlowField } from './flow';
export type { Cell, NavGrid, NavGridOptions, NavPoint } from './grid';
export { createNavGrid, hasLineOfWalkable } from './grid';
export type { OffMeshLink, OffMeshLinkOptions } from './mesh/links';
export { addOffMeshLink, getOffMeshLink, removeOffMeshLink } from './mesh/links';
export type { FindMeshPathOptions, NavPath3, NavPathLink } from './mesh/mesh-path';
export {
  clearPath3,
  createNavPath3,
  findMeshPath,
  followPath3,
  pathDistance3,
  pathPoint3,
  reservePath3,
} from './mesh/mesh-path';
export type { NavBounds, NavPoint3 } from './mesh/navmesh';
export { bakeNavMesh, NavMesh } from './mesh/navmesh';
export { exportNavMesh, importNavMesh } from './mesh/serialize';
export type { NavBakeOptions, NavBakeSource } from './mesh/voxelize';
export type { FollowResult, NavPath } from './path';
export {
  clearPath,
  createNavPath,
  followPath,
  pathDistance,
  pathPoint,
  reservePath,
} from './path';
export type { Disc } from './steer';
export { arrive, avoidDisc, separate, steer } from './steer';
