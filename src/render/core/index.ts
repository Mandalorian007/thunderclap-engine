/**
 * The retained render core (D1 §3, preview): arenas, layouts, draw sets, views and the pass
 * list. Exported from `@thunderclap-engine/engine/render`.
 */
export type { ArenaAlloc, ArenaDesc, ArenaKind } from './arena';
export { Arena, createArena } from './arena';
export type { CoreCaps, CoreTarget, RenderCoreOptions } from './core';
export { createRenderCore, MULTI_DRAW_FEATURE, RenderCore } from './core';
export {
  ARGS_BYTES,
  ARGS_WORDS,
  CULL_WGSL,
  cullSlotsCpu,
  SLOT,
  SLOT_BYTES,
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
export type { BufferLayout, LayoutAttribute, LayoutDesc } from './layout';
export { createInstanceLayout, createVertexLayout, vertexFormatBytes } from './layout';
export type { CorePass, PassDepth, PassDesc } from './pass-list';
export { CORE_PASSES, PassList } from './pass-list';
export { QUAD_INDICES, QuadIndex, quadIndices } from './quad-index';
export type { RenderView } from './view';
export {
  CORE_VIEW_WGSL,
  createRenderView,
  MAX_VIEWS,
  setViewFromCamera,
  sphereInPlanes,
  VIEW_SLOT_BYTES,
  VIEW_SLOT_FLOATS,
} from './view';
