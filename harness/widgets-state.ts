/**
 * What the widgets harness page (harness/widgets.html) publishes on `window.__harnessWidgets`
 * for e2e/widgets.spec.ts. Shared by the page (harness/widgets.ts) and the spec.
 */
export interface HarnessWidgetsState {
  /** True once the page is mounted. */
  ready: boolean;
  /** Frames run. */
  ticks: number;
  /** Overlay scale (CSS px per design px of the frame). */
  scale: number;
  /** The bar's value (0..100). */
  bar: number;
  /** The segmented choice's value. */
  segment: string;
  /** The stepper's value. */
  stepper: number;
  /** The select's value. */
  select: string;
  /** `cooldown.ready`. */
  cooldownReady: boolean;
  /** The last spread given to the reticle. */
  reticleSpread: number;
  /** `onChange` calls per widget, in order: `segment:<v>`, `stepper:<v>`, `select:<v>`. */
  changes: string[];
}

export interface HarnessWidgetsApi {
  state: HarnessWidgetsState;
  /** `set` on each widget. The cooldown stops sweeping on its own once `cooldown` is called. */
  set: {
    bar(value: number): void;
    segment(value: string): void;
    stepper(value: number): void;
    select(value: string): void;
    cooldown(fraction: number): void;
    reticle(spread: number): void;
    key(key: string, pad?: string): void;
  };
  /** `reticle.hit()`. */
  hit(): void;
}

declare global {
  interface Window {
    __harnessWidgets?: HarnessWidgetsApi;
  }
}
