import { focusableWithin } from './dom';
import { activateLink } from './link';
import type { PanelStack } from './stack';

/** The slice of the Gamepad API this reads (standard mapping). */
export interface PadLike {
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly axes?: readonly number[];
}

export interface PadNavOptions {
  /** Gamepad source. Default: `navigator.getGamepads()` (guarded). */
  getGamepads?: () => readonly (PadLike | null)[];
  /** Stick deflection that counts as a d-pad press. Default 0.6. */
  axisThreshold?: number;
}

type Dir = 'up' | 'down' | 'left' | 'right';

// Standard mapping: 0 = A/south, 1 = B/east, 12–15 = d-pad up, down, left, right.
const BTN_ACTIVATE = 0;
const BTN_BACK = 1;
const DPAD: Record<Dir, number> = { up: 12, down: 13, left: 14, right: 15 };

function defaultPads(): readonly (PadLike | null)[] {
  try {
    return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    return [];
  }
}

/**
 * Drives the top modal panel with a gamepad, the way Tab, Enter and Esc drive it from a
 * keyboard: the d-pad (or left stick) moves focus through the panel's controls, A activates
 * the focused one, B dismisses the panel. On a focused range slider left/right step its value,
 * and on a `select` they pick the previous/next option. Call `update()` once per frame. It does
 * nothing while no modal is open, so the game's own input map keeps the pad.
 */
export class PadNav {
  private readonly getGamepads: () => readonly (PadLike | null)[];
  private readonly threshold: number;
  private prev = new Set<string>();

  constructor(
    private readonly stack: PanelStack,
    opts: PadNavOptions = {},
  ) {
    this.getGamepads = opts.getGamepads ?? defaultPads;
    this.threshold = opts.axisThreshold ?? 0.6;
  }

  update(): void {
    const now = this.read();
    const before = this.prev;
    const fresh = (k: string) => now.has(k) && !before.has(k);
    this.prev = now;
    const panel = this.stack.topModalElement;
    if (!panel) return;
    if (fresh('back')) {
      this.stack.dismissTop();
      return;
    }
    const active = panel.ownerDocument.activeElement as HTMLElement | null;
    const inside = active !== null && active !== panel && panel.contains(active);
    if (fresh('activate')) {
      // External links open via window.open with block detection (a pad press is no gesture).
      if (inside) activateLink(active, 'gamepad');
      return;
    }
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      if (!fresh(dir)) continue;
      if (inside && (dir === 'left' || dir === 'right') && this.adjust(active, dir === 'right'))
        return;
      const items = focusableWithin(panel);
      if (items.length === 0) return;
      const i = inside ? items.indexOf(active) : -1;
      const step = dir === 'down' || dir === 'right' ? 1 : -1;
      const next =
        i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
      items[next]?.focus();
      return;
    }
  }

  /** Left/right on a value control changes the value instead of moving focus. */
  private adjust(el: HTMLElement, up: boolean): boolean {
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const num = (v: string, d: number) => (v === '' || Number.isNaN(Number(v)) ? d : Number(v));
      const min = num(el.min, 0);
      const max = num(el.max, 100);
      const step = el.step === 'any' ? (max - min) / 20 : num(el.step, 1);
      const v = Math.min(max, Math.max(min, Number(el.value) + (up ? step : -step)));
      el.value = String(Math.round(v / step) * step);
    } else if (el instanceof HTMLSelectElement) {
      const n = el.options.length;
      if (n === 0) return true;
      el.selectedIndex = Math.max(0, Math.min(n - 1, el.selectedIndex + (up ? 1 : -1)));
    } else {
      return false;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  private read(): Set<string> {
    const out = new Set<string>();
    for (const p of this.getGamepads()) {
      if (!p) continue;
      const b = (i: number) => p.buttons[i]?.pressed === true;
      if (b(BTN_ACTIVATE)) out.add('activate');
      if (b(BTN_BACK)) out.add('back');
      for (const [dir, i] of Object.entries(DPAD)) if (b(i)) out.add(dir);
      const [x = 0, y = 0] = p.axes ?? [];
      if (x <= -this.threshold) out.add('left');
      if (x >= this.threshold) out.add('right');
      if (y <= -this.threshold) out.add('up');
      if (y >= this.threshold) out.add('down');
    }
    return out;
  }
}
