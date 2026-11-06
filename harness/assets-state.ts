/**
 * What the assets demo page (harness/assets.html) publishes on `window.__harnessAssets` for
 * e2e/assets.spec.ts. Shared by the page (harness/assets.ts) and the spec.
 */

export interface HarnessAssetsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The page's query flags as it read them. */
  flags: { slow: boolean; fail: string | null; cancel: boolean };
  /** `bundle.progress` copied on every progress event. */
  progress: {
    loaded: number;
    failed: number;
    total: number;
    bytes: number;
    bytesTotal: number | null;
    fraction: number;
  };
  /** Keys in the order their `asset` event fired. */
  loaded: string[];
  /** `bundle.errors` (key, uri, message). */
  errors: { key: string; uri: string | null; message: string }[];
  /** The packed atlas sheet size and how many rects it holds. */
  atlasSize: { width: number; height: number };
  rectCount: number;
  /** Screen position (logical px) of one atlas sprite's centre and the colour it was drawn with. */
  spritePixel: { x: number; y: number; name: string; color: [number, number, number] };
  /** A few decoded values, so the spec can check the kinds beyond counts. */
  decoded: {
    json: unknown;
    text: string | null;
    bytes: number;
    audioFrames: number;
    gltfMeshes: number;
    textureArrayLayers: number;
    imageWidth: number;
  };
  /** How many times `read` was called (dedupe: one shared uri is read once). */
  reads: number;
  /** `done` event fired. */
  done: boolean;
  /** `bundle.load()` resolved (or rejected: see `loadError`). */
  settled: boolean;
  loadError: string | null;
  cancelled: boolean;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessAssets?: { state: HarnessAssetsState };
  }
}
