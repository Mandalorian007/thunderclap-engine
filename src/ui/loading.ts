/**
 * Loading screen (ws/ui-3): a full-frame, non-dismissible panel on the `panels` layer with a
 * title, a progress `bar` and a tip line that can rotate through strings. While it is shown the
 * overlay root carries `aria-busy="true"`, the lower layers are inert (a modal panel), the game's
 * `Input` is blocked through `stack.hasModal`, and keys other than Tab are swallowed at the
 * document's capture phase. `done()` fades it out and resolves after the transition.
 */
import { h } from './dom';
import type { PanelHandle, PanelStack } from './stack';
import { prefersReducedMotionIn } from './styles';
import { toFrameUnits } from './text-scale';
import { bar } from './widgets-2';

export interface LoadingOptions {
  title?: string;
  /** One tip, or several to rotate through every `tipInterval` ms. */
  tip?: string | readonly string[];
  /** ms between tips when `tip` is a list. Default 4000. */
  tipInterval?: number;
  /** Initial progress, 0..1. Default 0. */
  progress?: number;
  /** Accessible name of the bar. Default `Loading`. */
  label?: string;
  /** Skip the fade (also skipped under `prefers-reduced-motion`). */
  reducedMotion?: boolean;
}

export interface LoadingScreen {
  readonly element: HTMLElement;
  /** 0..1 as last set. */
  readonly progress: number;
  /** True from creation until `done()` resolves. */
  readonly visible: boolean;
  /** Progress 0..1; `label` replaces the text beside the bar. */
  set(progress: number, label?: string): void;
  /** Show this tip now (and stop rotating). */
  tip(text: string): void;
  /** Fade out, close the panel, release the root; resolves after the transition. Idempotent. */
  done(): Promise<void>;
}

/** What the loading screen needs from its overlay (`Overlay` fits). */
export interface LoadingHost {
  readonly root: HTMLElement;
  readonly stack: PanelStack;
}

/** Fallback for when no `transitionend` arrives (display: none, a hidden tab). */
const FADE_FALLBACK_MS = 400;

/** Show a loading screen; see the module comment. Also reachable as `ui.loading(opts)`. */
export function createLoading(host: LoadingHost, opts: LoadingOptions = {}): LoadingScreen {
  const doc = host.root.ownerDocument;
  ensureLoadingStyles(doc);
  const label = opts.label ?? 'Loading';
  const progressBar = bar(label, opts.progress ?? 0, {
    format: (v) => `${Math.round(v * 100)}%`,
  });
  const tipEl = h('p', { class: 'tc-loading-tip', role: 'status', 'aria-live': 'polite' });
  const titleEl = opts.title ? h('h2', { class: 'tc-loading-title' }, opts.title) : null;
  const body = h('div', { class: 'tc-loading-body' }, titleEl, progressBar.element, tipEl);

  let progress = opts.progress ?? 0;
  let visible = true;
  let closing: Promise<void> | null = null;
  let tipTimer: ReturnType<typeof setInterval> | null = null;
  const tips = typeof opts.tip === 'string' ? [opts.tip] : [...(opts.tip ?? [])];
  let tipIndex = 0;
  const showTip = (text: string) => {
    if (tipEl.textContent !== text) tipEl.textContent = text;
  };
  if (tips.length > 0) {
    showTip(tips[0]!);
    if (tips.length > 1) {
      tipTimer = setInterval(() => {
        tipIndex = (tipIndex + 1) % tips.length;
        showTip(tips[tipIndex]!);
      }, opts.tipInterval ?? 4000);
    }
  }

  const panel: PanelHandle = host.stack.push({
    content: body,
    modal: true,
    dismissible: false,
    closeOnBackdrop: false,
    chrome: 'none',
    className: 'tc-loading',
    label: opts.title ?? label,
    arrowNav: 'none',
  });
  const element = panel.element;
  host.root.setAttribute('aria-busy', 'true');

  // Swallow keys at the document: the panel traps focus, this keeps Enter/Space/arrows from
  // reaching a game's own key handlers behind it. Tab still moves focus for screen readers.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('keyup', onKey, true);

  const release = () => {
    if (tipTimer) {
      clearInterval(tipTimer);
      tipTimer = null;
    }
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('keyup', onKey, true);
    host.root.removeAttribute('aria-busy');
    visible = false;
    if (panel.open) panel.close('programmatic');
  };

  const screen: LoadingScreen = {
    element,
    get progress() {
      return progress;
    },
    get visible() {
      return visible;
    },
    set(p, text) {
      progress = Math.min(1, Math.max(0, p));
      progressBar.set(progress);
      if (text !== undefined) {
        const value = element.querySelector<HTMLElement>('.tc-ui-bar-value');
        if (value && value.textContent !== text) value.textContent = text;
      }
    },
    tip(text) {
      if (tipTimer) {
        clearInterval(tipTimer);
        tipTimer = null;
      }
      showTip(text);
    },
    done() {
      if (closing) return closing;
      const skipFade = opts.reducedMotion || prefersReducedMotionIn();
      closing = new Promise<void>((resolve) => {
        if (skipFade) {
          release();
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          element.removeEventListener('transitionend', onEnd);
          clearTimeout(fallback);
          release();
          resolve();
        };
        const onEnd = (e: TransitionEvent) => {
          if (e.target === element) finish();
        };
        element.addEventListener('transitionend', onEnd);
        const fallback = setTimeout(finish, FADE_FALLBACK_MS);
        element.dataset.done = '';
      });
      return closing;
    },
  };
  return screen;
}

/**
 * Stylesheet for the loading screen (design px, theme tokens).
 */
export const LOADING_CSS = toFrameUnits(`
.tc-panel.tc-loading { position: absolute; inset: 0; display: grid; place-items: center; max-width: none; max-height: none;
  width: auto; height: auto; margin: 0; padding: 0; background: var(--tc-color-surface); border-radius: 0;
  transition: opacity var(--tc-duration-normal) var(--tc-easing); }
.tc-panel.tc-loading[data-done] { opacity: 0; pointer-events: none; }
.tc-loading-body { display: grid; gap: var(--tc-space-4); width: min(720px, 80%); color: var(--tc-color-text); font-family: var(--tc-font-ui); }
.tc-loading-title { margin: 0; font-size: var(--tc-font-size-l); font-weight: 700; text-align: center; }
.tc-loading-tip { margin: 0; min-height: 1.4em; font-size: var(--tc-font-size-s); color: var(--tc-color-text-muted); text-align: center; }
@media (prefers-reduced-motion: reduce) { .tc-panel.tc-loading { transition: none; } }
`);

const STYLE_ID = 'tc-ui-loading';

/** Add `LOADING_CSS` to `doc` once (the first loading screen does it). */
export function ensureLoadingStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = LOADING_CSS;
  doc.head.appendChild(style);
}
