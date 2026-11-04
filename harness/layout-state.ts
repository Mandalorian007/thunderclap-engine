/**
 * What the layout harness page (harness/layout.html) publishes on `window.__harnessLayout` for
 * e2e/layout.spec.ts. Shared by the page (harness/layout.ts) and the spec.
 */
import type { FormFactor, Insets, RegionName } from '../src/ui/layout';
import type { Rect } from '../src/ui/overlay';

export interface HarnessLayoutState {
  ready: boolean;
  formFactor: FormFactor | null;
  /** Region rects, overlay CSS px (the overlay is the whole viewport here). */
  regions: Record<RegionName, Rect | null>;
  freeRect: Rect | null;
  safeArea: Insets | null;
  /** `layout.freeUses`. */
  freeUses: { id: string; reason: string }[];
  /** Re-layouts seen (`layout.onChange`). */
  changes: number;
  /** Widget id → the region it is in now. */
  placed: Record<string, string>;
}

export interface HarnessLayoutApi {
  state: HarnessLayoutState;
  /** `applyTextScale` on the overlay root (1 = 100%). */
  setTextScale(scale: number): void;
  /** Re-read the safe area and re-lay out (after the spec changes the emulated insets). */
  refresh(): void;
  /** Open a modal panel with `items` buttons (the last one is "Last"). */
  openPanel(items: number): void;
  /** Open the ⚙ Options panel `times` times in one tick (`stack.replace`). */
  spamOptions(times: number): void;
  /** Panels on the stack and `.tc-panel` elements in the overlay. */
  panels(): { stack: number; dom: number };
}

declare global {
  interface Window {
    __harnessLayout?: HarnessLayoutApi;
  }
}
