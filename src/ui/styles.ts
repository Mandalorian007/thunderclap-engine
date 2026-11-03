/** Base stylesheet for the overlay. Injected once per document. Everything is under `.tc-overlay`. */
export const BASE_CSS = `
.tc-overlay {
  position: absolute; left: 0; top: 0; transform-origin: 0 0;
  pointer-events: none; overflow: hidden; contain: layout style;
  font-family: var(--tc-font-body); font-size: var(--tc-font-size-m);
  line-height: var(--tc-line-height); color: var(--tc-color-text);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none;
}
.tc-overlay *, .tc-overlay *::before, .tc-overlay *::after { box-sizing: border-box; }
.tc-layer { position: absolute; inset: 0; pointer-events: none; }
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

.tc-sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }

@keyframes tc-fade { from { opacity: 0; } }
@keyframes tc-rise { from { opacity: 0; transform: translateY(16px) scale(0.98); } }
@keyframes tc-drop { from { opacity: 0; transform: translateY(-12px); } }
@media (prefers-reduced-motion: reduce) {
  .tc-overlay *, .tc-overlay *::before, .tc-overlay *::after { animation: none !important; transition: none !important; }
}
`;

const STYLE_ID = 'tc-ui-base';

/** Add the base stylesheet to `doc` once. */
export function ensureStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = BASE_CSS;
  doc.head.appendChild(style);
}

/** True if the user prefers reduced motion (false where `matchMedia` is unavailable). */
export function prefersReducedMotion(win: Window | undefined = globalThis.window): boolean {
  try {
    return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
