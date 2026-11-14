/**
 * The retained render core (D1 §3, preview): arenas, layouts, draw sets, views and the pass
 * list. Exported from `@thunderclap-engine/engine/render`.
 */
export type { ArenaAlloc, ArenaDesc, ArenaKind } from './arena';
export { Arena, createArena } from './arena';
export type { CoreCaps, CoreShadowTarget, CoreTarget, RenderCoreOptions } from './core';
export { createRenderCore, MULTI_DRAW_FEATURE, RenderCore } from './core';
export {
  ARGS_BYTES,
  ARGS_WORDS,
  CULL_WGSL,
  cullSlotsCpu,
  SLOT,
  SLOT_BYTES,
  SLOT_HIDDEN,
  SLOT_LIVE,
  SLOT_WORDS,
} from './cull';
export type {
  CoreStats,
  DrawSetCull,
  DrawSetDesc,
  DrawSetKind,
  DrawSetShader,
  SlotDesc,
} from './draw-set';
export { DrawSet, GPU_CULL_MIN_SLOTS } from './draw-set';
export type { CoreDrawable, CoreDrawableEncoder, CoreDrawContext } from './drawable';
export {
  CORE_DRAWABLE_WGSL,
  CORE_VIEW_EXTRA_WGSL,
  CoreViewExtras,
  DrawablePipelines,
  VIEW_EXTRA_FLOATS,
} from './drawable';
export type { BufferLayout, LayoutAttribute, LayoutDesc } from './layout';
export { createInstanceLayout, createVertexLayout, vertexFormatBytes } from './layout';
export type {
  CorePass,
  CorePassContext,
  CoreResolveContext,
  PassDepth,
  PassDesc,
} from './pass-list';
export { CORE_PASSES, PassList } from './pass-list';
export { QUAD_INDICES, QuadIndex, quadIndices } from './quad-index';
export type { CoreTargetName } from './targets';
export {
  CORE_TARGET,
  CORE_TARGET_FORMATS,
  CORE_TARGET_NAMES,
  coreColorFormats,
  coreColorTargets,
  coreTargetMask,
} from './targets';
export type { CullGroup, RenderView } from './view';
export {
  CORE_VIEW_WGSL,
  createRenderView,
  MAX_VIEWS,
  setViewFromCamera,
  setViewFromMatrices,
  sphereInPlanes,
  unionPlanesInto,
  VIEW_SLOT,
  VIEW_SLOT_BYTES,
  VIEW_SLOT_FLOATS,
} from './view';
