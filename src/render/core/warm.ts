/**
 * Pipeline warming (ws/warm-voxel-fit, B13). WebKit (Metal) compiles a render pipeline at its
 * first draw, not when it is created, and on a shader-cache miss that draw blocks the page for
 * hundreds of milliseconds, outside any JS task (Forge #801). A pipeline first drawn mid-play (a
 * draw set's first non-empty frame, casters when shadows turn on, a post pass enabled, an effect
 * that starts) stalls the game there. One empty `draw(0)` in a pass whose formats match moves
 * the cost to that draw.
 *
 * A `PipelineWarmer` (one per device, `pipelineWarmer(device)`) queues such draws and encodes
 * them into tiny scratch passes (1×1 attachments of the right formats, stored as `'discard'`):
 * nothing reaches any real target, so the picture is unchanged. The render core queues its own
 * pipelines (empty draw sets, idle casters, inactive drawables) and encodes the queue in
 * `prepare` and `draw`; a `FullscreenPass` queues itself when made and encodes the queue before
 * its first pass. Nothing is queued in steady state, so a frame after the first costs nothing.
 */

/** The formats of the pass a pipeline draws in, and what its draw binds (`warm`). */
export interface WarmTarget {
  /** Colour formats in attachment order (`null`: an unused slot). Default: none. */
  color?: GPUTextureFormat | readonly (GPUTextureFormat | null)[];
  /** The depth-stencil format, if the pipeline has a depth-stencil state. */
  depth?: GPUTextureFormat;
  /** The pipeline's `multisample.count` (default 1). */
  sampleCount?: number;
  /** Bind groups at 0, 1, … (the pipeline's layout must accept them). Default: none. */
  groups?: readonly GPUBindGroup[];
  /**
   * Vertex buffer slots the pipeline reads (0 … n-1): each gets a small scratch buffer, enough
   * for a draw of zero vertices. Default 0.
   */
  vertexBuffers?: number;
  /**
   * Bind what the draw needs instead of `groups` and `vertexBuffers` (called inside the scratch
   * pass, after `setPipeline`); returns the GPU calls it made.
   */
  bind?: (pass: GPURenderPassEncoder) => number;
}

/** @internal A queued warm: formats, and what it records into the scratch pass. */
interface WarmJob {
  key: string;
  color: (GPUTextureFormat | null)[];
  depth: GPUTextureFormat | undefined;
  samples: number;
  run: (pass: GPURenderPassEncoder) => number;
}

/** Bytes of the scratch vertex buffer: covers one instance of any legal stride (≤ 2048). */
const SCRATCH_VERTEX_BYTES = 2048;

/**
 * Empty first draws for pipelines, encoded into scratch passes on the next `encode` (see the
 * module comment). One per device: `pipelineWarmer(device)`.
 */
export class PipelineWarmer {
  /**
   * Queue and encode warms (default true). Off: `warm` and `job` drop what they are given (a
   * pipeline is then compiled at its first real draw).
   */
  enabled = true;
  /** Pipelines warmed so far (empty draws encoded). */
  warmed = 0;
  /** Scratch passes encoded so far. */
  passes = 0;
  private readonly device: GPUDevice;
  private readonly queue: WarmJob[] = [];
  private readonly textures = new Map<string, GPUTextureView>();
  private vertexScratch: GPUBuffer | null = null;
  private readonly sampled = new Map<string, GPUTextureView>();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** Warms waiting for the next `encode`. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Queue `pipeline`'s empty first draw in a pass of `target`'s formats, encoded by the next
   * `encode` (a render core's next `prepare` or `draw`, or the next post pass on this device).
   */
  warm(pipeline: GPURenderPipeline, target: WarmTarget = {}): void {
    if (!this.enabled) return;
    const groups = target.groups;
    const vbs = target.vertexBuffers ?? 0;
    const bind = target.bind;
    this.job(target, (pass) => {
      pass.setPipeline(pipeline);
      let calls = 2;
      if (bind) calls += bind(pass);
      else {
        if (groups) for (let i = 0; i < groups.length; i++) pass.setBindGroup(i, groups[i]!);
        calls += groups?.length ?? 0;
        if (vbs > 0) {
          const b = this.scratchVertex();
          for (let i = 0; i < vbs; i++) pass.setVertexBuffer(i, b);
          calls += vbs;
        }
      }
      pass.draw(0);
      return calls;
    });
  }

  /**
   * @internal Queue a warm that records itself (`run` sets its pipelines, binds and draws 0;
   * returns its GPU calls) into a pass of `target`'s formats.
   */
  job(target: WarmTarget, run: (pass: GPURenderPassEncoder) => number): void {
    if (!this.enabled) return;
    const c = target.color;
    const color: (GPUTextureFormat | null)[] =
      c === undefined ? [] : typeof c === 'string' ? [c] : c.slice();
    const samples = target.sampleCount ?? 1;
    const depth = target.depth;
    const key = `${color.join(',')}|${depth ?? ''}|${samples}`;
    this.queue.push({ key, color, depth, samples, run });
  }

  /** A scratch buffer to bind at a vertex slot for an empty draw. */
  scratchVertex(): GPUBuffer {
    this.vertexScratch ??= this.device.createBuffer({
      label: 'warm vertex scratch',
      size: SCRATCH_VERTEX_BYTES,
      usage: GPUBufferUsage.VERTEX,
    });
    return this.vertexScratch;
  }

  /**
   * A 1×1 texture view to bind where a warm draw's layout samples one (`depth`: a
   * `depth32float`, else an `rgba8unorm`), of view `dimension` (default `'2d'`; depth is 2D
   * only). It is never read, since nothing is drawn.
   */
  scratchSampled(depth = false, dimension: GPUTextureViewDimension = '2d'): GPUTextureView {
    const dim = depth ? '2d' : dimension;
    const key = `${depth ? 'depth' : 'color'}|${dim}`;
    let v = this.sampled.get(key);
    if (!v) {
      const layers = dim === 'cube' || dim === 'cube-array' ? 6 : 1;
      v = this.device
        .createTexture({
          label: `warm sampled scratch ${key}`,
          size: [1, 1, layers],
          dimension: dim === '3d' ? '3d' : dim === '1d' ? '1d' : '2d',
          format: depth ? 'depth32float' : 'rgba8unorm',
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            (dim === '2d' ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
        })
        .createView({ dimension: dim });
      this.sampled.set(key, v);
    }
    return v;
  }

  /**
   * Encode every queued warm into `encoder`: one scratch pass per distinct set of formats.
   * Returns the GPU calls made (0 when nothing waits: the steady state).
   */
  encode(encoder: GPUCommandEncoder): number {
    const q = this.queue;
    if (q.length === 0) return 0;
    let calls = 0;
    while (q.length > 0) {
      const key = q[0]!.key;
      const first = q[0]!;
      const pass = encoder.beginRenderPass({
        label: 'warm',
        colorAttachments: first.color.map((f, slot) =>
          f === null
            ? null
            : { view: this.scratch(f, first.samples, slot), loadOp: 'clear', storeOp: 'discard' },
        ),
        depthStencilAttachment: first.depth
          ? {
              view: this.scratch(first.depth, first.samples, -1),
              ...(hasDepth(first.depth)
                ? { depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 }
                : {}),
              ...(hasStencil(first.depth)
                ? { stencilLoadOp: 'clear', stencilStoreOp: 'discard' }
                : {}),
            }
          : undefined,
      });
      calls += 2;
      this.passes++;
      // Every job of these formats, in the order queued; the rest stay for the next pass.
      let w = 0;
      for (let i = 0; i < q.length; i++) {
        const j = q[i]!;
        if (j.key === key) {
          calls += j.run(pass) + 1;
          this.warmed++;
        } else q[w++] = j;
      }
      q.length = w;
      pass.end();
    }
    return calls;
  }

  /** Drop what is queued and the scratch targets (device loss, teardown). */
  destroy(): void {
    this.queue.length = 0;
    this.textures.clear();
    this.sampled.clear();
    this.vertexScratch?.destroy();
    this.vertexScratch = null;
  }

  /** A 1×1 attachment per format, sample count and slot (two slots of one format can't share). */
  private scratch(format: GPUTextureFormat, samples: number, slot: number): GPUTextureView {
    const key = `${format}|${samples}|${slot}`;
    let v = this.textures.get(key);
    if (!v) {
      v = this.device
        .createTexture({
          label: `warm scratch ${format}`,
          size: [1, 1],
          format,
          sampleCount: samples,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        .createView();
      this.textures.set(key, v);
    }
    return v;
  }
}

function hasDepth(f: GPUTextureFormat): boolean {
  return f !== 'stencil8';
}

function hasStencil(f: GPUTextureFormat): boolean {
  return f === 'stencil8' || f === 'depth24plus-stencil8' || f === 'depth32float-stencil8';
}

const warmers = new WeakMap<GPUDevice, PipelineWarmer>();

/** The device's pipeline warmer (made on first use; a new device gets its own). */
export function pipelineWarmer(device: GPUDevice): PipelineWarmer {
  let w = warmers.get(device);
  if (!w) {
    w = new PipelineWarmer(device);
    warmers.set(device, w);
  }
  return w;
}

/**
 * Queue `pipeline`'s empty first draw on `device`'s warmer (`PipelineWarmer.warm`): a game's
 * own pipeline that a frame draws only sometimes, compiled at load instead of mid-play.
 */
export function warmPipeline(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  target?: WarmTarget,
): void {
  pipelineWarmer(device).warm(pipeline, target);
}
