/**
 * What the arena demo publishes on `window.__demo` for `e2e/demos/arena.spec.ts`. Shared by
 * the page (`main.ts`) and the spec, so the spec asserts behaviour without screenshots.
 */

export interface ArenaDemoState {
  /** True once `createGame` resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' (createGame returned null) or an error message. */
  gpu: string;
  /** Frames presented. */
  frame: number;
  /** Running average of frames per second (exponential, over the last second or so). */
  fps: number;
  /** The fixed-step sim clock, seconds. */
  simTime: number;
  /** The character's ground speed, world units per second. */
  speed: number;
  /** True while the sword swing clip plays. */
  swinging: boolean;
  /** Swings started since load. */
  swings: number;
  /** The character's feet, world units. Starts at the origin. */
  position: [number, number, number];
  /** The character's facing, radians (0 is -z, positive turns right). */
  yaw: number;
  /** The follow camera's yaw and orbit distance. */
  camera: { yaw: number; pitch: number; distance: number };
  /** `renderer.stats.drawCalls` of the last frame (scene pass). */
  drawCalls: number;
  /** `renderer.stats.shadowDraws` of the last frame (instances into the sun's shadow map). */
  shadowDraws: number;
  /** Triangles asked of the scene pass last frame, summed by the demo from each mesh's indices. */
  triangles: number;
  /** `renderer.stats` of the last frame, copied. */
  stats: {
    drawCalls: number;
    instances: number;
    drawables: number;
    culled: number;
    shadowDraws: number;
  };
  /** Points alive in the sword trail. */
  trailPoints: number;
  /**
   * The most points the trail held during the current (or last) swing, read in the sim step
   * before the trail ages them, so a spec asserts the arc was sampled whatever the frame pacing.
   */
  trailPeak: number;
  /** Blade hits on a pillar or an orb since load (one per target per swing); each stamped a decal. */
  hits: number;
  /** Decals alive (`Decals.count`); a scorch lives 12 s. */
  decals: number;
  /** The HUD stamina bar's value, 0..100: a swing costs 25, it refills at 20 per second. */
  stamina: number;
  /** `?still`: the idle bob and the dust are parked. */
  still: boolean;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __demo?: ArenaDemoState;
  }
}
