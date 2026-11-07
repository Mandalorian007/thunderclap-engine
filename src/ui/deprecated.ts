/**
 * Public aliases of ui internals, deprecated by E-036 (ws/api-core) and removed in the next
 * minor. Each stylesheet is injected by its own `ensure*Styles`, and the world panel builds its
 * pipeline from its WGSL, so games never needed them. The source files (`styles.ts`, `hud.ts`,
 * `cursor.ts`, …) keep the constants under the same names; the module and its tests use those.
 */
import { CURSOR_CSS as CURSOR_CSS_ } from './cursor';
import { FLOATS_CSS as FLOATS_CSS_ } from './floats';
import { HUD_CSS as HUD_CSS_ } from './hud';
import { INVENTORY_CSS as INVENTORY_CSS_ } from './inventory';
import { LOADING_CSS as LOADING_CSS_ } from './loading';
import { CANVAS_MINIMAP_CSS as CANVAS_MINIMAP_CSS_ } from './minimap-canvas';
import { NOTIFY_CSS as NOTIFY_CSS_ } from './notify';
import { ORB_CSS as ORB_CSS_ } from './orb';
import { BASE_CSS as BASE_CSS_ } from './styles';
import { TOOLTIP_CSS as TOOLTIP_CSS_ } from './tooltip';
import { WIDGETS2_CSS as WIDGETS2_CSS_ } from './widgets-2';
import { WIDGETS3_CSS as WIDGETS3_CSS_ } from './widgets-3';
import { WORLD_PANEL_WGSL as WORLD_PANEL_WGSL_ } from './world-panel/wgsl';

/** @deprecated (ws/api-core, E-036) Internal: `ensureStyles` injects it. Removed next minor. */
export const BASE_CSS = BASE_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: `ensureCursorStyles` injects it. Removed next minor. */
export const CURSOR_CSS = CURSOR_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Removed next minor. */
export const FLOATS_CSS = FLOATS_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Removed next minor. */
export const HUD_CSS = HUD_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Removed next minor. */
export const INVENTORY_CSS = INVENTORY_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: `ensureLoadingStyles` injects it. Removed next minor. */
export const LOADING_CSS = LOADING_CSS_;
/**
 * @deprecated (ws/api-core, E-036) Internal: `ensureCanvasMinimapStyles` injects it. Removed next
 * minor.
 */
export const CANVAS_MINIMAP_CSS = CANVAS_MINIMAP_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: `ensureNotifyStyles` injects it. Removed next minor. */
export const NOTIFY_CSS = NOTIFY_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: `ensureOrbStyles` injects it. Removed next minor. */
export const ORB_CSS = ORB_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: `ensureTooltipStyles` injects it. Removed next minor. */
export const TOOLTIP_CSS = TOOLTIP_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Removed next minor. */
export const WIDGETS2_CSS = WIDGETS2_CSS_;
/** @deprecated (ws/api-core, E-036) Internal: `ensureWidgets3Styles` injects it. Removed next minor. */
export const WIDGETS3_CSS = WIDGETS3_CSS_;
/**
 * @deprecated (ws/api-core, E-036) Internal: `createWorldPanel` builds its pipeline from it.
 * Removed next minor.
 */
export const WORLD_PANEL_WGSL = WORLD_PANEL_WGSL_;
