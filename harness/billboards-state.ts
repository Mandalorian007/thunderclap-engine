/**
 * What the billboards page (harness/billboards.html) publishes on `window.__harnessBillboards`
 * for e2e/billboards.spec.ts. Shared by the page (harness/billboards.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface BillboardProbe {
  x: number;
  y: number;
}

/** Seconds a damage number lives (`life`), and its upward drift in world units per second. */
export const DAMAGE_LIFE = 1.2;
export const DAMAGE_RISE = 1.1;

export interface HarnessBillboardsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `Billboards.count`: plates, backings, bars and live damage numbers. */
  count: number;
  /** `Billboards.atlasUsed`: share of the text atlas in use, 0..1. */
  atlasUsed: number;
  /** `Billboards.draws` for the last frame (one per depth mode in use). */
  draws: number;
  /** Damage numbers alive (`handle.alive`). */
  damageAlive: number;
  /** While paused the page does not call `update`; `advance(dt)` steps it by hand. */
  paused: boolean;
  /** Whether the page draws its billboards this frame. */
  visible: boolean;
  /**
   * Screen positions (logical px): the centre of capsule 0's name plate (`plate`), of its
   * health bar (`bar`), and of the most recently spawned damage number's anchor (`damage`;
   * the page integrates `DAMAGE_RISE` over the time it has advanced).
   */
  probes: { plate: BillboardProbe; bar: BillboardProbe; damage: BillboardProbe };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessBillboardsApi {
  state: HarnessBillboardsState;
  /** Stop (true) or resume (false) the per-frame `update` and the periodic damage spawns. */
  setPaused(on: boolean): void;
  /** Step the billboards by `dt` seconds (while paused; deterministic). */
  advance(dt: number): void;
  /** Spawn a damage number over capsule 0 now; returns the count alive afterwards. */
  spawnDamage(): number;
  /** Draw (true) or skip (false) the billboards; everything else stays the same. */
  setVisible(visible: boolean): void;
}

declare global {
  interface Window {
    __harnessBillboards?: HarnessBillboardsApi;
  }
}
