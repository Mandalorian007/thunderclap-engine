/**
 * What the IK harness page (harness/ik.html) publishes on `window.__harnessIk` for
 * e2e/ik.spec.ts. Shared by the page (harness/ik.ts) and the spec.
 */

export interface HarnessIkState {
  ready: boolean;
  /** Frames drawn. */
  ticks: number;
  /** Seconds of target motion elapsed (frozen while parked). */
  time: number;
  /** The target's position (skeleton space). */
  target: [number, number, number];
  /** Distance from the arm's tip to the target after the solve (skeleton units). */
  tipError: number;
  /** Angle (radians) between the head's forward axis and the direction to the target. */
  headError: number;
  /** Distance from the shoulder to the target: the arm's reach is 2. */
  reach: number;
  /** True while the target orbits on real time. */
  moving: boolean;
}

export interface HarnessIkApi {
  state: HarnessIkState;
  /** Park (`false`) or resume (`true`) the target's orbit (E-017). */
  setMoving(moving: boolean): void;
  /** Put the target at a point in skeleton space (parks it). */
  setTarget(x: number, y: number, z: number): void;
}

declare global {
  interface Window {
    __harnessIk?: HarnessIkApi;
  }
}
