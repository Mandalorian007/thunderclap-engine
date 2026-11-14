import { FullscreenPass, type FullscreenPassDesc } from '../render/fullscreen';
import type { JitterFn, PostProcessor } from '../render/renderer';
import { defaultTextures } from '../render/texture';

/**
 * What a post stack needs from whatever drives it (ws/post-fit): the device, the output format,
 * two samplers, a way to make fullscreen passes, the sizes, a jitter hook and an optional pass
 * timer. A `Renderer` is one; `createPostHost` makes one without the renderer, so a game that
 * draws through the retained core (`createRenderCore` + `createCorePost`) does not bundle it.
 */
export interface PostHost {
  readonly device: GPUDevice;
  /** The output format: what the composite (and FXAA) write unless `PostStackOptions.format`. */
  readonly format: GPUTextureFormat;
  readonly samplers: Readonly<Record<'linear-clamp' | 'nearest-clamp', GPUSampler>>;
  /** Scene size (internal resolution): the stack's starting size. */
  readonly width: number;
  readonly height: number;
  /** The design size `godRays.x`/`y` and `sourceRadius` are measured in. */
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  /** The output's size, used by an encode without a viewport. */
  readonly outputWidth: number;
  readonly outputHeight: number;
  /**
   * The processor the host runs, if it tracks one (`Renderer.post`). A stack whose TAA jitter
   * hook finds it `null` takes the hook back (ws/post-7). Undefined: not tracked.
   */
  readonly post?: PostProcessor | null;
  /** The jitter hook installed with `setJitter` (compared by identity). */
  readonly jitter: JitterFn | null;
  /** Install (or with `null` remove) the hook TAA drives the sub-pixel jitter with. */
  setJitter(fn: JitterFn | null): void;
  /** Pass timestamps (`GpuTimer`): `pass(label)` gives the writes on a sampled frame. */
  readonly gpuTimer: {
    pass(label: string): GPURenderPassTimestampWrites | undefined;
  } | null;
  createFullscreenPass(desc: FullscreenPassDesc): FullscreenPass;
}

/** Options for `createPostHost`. */
export interface PostHostOptions {
  /** Scene size (default 1 × 1; `resize` keeps it current). */
  width?: number;
  height?: number;
  /** Output size (default: the scene size). */
  outputWidth?: number;
  outputHeight?: number;
  /** Design size for god-ray placement (default 1920 × 1080, as a `Renderer`'s). */
  logicalWidth?: number;
  logicalHeight?: number;
  /** Timestamps for the stack's passes (a `GpuTimer`), else none. */
  gpuTimer?: PostHost['gpuTimer'];
}

/**
 * A `PostHost` the game owns (`createPostHost`): its sizes are fields it sets with `resize`,
 * and its jitter hook is stored for the game to call (`jitter?.(frame)`) when it jitters its
 * own views.
 */
export class PostHostState implements PostHost {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly samplers: Readonly<Record<'linear-clamp' | 'nearest-clamp', GPUSampler>>;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
  outputWidth: number;
  outputHeight: number;
  gpuTimer: PostHost['gpuTimer'];
  private jitterFn: JitterFn | null = null;
  private readonly white: GPUTextureView;

  constructor(device: GPUDevice, format: GPUTextureFormat, opts: PostHostOptions = {}) {
    this.device = device;
    this.format = format;
    this.samplers = {
      'linear-clamp': device.createSampler({
        label: 'post-linear-clamp',
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      'nearest-clamp': device.createSampler({
        label: 'post-nearest-clamp',
        magFilter: 'nearest',
        minFilter: 'nearest',
      }),
    };
    this.white = defaultTextures(device).white.view;
    this.width = Math.max(1, opts.width ?? 1);
    this.height = Math.max(1, opts.height ?? 1);
    this.outputWidth = Math.max(1, opts.outputWidth ?? this.width);
    this.outputHeight = Math.max(1, opts.outputHeight ?? this.height);
    this.logicalWidth = opts.logicalWidth ?? 1920;
    this.logicalHeight = opts.logicalHeight ?? 1080;
    this.gpuTimer = opts.gpuTimer ?? null;
  }

  /** Set the scene size and the output size (default: the scene size). */
  resize(width: number, height: number, outputWidth = width, outputHeight = height): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.outputWidth = Math.max(1, Math.floor(outputWidth));
    this.outputHeight = Math.max(1, Math.floor(outputHeight));
  }

  get jitter(): JitterFn | null {
    return this.jitterFn;
  }

  setJitter(fn: JitterFn | null): void {
    this.jitterFn = fn;
  }

  createFullscreenPass(desc: FullscreenPassDesc): FullscreenPass {
    const kind = desc.sampler === 'nearest-clamp' ? 'nearest-clamp' : 'linear-clamp';
    return new FullscreenPass(this.device, desc, this.samplers[kind], this.white);
  }
}

/**
 * A post-only host (ws/post-fit): `new PostStack(createPostHost(device, format, opts))` runs the
 * whole stack without a `Renderer`. Keep its sizes current with `host.resize`; while TAA runs,
 * jitter your views by `host.jitter?.(frame)` and tell `CorePost.setJitter`.
 */
export function createPostHost(
  device: GPUDevice,
  format: GPUTextureFormat,
  opts?: PostHostOptions,
): PostHostState {
  return new PostHostState(device, format, opts);
}
