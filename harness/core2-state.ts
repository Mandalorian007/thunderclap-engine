/**
 * What the core-2 page (harness/core2.html) publishes on `window.__harnessCore2` for
 * e2e/core2.spec.ts. Shared by the page (harness/core2.ts) and the spec.
 */
export type Core2Mode = 'random' | 'noise' | 'timer' | 'preload';

/** FNV-1a over the u32s of the first 100 draws of `createRandom('core2')`; pinned in random.test.ts. */
export const CORE2_RANDOM_CHECKSUM = 156046407;

/** FNV-1a over the 1e-4-quantised `?noise` field at time 0; pinned in noise.test.ts. */
export const CORE2_NOISE_CHECKSUM = 3460057681;

export interface HarnessCore2State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  mode: Core2Mode;
  /** `?still`: nothing animates (the scheduler is paused, the noise field does not drift). */
  still: boolean;
  /** Frames presented. */
  frames: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;

  // ?random
  /** Points scattered (1000 per forked stream). */
  points: number;
  /** FNV-1a over the u32s of the first 100 draws of `createRandom('core2')`. */
  checksum: number;
  /** The same over the first 100 draws of `createRandom('core2').fork('left')`. */
  forkChecksum: number;

  // ?noise
  /** Range and FNV-1a checksum (values quantised to 1e-4) of the field at time 0. */
  min: number;
  max: number;
  /** Cells in the field (columns × rows). */
  cells: number;

  // ?timer
  /** Timer callbacks fired so far (blinks, the chain and the auto-use). */
  fires: number;
  cooldownReady: boolean;
  /** Successful auto-uses of the cooldown (one per 2 s cycle). */
  cooldownUses: number;
  /** Times the cooldown went from not ready back to ready (latched, so a poll cannot miss it). */
  readyTransitions: number;
  /** `cooldown.progress`, 0..1. */
  cooldownProgress: number;
  /** Scheduler time, seconds. */
  timerTime: number;

  // ?preload
  /** 'old' (the first scene runs), 'preload', 'enter' (the new scene entered), 'done' (loading closed). */
  phase: 'boot' | 'old' | 'preload' | 'enter' | 'done';
  /** Updates the old scene ran while the new scene's preload was pending. */
  oldSceneFrames: number;
  /** Seconds the preload took on the game's clock. */
  preloadSeconds: number;
  /** Whether the `push` promise resolved and, at that moment, the new scene was on top. */
  pushResolved: boolean;
  /** The loading screen was visible during the preload. */
  loadingShown: boolean;
}

export interface HarnessCore2Api {
  state: HarnessCore2State;
  /** ?timer: `cooldown.use()` now; the result. */
  useCooldown(): boolean;
  /** ?timer: `cooldown.reset()` (ready now). */
  resetCooldown(): void;
}

declare global {
  interface Window {
    __harnessCore2?: HarnessCore2Api;
  }
}
