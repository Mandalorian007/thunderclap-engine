/**
 * Public aliases of render internals, deprecated by E-036 (ws/api-render) and removed in the
 * next minor. Only the module's own tests used these block offsets, float counts and WGSL
 * sources, and those tests import them from the source files (`camera.ts`, `lights.ts`,
 * `skin.ts`, `bindings.ts`, `standard.ts`, `material.ts`), which keep them. Games never needed
 * them: the WGSL prelude names the same fields.
 */
import { BUFFER_BINDING_BASE as BUFFER_BINDING_BASE_ } from './bindings';
import {
  CAMERA_INV_VIEW_PROJ_OFFSET as CAMERA_INV_VIEW_PROJ_OFFSET_,
  CAMERA_JITTER_OFFSET as CAMERA_JITTER_OFFSET_,
  CAMERA_PREV_VIEW_OFFSET as CAMERA_PREV_VIEW_OFFSET_,
  CAMERA_PREV_VIEW_PROJ_OFFSET as CAMERA_PREV_VIEW_PROJ_OFFSET_,
} from './camera';
import {
  FOG_OFFSET_FLOATS as FOG_OFFSET_FLOATS_,
  LAYERS_OFFSET_FLOATS as LAYERS_OFFSET_FLOATS_,
  LIGHTS_BLOCK_FLOATS as LIGHTS_BLOCK_FLOATS_,
  POINT_LAYERS_OFFSET_FLOATS as POINT_LAYERS_OFFSET_FLOATS_,
  POINT_LIGHTS_OFFSET_FLOATS as POINT_LIGHTS_OFFSET_FLOATS_,
  SHADOW_PARAMS_OFFSET_FLOATS as SHADOW_PARAMS_OFFSET_FLOATS_,
  SPOT_LIGHTS_OFFSET_FLOATS as SPOT_LIGHTS_OFFSET_FLOATS_,
  SUN_VIEW_PROJ_OFFSET_FLOATS as SUN_VIEW_PROJ_OFFSET_FLOATS_,
} from './lights';
import { SPRITE_WGSL as SPRITE_WGSL_ } from './material';
import { SKIN_PALETTE_HEADER_FLOATS as SKIN_PALETTE_HEADER_FLOATS_ } from './skin';
import { STANDARD_WGSL as STANDARD_WGSL_ } from './standard';

/** @deprecated (E-036) Internal camera-block layout; removed next minor. */
export const CAMERA_INV_VIEW_PROJ_OFFSET = CAMERA_INV_VIEW_PROJ_OFFSET_;
/** @deprecated (E-036) Internal camera-block layout; removed next minor. */
export const CAMERA_PREV_VIEW_PROJ_OFFSET = CAMERA_PREV_VIEW_PROJ_OFFSET_;
/** @deprecated (E-036) Internal camera-block layout; removed next minor. */
export const CAMERA_PREV_VIEW_OFFSET = CAMERA_PREV_VIEW_OFFSET_;
/** @deprecated (E-036) Internal camera-block layout; removed next minor. */
export const CAMERA_JITTER_OFFSET = CAMERA_JITTER_OFFSET_;
/** @deprecated (E-036) Internal lights-block layout; removed next minor. */
export const POINT_LIGHTS_OFFSET_FLOATS = POINT_LIGHTS_OFFSET_FLOATS_;
/** @deprecated (E-036) Internal lights-block layout; removed next minor. */
export const SUN_VIEW_PROJ_OFFSET_FLOATS = SUN_VIEW_PROJ_OFFSET_FLOATS_;
/** @deprecated (E-036) Internal lights-block layout; removed next minor. */
export const SHADOW_PARAMS_OFFSET_FLOATS = SHADOW_PARAMS_OFFSET_FLOATS_;
/** @deprecated (E-036) Internal lights-block layout; removed next minor. */
export const FOG_OFFSET_FLOATS = FOG_OFFSET_FLOATS_;
/** @deprecated (E-036) Internal lights-block layout; removed next minor. */
export const LAYERS_OFFSET_FLOATS = LAYERS_OFFSET_FLOATS_;
/** @deprecated (E-036) Internal lights-block layout; removed next minor. */
export const POINT_LAYERS_OFFSET_FLOATS = POINT_LAYERS_OFFSET_FLOATS_;
/** @deprecated (E-036) Internal lights-block layout; removed next minor. */
export const SPOT_LIGHTS_OFFSET_FLOATS = SPOT_LIGHTS_OFFSET_FLOATS_;
/** @deprecated (E-036) Internal lights-block size; removed next minor. */
export const LIGHTS_BLOCK_FLOATS = LIGHTS_BLOCK_FLOATS_;
/** @deprecated (E-036) Internal skin-palette header size; removed next minor. */
export const SKIN_PALETTE_HEADER_FLOATS = SKIN_PALETTE_HEADER_FLOATS_;
/**
 * @deprecated (E-036) Internal: `BindingDesc.buffers[i]` binds at `16 + i`, as the render
 * README says. Removed next minor.
 */
export const BUFFER_BINDING_BASE = BUFFER_BINDING_BASE_;
/**
 * @deprecated (E-036) The standard material's own WGSL; use `createStandardMaterial`. Removed
 * next minor.
 */
export const STANDARD_WGSL = STANDARD_WGSL_;
/**
 * @deprecated (E-036) The built-in sprite material's WGSL; use `renderer.createSpriteMaterial`.
 * Removed next minor.
 */
export const SPRITE_WGSL = SPRITE_WGSL_;
