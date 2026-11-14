/**
 * Procedural part models: machines, creatures and props built from data (a tree of boxes,
 * cylinders, gears, rings, prisms, frustums, wedges and `geom` meshes), compiled against the
 * game's material table into draw units, placed by slot and animated in the shader by named
 * state channels. See README.md.
 */
export { COLOR_MODE, MODEL_VERTEX_FLOATS, ModelBuilder } from './builder';
export {
  channelOf,
  compileModel,
  evaluateUnit,
  MODEL_UNIT_FLOATS,
  MOTION_KIND,
  type ModelUnit,
  type ModelUnits,
  materialCode,
  materialConstName,
  type UnitPose,
} from './compile';
export {
  type ChannelInput,
  createModelInstances,
  MODEL_INSTANCE,
  MODEL_INSTANCE_FLOATS,
  type ModelDraw,
  type ModelInstanceState,
  type ModelInstanceStats,
  ModelInstances,
  type ModelInstancesOptions,
  type ModelXform,
} from './instances';
export {
  createModelScene,
  ModelScene,
  type ModelSceneOptions,
  type ModelSceneStats,
} from './scene';
export {
  MAX_MODEL_CHANNELS,
  type MaterialCodeTable,
  type ModelChannel,
  type ModelMaterial,
  type Part,
  type PartAxis,
  type PartColor,
  type PartGlow,
  type PartModel,
  type PartMotion,
  type PartRepeat,
  type PartRgb,
  type PartShape,
  type PartTurn,
  type PartVec3,
} from './spec';
export {
  MODEL_DEFAULT_SHADE_WGSL,
  MODEL_SURFACE_WGSL,
  materialConstantsWgsl,
  modelShaderWgsl,
} from './wgsl';
