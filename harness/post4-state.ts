/**
 * What the post-4 page (harness/post4.html) publishes on `window.__harnessPost4` for
 * e2e/post4.spec.ts. Shared by the page (harness/post4.ts) and the spec. Every measured value
 * is null until the page has read back the frames it needs.
 */

/** The page's modes, one per flag (`?taa`, `?ssr`, `?blur`, `?ortho`). */
export type Post4Mode = 'taa' | 'ssr' | 'blur' | 'ortho';

export interface HarnessPost4State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  mode: Post4Mode;
  /** `?still`: nothing in the scene moves. */
  still: boolean;
  /**
   * The page's step: 'warm', 'reference', 'converge', 'ghost', 'objectCamera',
   * 'objectVelocity', 'subpixel', 'done' (`?taa`), else 'run'.
   */
  phase: string;
  /** Readbacks completed. */
  readbacks: number;
  /** `PostStack.wantsJitter` and the `PostInputs.view.jitter` of the last frame (target px). */
  wantsJitter: boolean;
  jitter: [number, number];
  /**
   * `?taa` (E-035): the largest |x| and |y| of `jitter` over the frames drawn in the `converge`
   * phase, and in the `subpixel` phase. Latched, so a read after the page has moved on (to the
   * object phases' unjittered frames, or past a hook hand-over frame) still sees what that phase
   * drew with; `jitter` itself is only the last frame's.
   */
  jitterConverge: [number, number];
  jitterSubpixel: [number, number];
  /** `taaActive` / `ssrActive` / `motionBlurActive` of the measured stack, last frame. */
  active: boolean;
  /**
   * `?taa`: the mean absolute difference (0..1 per channel) between the TAA frame after 16
   * jittered frames and the frame with TAA off, over the static scene's flat pixels (texels
   * whose 3×3 neighbourhood in the TAA-off frame spans less than 8/255: edges are where TAA is
   * meant to differ).
   */
  convergedDelta: number | null;
  /**
   * `?taa`: a bright bar slides across a dark band; the largest luma (0..1) above the band's
   * background in the window 2..16 px behind the bar's trailing edge as drawn, with TAA on.
   */
  ghost: number | null;
  /**
   * `?taa` (ws/post-5): a striped cube slides through an `InstanceList` with velocity under the
   * still camera; the mean absolute difference (0..1 per channel) between the TAA frame and the
   * same inputs with TAA off over the cube's screen rect widened by 16 px, averaged over the
   * reads, with `taa.reprojection` `'velocity'` (`ghostObject`) and `'camera'`
   * (`ghostObjectCamera`).
   */
  ghostObject: number | null;
  ghostObjectCamera: number | null;
  /**
   * `?taa` (ws/post-6): the striped cube creeps 0.37 output px a frame with the camera jittered
   * and velocity reprojection on. `blurSubpixel*`: the share of the horizontal gradient energy
   * (sum of squared luma steps) over the cube that the TAA frame lost against the same inputs
   * with TAA off (0 = as sharp, can go negative); `ghostSubpixel*`: the mean absolute
   * difference (0..1 per channel) to the TAA-off frame in the bands 3..14 px beside the cube on
   * both sides. Summed over 12 reads; `taa.historyFilter` `'catmull-rom'` (no suffix: the
   * measured stack) and `'bilinear'` (a twin stack resolving the same frames).
   */
  ghostSubpixel: number | null;
  blurSubpixel: number | null;
  ghostSubpixelBilinear: number | null;
  blurSubpixelBilinear: number | null;
  /** `?taa`: `PostStack.taaVelocityActive` in the last frame. */
  velocityActive: boolean;
  /**
   * `?ssr`: the mean absolute colour difference (0..1) SSR adds over the floor in front of the
   * bright pillar on the smooth half (roughness 0.05) and on the rough half (0.9).
   */
  smoothReflect: number | null;
  roughReflect: number | null;
  /**
   * `?blur`: px along a row through the moving cube (still camera), and along a row through the
   * static background only, where motion blur changed the colour by more than 4/255; the largest
   * over the reads so far.
   */
  cubeBlurPx: number | null;
  backgroundBlurPx: number | null;
  /**
   * `?ortho`: the AO term (AO-on luma over AO-off luma) at a world point 0.25 from the crease of
   * a box on a floor, under an ortho camera at two zooms and distances; the absolute difference
   * of the two terms, and the two terms.
   */
  aoDelta: number | null;
  aoTerms: [number, number] | null;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessPost4Api {
  state: HarnessPost4State;
}

declare global {
  interface Window {
    __harnessPost4?: HarnessPost4Api;
  }
}
