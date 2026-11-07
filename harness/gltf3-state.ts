/**
 * What the glTF extensions page (harness/gltf3.html) publishes on `window.__harnessGltf3` for
 * e2e/gltf3.spec.ts. Shared by the page (harness/gltf3.ts) and the spec.
 */

export type Gltf3Mode = 'quant' | 'meshopt' | 'lights' | 'variants' | 'cache';

export interface HarnessGltf3State {
  /** True once boot and the mode's loads resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  mode: Gltf3Mode;
  /** `?still`: time-driven changes (the variant cycle) are parked. */
  still: boolean;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `GltfDocument.warnings` of every file the mode parsed. */
  warnings: string[];
  /** `?quant`: largest world-space distance between a quantized and a float vertex. */
  maxError: number;
  /** `?meshopt`: triangles in the decoded rock. */
  triangles: number;
  /** `?meshopt`: decoded positions, normals and indices equal the uncompressed twin's. */
  match: boolean;
  /** `?meshopt`: GLB sizes, compressed and plain. */
  bytes: { packed: number; plain: number };
  /** `?lights`: the file's lights as the loader converted them, and whether it had a camera. */
  lights: { directional: number; points: number; spots: number; camera: boolean };
  /** `?variants`: the file's variants, the active one and the torso's glTF material index. */
  variants: string[];
  variant: string | null;
  materialId: number | null;
  /** `?variants`: every variant the page has shown so far, in order of first appearance. */
  seen: string[];
  /** `?cache`: `cache.stats` after the loads, the keys still resident and those evicted. */
  stats: { bytes: number; entries: number; hits: number; misses: number; evictions: number };
  budget: number;
  resident: string[];
  evicted: string[];
  /** `?cache`: `read` calls (one per miss: concurrent acquires share one). */
  reads: number;
  /** Named screen positions (logical px) for pixel probes; which ones depend on the mode. */
  probes: Record<string, { x: number; y: number }>;
  /** The frame's linear clear colour. */
  clear: [number, number, number];
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessGltf3?: { state: HarnessGltf3State };
  }
}
