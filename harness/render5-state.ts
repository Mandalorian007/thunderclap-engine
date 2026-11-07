/**
 * What the render-5 page (harness/render5.html) publishes on `window.__harnessRender5` for
 * e2e/render5.spec.ts. Shared by the page (harness/render5.ts) and the spec.
 */

/** The page's modes, one per flag (`?ktx2`, `?lod`, `?dissolve`, `?mask`). */
export type Render5Mode = 'ktx2' | 'lod' | 'dissolve' | 'mask';

export interface HarnessRender5State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  mode: Render5Mode;
  /** `?still`: the scene is frozen at its first pose (no motion, a fixed dissolve amount). */
  still: boolean;
  /** `?lod&instanced`: the rocks are one `InstanceList` on the `MeshLod`. */
  instanced: boolean;
  /** `renderer.caps.compressed` of the page's device. */
  caps: { bc: boolean; etc2: boolean; astc: boolean };
  /**
   * `?ktx2`: the uploaded texture's format (`'bc1-rgba-unorm-srgb'` when the device has BC), or
   * the format the error named; null before the upload.
   */
  format: string | null;
  /** `?ktx2`: true when `uploadKtx2` put the in-page BC1 file on the GPU. */
  uploaded: boolean;
  /** `?ktx2`: mip levels of the uploaded texture (0 when it did not upload). */
  mipLevels: number;
  /** `?ktx2`: the `CompressedTextureError` message when the device lacks BC, else null. */
  error: string | null;
  /** `?lod`: `renderer.stats.lodCounts` of the last frame (instances per level). */
  lodCounts: number[];
  /** `renderer.stats.drawCalls` of the last frame. */
  drawCalls: number;
  instances: number;
  /** `?dissolve`: the dissolve amount the last frame drew with (0..1). */
  amount: number;
  /**
   * `?lod&instanced`: `renderer.stats.drawCalls` of the last frame, the list being the only
   * draw: one per non-empty level of `lodCounts`. 0 in every other mode.
   */
  instancedDraws: number;
  /**
   * `?mask`: grid samples (of `shadowSamples`) inside the masked quad's shadow brighter than
   * halfway between `litRef` and `darkRef`: light through the mask's holes. Updated per
   * readback (`readbacks`).
   */
  shadowHolePx: number;
  /** `?mask`: the grid samples at or below the halfway line (shadowed by the mask's cells). */
  shadowDarkPx: number;
  /** `?mask`: grid samples per readback (32 × 32); 0 before the first. */
  shadowSamples: number;
  /** `?mask`: luminance of lit ground, and of the solid quad's shadow. */
  litRef: number;
  darkRef: number;
  /** `?mask`: probe readbacks that arrived. */
  readbacks: number;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessRender5Api {
  state: HarnessRender5State;
  /** `?dissolve`: pin the amount (the page stops cycling it). */
  setAmount(amount: number): void;
}

declare global {
  interface Window {
    __harnessRender5?: HarnessRender5Api;
  }
}
