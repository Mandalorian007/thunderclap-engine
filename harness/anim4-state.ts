/**
 * What the anim-4 harness page (harness/anim4.html) publishes on `window.__harnessAnim4` for
 * e2e/anim4.spec.ts. Shared by the page (harness/anim4.ts) and the spec.
 */

export type HarnessAnim4Mode = 'blend2d' | 'aim' | 'foot' | 'spring' | 'match';

export interface HarnessAnim4State {
  ready: boolean;
  /** Frames drawn. */
  ticks: number;
  /** Seconds of page time elapsed (frozen while parked). */
  time: number;
  mode: HarnessAnim4Mode;
  /** True while the page drives its own motion on real time. */
  moving: boolean;
  /** `blend2d`: the 2D blend parameters and the nine point weights (row-major, y then x). */
  px: number;
  py: number;
  weights: number[];
  /** `aim`: the clamped yaw the chain turned by, and the head forward's angle to the target. */
  headYaw: number;
  headPitch: number;
  headError: number;
  target: [number, number, number];
  /** `foot`: the pelvis's world height and the largest gap between an ankle and its ground. */
  pelvisY: number;
  footGap: number;
  /** `spring`: distance from the cape tip's simulated position to its sampled one. */
  tipLag: number;
  /** `spring`: the instance's x, and the lag on the frame before and on the frame of a teleport. */
  instanceX: number;
  teleported: boolean;
  lagBefore: number;
  lagAfter: number;
  /** `match`: the state playing, the time the other clip started at on the last cut, and the time the clip left was at. */
  matchState: string;
  startTime: number;
  timeBefore: number;
  /** The clips' duration (`match`). */
  duration: number;
}

export interface HarnessAnim4Api {
  state: HarnessAnim4State;
  /** Park (`false`) or resume (`true`) the page's own motion (E-017). */
  setMoving(moving: boolean): void;
  /** `blend2d`: set the blend parameters (parks the orbit). */
  setParams(px: number, py: number): void;
  /** `aim`: put the target at a skeleton-space point (parks the orbit). */
  setTarget(x: number, y: number, z: number): void;
  /** `match`: cut to the other clip over 0.2 s, matching the pose or not. */
  cut(matchPose: boolean): void;
  /** `spring`: jump the instance 5 units on x now. */
  teleport(): void;
}

declare global {
  interface Window {
    __harnessAnim4?: HarnessAnim4Api;
  }
}
