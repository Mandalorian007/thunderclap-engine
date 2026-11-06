/**
 * What the glTF demo page (harness/gltf.html) publishes on `window.__harnessGltf` for
 * e2e/gltf.spec.ts. Shared by the page (harness/gltf.ts) and the spec.
 */

export interface HarnessGltfState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** What `loadGltf` produced: draws (node × primitive), meshes, textures, materials, transforms. */
  counts: {
    nodes: number;
    meshes: number;
    textures: number;
    materials: number;
    transforms: number;
  };
  /** `GltfDocument.warnings` and `externalUris` (both expected empty for the built-in GLB). */
  warnings: string[];
  externalUris: string[];
  /** The scene's world bounds as the loader reports them. */
  bounds: { center: [number, number, number]; radius: number };
  /** Screen position (logical px) of the cube's centre, recomputed every frame. */
  probes: { cube: { x: number; y: number }; ground: { x: number; y: number } };
  /** The orbit: yaw and pitch in radians, distance in world units. */
  camera: { yaw: number; pitch: number; distance: number };
  /** The frame's linear clear colour, so the spec knows what "background" looks like. */
  clear: [number, number, number];
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number };
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessGltf?: { state: HarnessGltfState };
  }
}
