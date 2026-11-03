/**
 * Phone and tablet helpers: the kind of pointer the player is using, orientation and fullscreen.
 * DOM-only, no game nouns. Every function is safe where an API is missing (it answers "no").
 */

const COARSE = '(pointer: coarse)';
const ANY_FINE = '(any-pointer: fine)';

/** True when the primary pointer is a finger and no mouse or trackpad is attached. */
export function isTouchOnly(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(COARSE).matches && !matchMedia(ANY_FINE).matches;
}

export type PointerKind = 'touch' | 'mouse' | 'keyboard';

/**
 * Calls `fn` with the device the player last used anywhere on the page (canvas, buttons or
 * panels): a touch or pen press is `touch`, a mouse press or move is `mouse`, a key is
 * `keyboard`. Capture-phase listeners, so a handler that stops propagation can't hide it.
 * Returns unsubscribe.
 */
export function watchPointerKind(fn: (kind: PointerKind) => void, doc: Document = document) {
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') fn('touch');
    else if (e.pointerType === 'mouse' && (e.type === 'pointerdown' || e.movementX || e.movementY))
      fn('mouse');
  };
  const onKey = (e: KeyboardEvent) => {
    // Modifier-only presses (a screenshot shortcut, a tab switch) don't mean "playing by keys".
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt') return;
    fn('keyboard');
  };
  doc.addEventListener('pointerdown', onPointer, true);
  doc.addEventListener('pointermove', onPointer, true);
  doc.addEventListener('keydown', onKey, true);
  return () => {
    doc.removeEventListener('pointerdown', onPointer, true);
    doc.removeEventListener('pointermove', onPointer, true);
    doc.removeEventListener('keydown', onKey, true);
  };
}

/** True when the viewport is taller than it is wide. */
export function isPortrait(win: Window = window): boolean {
  return win.innerHeight > win.innerWidth;
}

type FsDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/**
 * True when the page may go fullscreen. iPhone Safari has no element fullscreen (only video),
 * and an iframe needs `allowfullscreen`; both answer false here, so callers hide their button.
 */
export function fullscreenAvailable(doc: Document = document): boolean {
  const d = doc as FsDoc;
  const el = doc.documentElement as FsEl;
  const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? false;
  return !!enabled && (!!el.requestFullscreen || !!el.webkitRequestFullscreen);
}

export function isFullscreen(doc: Document = document): boolean {
  const d = doc as FsDoc;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}

/**
 * Enter or leave fullscreen (must run inside a tap or click). On entering, also asks for
 * landscape where the browser allows it (Android Chrome); a refusal is ignored.
 */
export async function toggleFullscreen(
  el: HTMLElement = document.documentElement,
  opts: { lockLandscape?: boolean } = {},
): Promise<boolean> {
  const doc = el.ownerDocument as FsDoc;
  try {
    if (isFullscreen(doc)) {
      await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return false;
    }
    const f = el as FsEl;
    await (f.requestFullscreen?.({ navigationUI: 'hide' }) ?? f.webkitRequestFullscreen?.());
    if (opts.lockLandscape) {
      const o = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      await o?.lock?.('landscape').catch(() => {});
    }
  } catch {
    // Refused (no gesture, iframe without permission): stay as we are.
  }
  return isFullscreen(doc);
}

/** Calls `fn` when fullscreen starts or ends. Returns unsubscribe. */
export function watchFullscreen(fn: (on: boolean) => void, doc: Document = document): () => void {
  const h = () => fn(isFullscreen(doc));
  doc.addEventListener('fullscreenchange', h);
  doc.addEventListener('webkitfullscreenchange', h);
  return () => {
    doc.removeEventListener('fullscreenchange', h);
    doc.removeEventListener('webkitfullscreenchange', h);
  };
}
