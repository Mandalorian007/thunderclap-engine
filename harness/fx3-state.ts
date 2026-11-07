/**
 * What the fx-3 page (harness/fx3.html) publishes on `window.__harnessFx3` for
 * e2e/fx3.spec.ts. Shared by the page (harness/fx3.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface Fx3Probe {
  x: number;
  y: number;
}

/** The page's modes, picked by the query (`?sheet`, `?forces`, ...); `sheet` is the default. */
export type Fx3Mode = 'sheet' | 'forces' | 'collide' | 'sub' | 'effect';

export interface HarnessFx3State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  mode: Fx3Mode;
  /** `?still`: the moving point and the lamp are parked. */
  still: boolean;
  /** Frames presented. */
  frames: number;
  /** Seconds of simulation time. */
  time: number;
  logical: { width: number; height: number };
  /** Live particles of the mode's main system (`ParticleSystem.alive`; -1 before the first readback). */
  alive: number;
  /** Whether the page draws its particles this frame. */
  particles: boolean;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
  /**
   * `sheet`: the tile the parked particle shows this frame (the CPU mirror of the kernel's
   * `from + floor(age × rate) % frames` on `tile: [5, 15]` at `tileRate` 2).
   */
  tileSeen: number;
  /**
   * `forces`: the mean distance of the GPU particles from the attractor, from the last
   * `debugReadback()` (every 500 ms; -1 before the first with live particles).
   */
  meanRadius: number;
  /**
   * `forces`: the age (s of simulated time) of the first shell at the first readback that found
   * `meanRadius` below 0.3; -1 until then. Only the first shell counts: later shells are born
   * around the blob of the one before.
   */
  radiusSettledAt: number;
  /**
   * `forces`: the mean distance of 64 shadow particles (the CPU `applyForces` run on the same
   * forces) from the attractor; it shrinks as the attractor pulls them in.
   */
  shadowRadius: number;
  /**
   * `collide`: the mean horizontal speed (units/s) of the drops resting on the slab, measured
   * from the readbacks (every 500 ms): each slot resting on the slab top in two readbacks in a
   * row moved `hypot(dx, dz)` over the simulated time between them. -1 before the second.
   */
  meanDriftPerSec: number;
  /** `collide`: the resting drops that `meanDriftPerSec` averaged (0 before the second readback). */
  restingDrops: number;
  /** `forces` and `collide`: particle readbacks completed. */
  readbacks: number;
  /**
   * `collide`: live particles below the slab's underside (`ParticleSystem.below`); rain over
   * the slab with `collide` stays on top, so it stays near 0 while `alive` grows.
   */
  belowSlab: number;
  /**
   * `sub`: live particles measured after every parent of the last burst has died (-1 until
   * then); only the `onDeath` children can be alive by then.
   */
  aliveAfterParents: number;
  /** `effect`: instances of the attached effect now playing, and live particles over its systems. */
  effectInstances: number;
  effectAlive: number;
  /**
   * Screen positions (logical px) of a world point in front of the clear sky: the parked
   * sprite (`sheet`), the attractor (`forces`), the burst centre (`sub`), the effect's point.
   */
  probe: Fx3Probe;
}

export interface HarnessFx3Api {
  state: HarnessFx3State;
  /** Draw (true) or skip (false) the particles; the scene behind stays the same. */
  setParticles(visible: boolean): void;
}

declare global {
  interface Window {
    __harnessFx3?: HarnessFx3Api;
  }
}
