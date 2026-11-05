/**
 * Phone and touch modes for a scaled overlay (interim API: Phase 2's layout regions retire it,
 * D-041). Flags and density tokens on the overlay root, recomputed live:
 *
 * - `data-phone`: the design canvas is shown so small (under `phoneScale` CSS px per design px,
 *   i.e. a phone in landscape) that design-sized text and buttons would be unreadable and
 *   untappable, so the game should switch to a phone layout. While it is set the root carries,
 *   in CSS px:
 *   - `--tc-bar`: the letterbox bar beside the canvas;
 *   - `--tc-third`: a third of the viewport width less 6 px (the widest a transient card
 *     should grow).
 *   Desktop and tablets never get it.
 * - `--tc-crop-t` / `--tc-crop-b` (always set, CSS px) and `data-fill`: what is cut off the top
 *   and bottom of the canvas when a phone fills the width instead of letterboxing (0 otherwise).
 * - `data-touch`: the last input was a finger. A mouse press or a key switches it off again.
 *
 * The density tokens (`--tc-text-min`, `--tc-tap-min`) belong to the overlay's layout.
 */
import { isTouchOnly, type PointerKind, watchPointerKind } from './device';

/** Default `phoneScale`: below this overlay scale the screen is phone-sized. Phones are 0.33–0.40, tablets 0.53+. */
export const PHONE_SCALE = 0.45;

export interface DeviceModeOptions {
  /** Overlay scale (CSS px per design px) under which the screen counts as a phone. Default 0.45. */
  phoneScale?: number;
}

export interface DeviceMode {
  /** A phone-sized screen (see `DeviceModeOptions.phoneScale`). */
  readonly phone: boolean;
  /** The last input was touch. */
  readonly touch: boolean;
  /** Design px per CSS px (1 / overlay scale). */
  readonly cssPx: number;
  /** Width of each letterbox bar beside the canvas, design px (0 when it fills the width). */
  readonly bar: number;
  /**
   * Design px cut off the top and bottom of the canvas when a phone fills the width (0
   * otherwise): the visible band is `[cropT, designHeight - cropB]`.
   */
  readonly cropT: number;
  readonly cropB: number;
  onChange(fn: () => void): () => void;
}

/** See `DeviceModeController.setScale`. */
export interface CropInfo {
  readonly fitScale: number;
  readonly top: number;
  readonly bottom: number;
}

export interface DeviceModeController extends DeviceMode {
  /**
   * Call on every resize with the overlay scale. `barCss`: the letterbox bar each side of the
   * canvas, CSS px. `crop` (a scene that fills the width on a phone): the contain fit's scale,
   * which decides phone-ness so filling never flips the mode, and the CSS px cut off the top
   * and bottom of the canvas.
   */
  setScale(scale: number, barCss?: number, crop?: CropInfo): void;
  destroy(): void;
}

export function createDeviceMode(
  root: HTMLElement,
  opts: DeviceModeOptions = {},
): DeviceModeController {
  const phoneScale = opts.phoneScale ?? PHONE_SCALE;
  let phone = false;
  let touch = isTouchOnly();
  let cssPx = 1;
  let bar = 0;
  let cropT = 0;
  let cropB = 0;
  const subs = new Set<() => void>();
  const emit = () => {
    for (const f of subs) f();
  };
  const applyTouch = () => root.toggleAttribute('data-touch', touch);
  applyTouch();
  const unwatch = watchPointerKind((k: PointerKind) => {
    const t = k === 'touch';
    if (t === touch) return;
    touch = t;
    applyTouch();
    emit();
  }, root.ownerDocument);

  return {
    get phone() {
      return phone;
    },
    get touch() {
      return touch;
    },
    get cssPx() {
      return cssPx;
    },
    get bar() {
      return bar;
    },
    get cropT() {
      return cropT;
    },
    get cropB() {
      return cropB;
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setScale(scale, barCss = 0, crop) {
      const s = scale > 0 ? scale : 1;
      const p = (crop && crop.fitScale > 0 ? crop.fitScale : s) < phoneScale;
      const ct = p && crop ? Math.max(0, Math.round(crop.top / s)) : 0;
      const cb = p && crop ? Math.max(0, Math.round(crop.bottom / s)) : 0;
      // CSS px hidden above and below the screen: top- and bottom-anchored chrome moves in by it.
      root.style.setProperty('--tc-crop-t', `${p && crop ? Math.max(0, crop.top) : 0}px`);
      root.style.setProperty('--tc-crop-b', `${p && crop ? Math.max(0, crop.bottom) : 0}px`);
      root.toggleAttribute('data-fill', ct + cb > 0);
      const b = Math.max(0, Math.round(barCss / s));
      const resized = Math.abs(cssPx - 1 / s) > 1e-3 || b !== bar || ct !== cropT || cb !== cropB;
      cssPx = 1 / s;
      bar = b;
      cropT = ct;
      cropB = cb;
      if (p) {
        root.style.setProperty('--tc-bar', `${Math.max(0, barCss)}px`);
        // A third of the screen, less a margin: the widest any transient card may grow.
        const vw = root.ownerDocument.defaultView?.innerWidth ?? 0;
        root.style.setProperty('--tc-third', `${Math.round(vw / 3 - 6)}px`);
      } else {
        root.style.removeProperty('--tc-bar');
        root.style.removeProperty('--tc-third');
      }
      if (p === phone && !(p && resized)) return;
      phone = p;
      root.toggleAttribute('data-phone', p);
      emit();
    },
    destroy() {
      unwatch();
      subs.clear();
    },
  };
}
