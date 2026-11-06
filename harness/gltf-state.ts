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
  /** Materials the loader created (5 on `?pbr`). */
  materials: number;
  /** Engine textures the loader created, one per (image, colour space). */
  maps: number;
  /** True when some mesh is in `VERTEX_LAYOUT_SKINNED` (the `?pbr` cylinder). */
  skinned: boolean;
  /** Meshes in `VERTEX_LAYOUT_3D_TANGENT` (the `?pbr` tile). */
  tangentMeshes: number;
  /** The skin's joint names from `skeletonFromSkin` (`?pbr`), else empty. */
  jointNames: string[];
  /**
   * Screen positions (logical px), recomputed every frame. The default page fills `cube` and
   * `ground`; `?pbr` fills the glowing strip, the empty space beside it, and two spheres of the
   * grid (full metal and dielectric, both fully rough).
   */
  probes: {
    cube: { x: number; y: number };
    ground: { x: number; y: number };
    emissive: { x: number; y: number };
    emissiveSurround: { x: number; y: number };
    metalSphere: { x: number; y: number };
    matteSphere: { x: number; y: number };
  };
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
