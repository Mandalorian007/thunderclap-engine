/**
 * What the retarget harness page (harness/retarget.html) publishes on `window.__harnessRetarget`
 * for e2e/retarget.spec.ts. Shared by the page (harness/retarget.ts) and the spec.
 */

export type Vec3 = [number, number, number];

export interface HarnessRetargetState {
  ready: boolean;
  /** Frames drawn. */
  ticks: number;
  /** Seconds of clip time elapsed (frozen while parked). */
  time: number;
  /** True while the clip plays on real time. */
  moving: boolean;
  /** World-space height of the source rig's waving hand (skeleton units). */
  sourceTipY: number;
  /** World-space height of the target rig's waving hand (skeleton units). */
  targetTipY: number;
  /** Unit direction of the source's forearm bone (elbow → hand) in world space. */
  sourceHandDir: Vec3;
  /** Unit direction of the target's forearm bone (elbow → hand) in world space. */
  targetHandDir: Vec3;
  /** Target joints the map found no source for (`RetargetMap.unmatched`). */
  unmatched: string[];
}

export interface HarnessRetargetApi {
  state: HarnessRetargetState;
  /** Park (`false`) or resume (`true`) the clip (E-017). */
  setMoving(moving: boolean): void;
}

/**
 * Pure check used by the spec: the two hand directions of one state snapshot agree within
 * `radians` (angle between the unit vectors).
 */
export function handDirectionsMatch(state: HarnessRetargetState, radians = 1e-3): boolean {
  const a = state.sourceHandDir;
  const b = state.targetHandDir;
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot))) <= radians;
}

declare global {
  interface Window {
    __harnessRetarget?: HarnessRetargetApi;
  }
}
