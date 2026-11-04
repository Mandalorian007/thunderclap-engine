/** Page visibility + user-preference helpers. */

/** Calls `fn(visible)` whenever the tab is hidden/shown. Returns unsubscribe. */
export function watchVisibility(fn: (visible: boolean) => void): () => void {
  const h = () => fn(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', h);
  return () => document.removeEventListener('visibilitychange', h);
}

const REDUCED = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(REDUCED).matches;
}

/** What the device looks like from the page: enough to pick sensible defaults, not to sniff. */
export interface DeviceTraits {
  /** The primary pointer is coarse (a finger). */
  coarsePointer: boolean;
  /** The screen's shorter side in CSS px (`screen.width/height`, orientation-independent). */
  shortSide: number;
  /**
   * A phone-sized touch device: coarse pointer and a screen whose short side is at most
   * `HANDHELD_SHORT_SIDE` CSS px. Phones have small batteries, tiled GPUs and throttle when
   * hot, so callers pick lighter defaults. Tablets (short side 744+) are not handheld.
   */
  handheld: boolean;
}

/** The largest phones are ~440 CSS px on the short side; the smallest tablets ~744. */
export const HANDHELD_SHORT_SIDE = 600;

export function deviceTraits(): DeviceTraits {
  const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const s = typeof screen !== 'undefined' ? screen : null;
  const shortSide = s ? Math.min(s.width, s.height) : 0;
  return {
    coarsePointer,
    shortSide,
    handheld: coarsePointer && shortSide > 0 && shortSide <= HANDHELD_SHORT_SIDE,
  };
}

export interface LifecycleHandlers {
  /**
   * The page is going into the background or away: `visibilitychange` to hidden, `pagehide`
   * (iOS app switch, closing the tab, bfcache) or `freeze` (Chrome on Android freezing a
   * background tab, which it may later discard with no further event). Stop work and persist
   * here: it may be the last chance. Can fire several times in a row (hidden, pagehide, freeze).
   */
  onHide(reason: 'hidden' | 'pagehide' | 'freeze'): void;
  /** The page is back and visible (`visibilitychange`, `pageshow`, `resume`). */
  onShow(reason: 'visible' | 'pageshow' | 'resume'): void;
}

/**
 * A game is input, not a document: stop double-tap, pinch and trackpad smart-zoom (and
 * ctrl+wheel) from zooming the page. Keyboard zoom (Cmd/Ctrl +/-) is left alone for
 * accessibility. Returns unsubscribe.
 */
export function blockBrowserZoom(doc: Document = document): () => void {
  const block = (e: Event) => e.preventDefault();
  const wheel = (e: WheelEvent) => {
    if (e.ctrlKey) e.preventDefault();
  };
  const types = ['gesturestart', 'gesturechange', 'dblclick'];
  for (const t of types) doc.addEventListener(t, block, { passive: false });
  doc.addEventListener('wheel', wheel, { passive: false });
  return () => {
    for (const t of types) doc.removeEventListener(t, block);
    doc.removeEventListener('wheel', wheel);
  };
}

/** Page lifecycle across the events phones actually send. Returns unsubscribe. */
export function watchLifecycle(h: LifecycleHandlers): () => void {
  const visible = () => document.visibilityState === 'visible';
  const onVis = () => (visible() ? h.onShow('visible') : h.onHide('hidden'));
  const onPageHide = () => h.onHide('pagehide');
  const onPageShow = () => {
    if (visible()) h.onShow('pageshow');
  };
  const onFreeze = () => h.onHide('freeze');
  const onResume = () => {
    if (visible()) h.onShow('resume');
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('freeze', onFreeze);
  document.addEventListener('resume', onResume);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('freeze', onFreeze);
    document.removeEventListener('resume', onResume);
  };
}

/** Calls `fn(reduced)` when the reduced-motion preference changes. Returns unsubscribe. */
export function watchReducedMotion(fn: (reduced: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia(REDUCED);
  const h = () => fn(mq.matches);
  mq.addEventListener('change', h);
  return () => mq.removeEventListener('change', h);
}
