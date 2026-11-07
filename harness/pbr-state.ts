/**
 * What the PBR demo page (harness/pbr.html) publishes on `window.__harnessPbr` for
 * e2e/pbr.spec.ts. Shared by the page (harness/pbr.ts) and the spec.
 */
import type { PerfSample } from '@thunderclap-engine/engine/ui';

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface PbrProbe {
  x: number;
  y: number;
}

export interface HarnessPbrState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The orbit: yaw and pitch in radians, distance in world units, and the eye it places. */
  camera: { yaw: number; pitch: number; distance: number; eye: [number, number, number] };
  /** The sphere grid: metallic 0..1 across `cols`, roughness 0..1 down `rows`. */
  grid: { cols: number; rows: number };
  /**
   * Screen positions (logical px) of four world points, recomputed every frame: `rough`, the
   * centre of the rough dielectric sphere (metallic 0, roughness 1) as seen from the eye;
   * `highlight`, the sun's specular highlight on the mid-roughness metal sphere (metallic 1,
   * roughness 0.5; the point whose normal is the half vector of the sun and the eye);
   * `tileLit` and `tileDark`, two points on the flat normal-mapped tile where the bump's slope
   * faces toward and away from the sun. Only the normal map tells them apart. `spotIn` and
   * `spotOut`, the floor under the spot light's axis and the floor at the same depth outside its
   * cone, reached by no other lamp. `litSphere` and `maskedSphere`, the camera-facing point of
   * each sphere of the masked pair: same material, tint, size and distance from the pair's lamp,
   * which is masked to the lit sphere's layer.
   */
  probes: {
    rough: PbrProbe;
    highlight: PbrProbe;
    tileLit: PbrProbe;
    tileDark: PbrProbe;
    spotIn: PbrProbe;
    spotOut: PbrProbe;
    litSphere: PbrProbe;
    maskedSphere: PbrProbe;
  };
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
  /** `createPerfMonitor().sample(renderer)` after each frame (ws/perf-overlay). */
  perf: PerfSample | null;
  /**
   * `frame.lights`: whether the sun has a colour, how many point and spot lights, shadow and fog
   * on.
   */
  lights: { sun: boolean; points: number; spots: number; shadow: boolean; fog: boolean };
  /** Standard materials created by the page. */
  materials: number;
  /**
   * Meshes in `VERTEX_LAYOUT_3D_TANGENT` drawn per frame (ws/render-4): 1 with `?tangents`, a
   * floor tile with file tangents from `computeTangents` under the normal-mapped material, 0
   * otherwise.
   */
  tangentMeshes: number;
}

export interface HarnessPbrApi {
  state: HarnessPbrState;
}

declare global {
  interface Window {
    __harnessPbr?: HarnessPbrApi;
  }
}
