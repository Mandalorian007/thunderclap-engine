/**
 * `@thunderclap/engine/geom`: primitive geometry (box, plane, sphere, icosphere, capsule,
 * cylinder, torus) in the engine's 3D vertex layout with bounds, merge and transform helpers,
 * and heightfields with bilinear sampling, normals, an exact ray test and a mesh builder.
 * Pure arithmetic: no GPU, no DOM; `render/` supplies only the layout and its types.
 */
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
} from './heightfield';
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
