/**
 * What the quality harness page (harness/quality.html) publishes on `window.__harnessQuality` for
 * e2e/intents-quality.spec.ts. Shared by the page (harness/quality.ts) and the spec.
 */

export interface HarnessQualityState {
  ready: boolean;
  /** Synthetic seconds fed to the governor so far. */
  seconds: number;
  /** `detectTier()` on this page. */
  tier: string;
  reason: string;
  /** The governor: steps shed, its overlay line and the dynamic resolution scale. */
  shed: number;
  line: string;
  scale: number;
  /** The extra knob (a toggle) is shed. */
  glowShed: boolean;
  /** Changes made, oldest first. */
  changes: { at: number; knob: string; dir: 'down' | 'up'; shed: number }[];
}

export interface HarnessQualityApi {
  state: HarnessQualityState;
  /** The synthetic GPU cost of a frame at scale 1, ms (its cost goes with scale²). */
  setLoad(ms: number): void;
}

declare global {
  interface Window {
    __harnessQuality?: HarnessQualityApi;
  }
}
