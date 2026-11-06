/**
 * What the voxel page (harness/voxel.html) publishes on `window.__harnessVoxel` for
 * e2e/voxel.spec.ts. Shared by the page (harness/voxel.ts) and the spec.
 */

export interface HarnessVoxelState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** `?still`: the sun parked, nothing moves but the player. */
  still: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** The first-person view: yaw (+ turns right) and pitch (+ looks up), radians. */
  yaw: number;
  pitch: number;
  /** The eye, world units. */
  position: [number, number, number];
  /** `look.locked`. */
  locked: boolean;
  /** `VoxelChunksStats` of the last frame. */
  chunks: number;
  drawn: number;
  culled: number;
  triangles: number;
  growths: number;
  remeshes: number;
  remeshMs: number;
  /** The block the centre ray hits (`raycastVoxels` from the eye, 8 units), else null. */
  hit: [number, number, number] | null;
  /** Blocks broken and placed so far. */
  broken: number;
  placed: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessVoxelApi {
  state: HarnessVoxelState;
  /** Point the view: yaw and pitch in radians. */
  aim(yaw: number, pitch: number): void;
  /** Break the block under the centre ray (what a click does). */
  break(): boolean;
  /** Place a block against the face under the centre ray (what the secondary button does). */
  place(): boolean;
}

declare global {
  interface Window {
    __harnessVoxel?: HarnessVoxelApi;
  }
}
