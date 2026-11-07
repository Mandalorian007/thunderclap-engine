import { toFrameUnits } from './text-scale';

/**
 * The overlay's root and layers (ui/overlay.ts), in CSS px. `--tc-unit` is what one px of a
 * design-px stylesheet (`toFrameUnits`) draws as on each layer: one design px of the frame
 * (`--tc-dpx`) on the frame's layers, one CSS px in the layout's regions and, in `css` units,
 * in the panels and toasts.
 */
const ROOT_CSS = `
.tc-overlay {
  position: absolute; inset: 0; --tc-unit: var(--tc-dpx, 1px);
  pointer-events: none; overflow: hidden; contain: layout style;
  font-family: var(--tc-font-body); font-size: var(--tc-font-size-m);
  line-height: var(--tc-line-height); color: var(--tc-color-text);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none;
}
.tc-overlay *, .tc-overlay *::before, .tc-overlay *::after { box-sizing: border-box; }
/* Each layer is its own stacking context: a z-index inside one never lifts it over a later layer. */
.tc-layer { position: absolute; inset: 0; pointer-events: none; isolation: isolate; }
.tc-layer[data-layer="hud"], .tc-layer[data-layer="captions"],
.tc-overlay[data-units="frame"] > .tc-layer:is([data-layer="panels"], [data-layer="toasts"]) {
  inset: auto; left: var(--tc-frame-x, 0px); top: var(--tc-frame-y, 0px);
  width: var(--tc-frame-w, 100%); height: var(--tc-frame-h, 100%); overflow: hidden; }
.tc-layer[data-layer="layout"],
.tc-overlay[data-units="css"] > .tc-layer:is([data-layer="panels"], [data-layer="toasts"]) { --tc-unit: 1px; }
/* Native controls draw their thumb, track and arrow in CSS px whatever their box: on the frame's
   layers they are zoomed by the frame's scale instead, their own px read as design px. */
.tc-layer:is([data-layer="hud"], [data-layer="captions"]) :is(input[type="range"], select),
.tc-overlay[data-units="frame"] > .tc-layer:is([data-layer="panels"], [data-layer="toasts"]) :is(input[type="range"], select) {
  zoom: var(--tc-zoom, 1); --tc-unit: 1px; }
/* Theme tokens are resolved on the root, so they are frame px already: a zoomed select would
   draw them at --tc-dpx² (ws/ui-widgets wish). Divide the ones it reads back out. */
.tc-layer:is([data-layer="hud"], [data-layer="captions"]) select,
.tc-overlay[data-units="frame"] > .tc-layer:is([data-layer="panels"], [data-layer="toasts"]) select {
  font-size: calc(var(--tc-font-size-s) / var(--tc-zoom, 1));
  padding: calc(var(--tc-space-2) / var(--tc-zoom, 1)) calc(var(--tc-space-3) / var(--tc-zoom, 1));
  border-width: calc(var(--tc-border-width) / var(--tc-zoom, 1));
  border-radius: calc(var(--tc-radius-m) / var(--tc-zoom, 1)); }
/* Theme lengths are already frame px there: undo the zoom for them (a hair over, so the
   whole-pixel ring the token rounds to does not snap down a pixel). */
.tc-layer:is([data-layer="hud"], [data-layer="captions"]) :is(input[type="range"], select):focus-visible,
.tc-overlay[data-units="frame"] > .tc-layer:is([data-layer="panels"], [data-layer="toasts"]) :is(input[type="range"], select):focus-visible {
  outline-width: calc(var(--tc-focus-ring) / var(--tc-zoom, 1) + 0.1px); }
`;

/** Base widgets, in design px (`toFrameUnits`: one px is `--tc-unit`). */
const WIDGET_CSS = `
.tc-interactive { pointer-events: auto; }

.tc-panel-host { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.tc-panel-host[data-modal="true"] { pointer-events: auto; }
.tc-backdrop { position: absolute; inset: 0; background: var(--tc-color-backdrop); animation: tc-fade var(--tc-duration-normal) var(--tc-easing); }
.tc-panel { position: relative; pointer-events: auto; max-width: 90%; max-height: 90%; overflow: auto; outline: none;
  animation: tc-rise var(--tc-duration-normal) var(--tc-easing); }
.tc-card { background: var(--tc-color-surface); color: var(--tc-color-text);
  border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-l);
  box-shadow: var(--tc-shadow); padding: var(--tc-space-5); }
.tc-panel-title { font-family: var(--tc-font-display); font-size: var(--tc-font-size-l); margin: 0 0 var(--tc-space-3); font-weight: 600; }

.tc-button { pointer-events: auto; font: inherit; font-family: var(--tc-font-display); font-size: var(--tc-font-size-m);
  color: var(--tc-color-text); background: var(--tc-color-surface-alt);
  border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-m);
  padding: var(--tc-space-2) var(--tc-space-4); min-height: 64px; cursor: pointer;
  transition: background var(--tc-duration-fast), border-color var(--tc-duration-fast), transform var(--tc-duration-fast); }
.tc-button:hover:not(:disabled) { border-color: var(--tc-color-accent); }
.tc-button:active:not(:disabled) { transform: translateY(1px); }
.tc-button:disabled { opacity: 0.45; cursor: default; }
.tc-button[data-variant="primary"] { background: var(--tc-color-accent); color: var(--tc-color-accent-text); border-color: var(--tc-color-accent); }
.tc-button[data-variant="ghost"] { background: transparent; border-color: transparent; }
.tc-overlay :focus-visible { outline: var(--tc-focus-ring) solid var(--tc-color-focus); outline-offset: 4px; }

.tc-field { display: flex; align-items: center; gap: var(--tc-space-3); pointer-events: auto; font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); }
.tc-field input[type="range"] { flex: 1; accent-color: var(--tc-color-accent); min-height: 48px; }
.tc-field input[type="checkbox"] { width: 32px; height: 32px; accent-color: var(--tc-color-accent); }

.tc-toasts { position: absolute; left: 50%; top: var(--tc-space-5); transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: var(--tc-space-2); }
.tc-toast { pointer-events: auto; cursor: pointer; background: var(--tc-color-surface); color: var(--tc-color-text);
  border-left: 6px solid var(--tc-color-info); border-radius: var(--tc-radius-m); box-shadow: var(--tc-shadow);
  padding: var(--tc-space-3) var(--tc-space-4); font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s);
  max-width: 1100px; animation: tc-drop var(--tc-duration-normal) var(--tc-easing); }
.tc-toast[data-tone="success"] { border-left-color: var(--tc-color-success); }
.tc-toast[data-tone="warn"] { border-left-color: var(--tc-color-warn); }
.tc-toast[data-tone="danger"] { border-left-color: var(--tc-color-danger); }

.tc-caption { position: absolute; pointer-events: auto; cursor: pointer; display: flex; gap: var(--tc-space-3); align-items: flex-start;
  width: max-content; max-width: min(var(--tc-caption-max-width, 720px), calc(100% - 2 * var(--tc-caption-margin, var(--tc-space-5))));
  background: var(--tc-color-surface); border: var(--tc-border-width) solid var(--tc-color-border);
  border-radius: var(--tc-radius-m); box-shadow: var(--tc-shadow); padding: var(--tc-space-3) var(--tc-space-4);
  transition: opacity var(--tc-duration-normal) var(--tc-easing), transform var(--tc-duration-normal) var(--tc-easing); }
.tc-caption[hidden], .tc-caption[data-suspended] { display: none; }
.tc-caption[data-corner$="right"] { right: var(--tc-caption-margin, var(--tc-space-5)); }
.tc-caption[data-corner$="left"] { left: var(--tc-caption-margin, var(--tc-space-5)); }
.tc-caption[data-corner^="bottom"] { bottom: var(--tc-caption-margin, var(--tc-space-5)); }
.tc-caption[data-corner^="top"] { top: var(--tc-caption-margin, var(--tc-space-5)); }
.tc-caption-side { flex: none; display: flex; flex-direction: column; align-items: center; gap: var(--tc-space-1); }
.tc-caption-side[hidden], .tc-caption-portrait:empty { display: none; }
.tc-caption-body { flex: 1 1 auto; min-width: 0; }
.tc-caption-speaker { font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-accent);
  letter-spacing: 0.08em; text-transform: uppercase; line-height: 1.2; }
.tc-caption-body > .tc-caption-speaker { margin-bottom: var(--tc-space-1); }
.tc-caption-speaker:empty { display: none; }
.tc-caption-text { font-size: var(--tc-font-size-m); white-space: pre-wrap; overflow-wrap: break-word; }
.tc-caption-text .tc-caption-pending { visibility: hidden; }

.tc-link { position: relative; display: flex; flex-direction: column; align-items: center; pointer-events: auto; }
.tc-link-row { display: flex; align-items: center; gap: var(--tc-space-2); }
.tc-link-copy { pointer-events: auto; display: inline-flex; align-items: center; gap: var(--tc-space-2); padding: 6px 14px;
  border-radius: 999px; cursor: pointer; white-space: nowrap; font-family: var(--tc-font-ui); font-size: calc(var(--tc-font-size-s) * 0.75);
  line-height: 1.2; color: var(--tc-color-text); background: var(--tc-color-surface); border: 1px solid var(--tc-color-border); }
.tc-link-copy:hover { border-color: var(--tc-color-accent); }
.tc-link-copy[data-copied] { color: var(--tc-color-success); border-color: var(--tc-color-success); }
.tc-link-copy-icon { width: 1.1em; height: 1.1em; flex: none; }
.tc-link-fallback { position: absolute; z-index: 5; display: flex; flex-direction: column; gap: var(--tc-space-2);
  width: max-content; min-width: 560px; max-width: 1000px;
  box-sizing: border-box; padding: 12px var(--tc-space-3) 14px; text-align: left; pointer-events: auto;
  background: var(--tc-color-surface); border: 1px solid var(--tc-color-border); border-radius: var(--tc-radius-m); box-shadow: var(--tc-shadow); }
.tc-link-fallback[hidden] { display: none; }
.tc-link-fallback[data-place="below"] { top: calc(100% + 10px); }
.tc-link-fallback[data-place="above"] { bottom: calc(100% + 10px); }
.tc-link-fallback[data-align="center"] { left: 50%; transform: translateX(-50%); }
.tc-link-fallback[data-align="start"] { left: 0; }
.tc-link-fallback[data-align="end"] { right: 0; }
.tc-link-fallback-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--tc-space-3); }
.tc-link-message { font-family: var(--tc-font-ui); font-size: calc(var(--tc-font-size-s) * 0.75); line-height: 1.3; color: var(--tc-color-text); }
.tc-link-close { flex: none; padding: 3px 12px; border-radius: 999px; cursor: pointer; font-family: var(--tc-font-ui);
  font-size: calc(var(--tc-font-size-s) * 0.67); color: var(--tc-color-text); background: transparent; border: 1px solid var(--tc-color-border); }
.tc-link-close:hover { border-color: var(--tc-color-accent); }
.tc-link-field { width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: var(--tc-radius-s); font-family: var(--tc-font-mono);
  font-size: calc(var(--tc-font-size-s) * 0.83); color: var(--tc-color-text); background: var(--tc-color-bg); border: 1px solid var(--tc-color-border); }

`;

/** The layers that follow the form's units (regions, and panels and toasts in `css` units). */
const CSSU =
  '.tc-overlay[data-units="css"] :is(.tc-layer[data-layer="layout"], .tc-layer[data-layer="panels"], .tc-layer[data-layer="toasts"])';

/** `css` units: base widgets in regions, panels and toasts honour the density tokens (CSS px). */
const CSS_UNITS_CSS = `
${CSSU} .tc-button { min-height: var(--tc-tap-min, 32px); min-width: var(--tc-tap-min, 32px);
  padding: var(--tc-space-2) var(--tc-space-4); }
${CSSU} .tc-field { min-height: var(--tc-tap-min, 32px); }
${CSSU} .tc-field input[type="range"] { min-height: var(--tc-tap-min, 32px); margin: 0; }
${CSSU} .tc-field input[type="checkbox"] { width: 20px; height: 20px; }
${CSSU} .tc-panel-host { padding: var(--tc-modal-top, 8px) var(--tc-modal-right, 8px) var(--tc-modal-bottom, 8px) var(--tc-modal-left, 8px); }
${CSSU} .tc-panel { max-width: 100%; max-height: 100%; }
${CSSU} .tc-toasts { top: calc(var(--tc-safe-top-px, 0px) + var(--tc-space-4)); width: max-content; max-width: calc(100% - 32px); }
${CSSU} .tc-toast { max-width: 560px; }
${CSSU} .tc-caption { --tc-caption-max-width: 480px; --tc-caption-margin: var(--tc-space-4); }
${CSSU} .tc-link-fallback { min-width: 0; width: min(480px, 90vw); }

/* Layout regions (ui/layout.ts). The grid is laid out in the safe area; regions scroll rather than spill. */
.tc-layout { position: absolute; inset: 0; display: grid; pointer-events: none; }
.tc-region { position: relative; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain;
  display: flex; gap: var(--tc-region-pad, 8px); padding: var(--tc-region-pad, 8px); pointer-events: none; }
.tc-region[hidden] { display: none; }
.tc-region > * { flex: none; }
.tc-region[data-region="top"], .tc-region[data-region="bottom"] { flex-direction: row; align-items: center; }
.tc-region[data-region="left"], .tc-region[data-region="right"], .tc-region[data-region="cardLane"] { flex-direction: column; align-items: stretch; }
.tc-region[data-region="captionLane"] { flex-direction: row; align-items: stretch; }
.tc-region[data-region="fill"], .tc-region[data-region="modal"] { flex-direction: column; align-items: center; justify-content: center; }
.tc-region[data-region="modal"] { position: absolute; }
.tc-layout-free { position: absolute; inset: 0; pointer-events: none; }
.tc-overlay [data-tc-layout-hidden] { display: none !important; }
.tc-caption[data-docked] { position: relative; inset: auto; width: 100%; max-width: none; max-height: 100%; overflow: auto; flex: 1 1 auto; }

.tc-sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }

@keyframes tc-fade { from { opacity: 0; } }
@keyframes tc-rise { from { opacity: 0; transform: translateY(16px) scale(0.98); } }
@keyframes tc-drop { from { opacity: 0; transform: translateY(-12px); } }
@media (prefers-reduced-motion: reduce) {
  .tc-overlay *, .tc-overlay *::before, .tc-overlay *::after { animation: none !important; transition: none !important; }
}
`;

/**
 * The overlay's base stylesheet: tokens, layers, panels, widgets and units. Injected once
 * per document by `ensureStyles`; the HUD, cursor, tooltip and other widget sheets add
 * their own `<style>` beside it. Everything is under `.tc-overlay`.
 *
 * @deprecated (ws/api-core, E-036) Internal: `ensureStyles` injects it. Leaves the `ui` entry next
 * minor; tests import it from this file.
 */
export const BASE_CSS = ROOT_CSS + toFrameUnits(WIDGET_CSS) + CSS_UNITS_CSS;

const STYLE_ID = 'tc-ui-base';

/** Add the base stylesheet to `doc` once. */
export function ensureStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = BASE_CSS;
  doc.head.appendChild(style);
}

/**
 * True if the user prefers reduced motion in `win` (default the global window; false where
 * `matchMedia` is unavailable). `platform`'s `prefersReducedMotion()` reads the global window only.
 */
export function prefersReducedMotionIn(win: Window | undefined = globalThis.window): boolean {
  try {
    return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * @deprecated (ws/api-core, E-036) Use `prefersReducedMotionIn`: `platform` exports a
 * `prefersReducedMotion()` without the window argument. Removed next minor.
 */
export const prefersReducedMotion: (win?: Window) => boolean = prefersReducedMotionIn;
