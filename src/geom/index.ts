/**
 * `@thunderclap/engine/geom`: primitive geometry (box, plane, sphere, icosphere, capsule,
 * cylinder, torus) in the engine's 3D vertex layout with bounds, merge and transform helpers,
 * heightfields with bilinear sampling, normals, an exact ray test and a mesh builder, shapes
 * swept from 2D profiles (extrude, lathe, sweep, tube, polygon, stairs, arch), tangent frames
 * and per-geometry operations (flat shading, welding, uv projection, fitting).
 * Pure arithmetic: no GPU, no DOM; `render/` supplies only the layouts and their types.
 */

// ws/geom-3: clone, simplification and LODs, hulls and collision proxies, split and slice, the
// 2D tile slide, and the positions-only collider source.
export type {
  Aabb,
  Box2,
  Capsule,
  Circle,
  ColliderBounds,
  ColliderSource,
  ColliderTransform,
  Contact,
  GeomAabb,
  GeometryMeshSource,
  GeometrySource,
  GridSource,
  HeightfieldSource,
  Hit,
  PositionsSource,
  RayHit,
  Shape,
  Shape2,
  SlideOptions,
  SlideResult,
  SourceKind,
  SourceRecord,
  Sphere,
  StaticColliderOptions,
  SweepHit,
  TileBox,
  TileGridSource,
  TileKind,
  TileMover,
  TileQuery,
  TileSlideOptions,
  TileSlideResult,
  Vec3Out,
  WireframeMode,
} from './collide';
// Collision (ws/collide). The profile `sweep` above keeps its name: the shape sweep is `sweepShape`.
export {
  ALL_LAYERS,
  aabbTriangle,
  applyTransform,
  capsuleTriangle,
  carryBy,
  closestPointTriangle,
  closestSegmentSegment,
  closestSegmentTriangle,
  colliderTriangle,
  colliderWireframe,
  colliderWireframeLength,
  createContact,
  createHit,
  createSlideResult,
  createStaticCollider,
  createSweepHit,
  createTileSlideResult,
  exportCollider,
  gridSolid,
  gridTriangles,
  importCollider,
  isAabb,
  isBox2,
  isCapsule,
  overlap,
  overlap2,
  raycast,
  raycast2,
  raycastReg,
  SOURCE_GEOMETRY,
  SOURCE_GRID,
  SOURCE_HEIGHTFIELD,
  StaticCollider,
  shapeBounds,
  shapeTriangle,
  slide,
  slide2,
  slideTiles,
  sphereTriangle,
  sweep as sweepShape,
  sweep2,
  TILE_EMPTY,
  TILE_ONE_WAY,
  TILE_SOLID,
  triangleNormal,
} from './collide';
export type { Geometry, GeometryOptions, Rgba } from './geometry';
export {
  cloneGeometry,
  computeBounds,
  createIndices,
  GEOMETRY_FLOATS,
  GeometryWriter,
  mergeGeometry,
  transformGeometry,
  UINT16_MAX_VERTICES,
} from './geometry';
export type {
  Heightfield,
  HeightfieldGeometryOptions,
  HeightfieldOptions,
  HeightfieldRay,
  HeightfieldVec3,
} from './heightfield';
export {
  createHeightfield,
  heightAt,
  heightfieldGeometry,
  normalAt,
  raycastHeightfield,
  rayHeightfield,
} from './heightfield';
export type { CollisionProxyOptions } from './hull';
export { collisionProxy, convexHull } from './hull';
export type { Iso, IsoHeightAt, IsoOptions, IsoPoint } from './iso';
export { createIso, ISO_ELEV_DEPTH, isoHiddenBy, isoInverseProbe } from './iso';
export type { LodChain } from './lod';
export { projectedSizePx, selectLod } from './lod';
export type { ProjectUvOptions, UvProjection } from './ops';
export { fitBounds, flatShade, flipWinding, projectUv, recenter, weld } from './ops';
export type {
  BoxOptions,
  CapsuleOptions,
  CylinderOptions,
  IcosphereOptions,
  PlaneOptions,
  SphereOptions,
  TorusOptions,
} from './primitives';
export { box, capsule, cylinder, icosphere, plane, sphere, torus } from './primitives';
export type { ArchOptions, StairsOptions } from './shapes';
export { arch, stairs } from './shapes';
export type { SimplifyOptions, SimplifyResult } from './simplify';
export { createLodChain, simplifyGeometry } from './simplify';
export type { SliceOptions, SlicePlane, SliceResult } from './split';
export { sliceGeometry, splitGeometry } from './split';
export type {
  ExtrudeOptions,
  LatheOptions,
  PolygonOptions,
  Profile2D,
  SweepOptions,
  TubeOptions,
} from './sweep';
export { extrude, lathe, polygon, sweep, tube } from './sweep';
export type { GeometryTangent } from './tangents';
export { computeTangents, TANGENT_FLOATS } from './tangents';
export { profileArea2, triangulate } from './triangulate';
