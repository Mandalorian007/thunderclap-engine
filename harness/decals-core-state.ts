/**
 * What the core-decals page (harness/decals-core.html) publishes on `window.__harnessDecalsCore`
 * for e2e/decals-core.spec.ts. Shared by the page (harness/decals-core.ts) and the spec.
 */

/** A world point on screen: unit-square fractions of the whole canvas. */
export interface DecalsCoreProbe {
  x: number;
  y: number;
}

export interface DecalsCoreEye {
  viewIndex: number;
  /** The eye's half, unit-square fractions of the canvas. */
  screen: { x: number; y: number; width: number; height: number };
  /** Bundles this eye executed last frame (`core.stats.bundles` across its `draw`). */
  bundles: number;
  /** Passes this eye encoded last frame. */
  passes: number;
  /** The ring stamped on the floor and the splat folded over the pillar's corner. */
  probes: { floor: DecalsCoreProbe; corner: DecalsCoreProbe };
}

export interface HarnessDecalsCoreState {
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  frames: number;
  gpuErrors: number;
  /** The decals drawable is on the core. */
  shown: boolean;
  /** `Decals.count`. */
  live: number;
  /** Scattered decals asked for on top of the two placed ones. */
  scatter: number;
  eyes: [DecalsCoreEye, DecalsCoreEye];
  /** Render bundles recorded since boot (`core.stats.bundleBuilds`). */
  bundleBuilds: number;
  /** Drawables on the core. */
  drawables: number;
  /** Device restores done (`core.restores`). */
  restores: number;
}

export interface DecalsCoreSet {
  /** Put the decals drawable on the core or take it off. */
  shown?: boolean;
  /** Scatter this many extra decals over the floor (0 removes them). */
  scatter?: number;
}

export interface HarnessDecalsCoreApi {
  state: HarnessDecalsCoreState;
  set(opts: DecalsCoreSet): void;
  /** Destroy the device, wait for the loss, restore the core on a new one. */
  lose(): Promise<void>;
}

declare global {
  interface Window {
    __harnessDecalsCore?: HarnessDecalsCoreApi;
  }
}
