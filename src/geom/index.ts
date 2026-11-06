/**
 * `@thunderclap/engine/geom`: primitive geometry (box, plane, sphere, icosphere, capsule,
 * cylinder, torus) in the engine's 3D vertex layout with bounds, merge and transform helpers,
 * heightfields with bilinear sampling, normals, an exact ray test and a mesh builder, shapes
 * swept from 2D profiles (extrude, lathe, sweep, tube, polygon, stairs, arch), tangent frames
 * and per-geometry operations (flat shading, welding, uv projection, fitting).
 * Pure arithmetic: no GPU, no DOM; `render/` supplies only the layouts and their types.
 */

export type {
  Aabb,
  Box2,
  Capsule,
  Circle,
  ColliderBounds,
  ColliderSource,
  ColliderTransform,
  Contact,
  GeometrySource,
  GridSource,
  HeightfieldSource,
  Hit,
  Shape,
  Shape2,
  SlideOptions,
  SlideResult,
  SourceKind,
  SourceRecord,
  Sphere,
  StaticColliderOptions,
  SweepHit,
  TileGridSource,
  Vec3Out,
  WireframeMode,
} from './collide';
// Collision (ws/collide). The profile `sweep` above keeps its name: the shape sweep is `sweepShape`.
export {
  ALL_LAYERS,
  aabbTriangle,
  applyTransform,
  capsuleTriangle,
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
  SOURCE_GEOMETRY,
  SOURCE_GRID,
  SOURCE_HEIGHTFIELD,
  StaticCollider,
  shapeBounds,
  shapeTriangle,
  slide,
  slide2,
  sphereTriangle,
  sweep as sweepShape,
  sweep2,
  triangleNormal,
} from './collide';
export type { Geometry, GeometryOptions, Rgba } from './geometry';
export {
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
