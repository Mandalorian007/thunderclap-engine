/**
 * Auto-exposure (ws/post-3). Two compute passes over the scene colour: `histogram` bins the
 * log2 luminance of every texel into 64 bins over `EXPOSURE_LOG_MIN..EXPOSURE_LOG_MAX`
 * (workgroup-shared counts, then one atomic add per bin), `average` has one thread walk the
 * bins between the `histogramLow..histogramHigh` percentiles and write the weighted mean log
 * luminance. The stack copies that into a mappable buffer, maps it when the previous frame's
 * copy has landed, and eases its EV toward `exposureTarget(...)` with `adaptExposure` each
 * frame on the CPU. `exposureHistogram` and `exposureAverage` are the same two kernels in
 * TypeScript, for tests and for a CPU reference.
 */
import type { Renderer } from '../render/renderer';
import { createShaderModule } from '../render/wgsl';

export const EXPOSURE_BINS = 64;
/** log2 luminance of the first bin's lower edge (2^-10 ≈ 0.001). */
export const EXPOSURE_LOG_MIN = -10;
/** log2 luminance of the last bin's upper edge (2^6 = 64). */
export const EXPOSURE_LOG_MAX = 6;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** The bin (0..63) a luminance falls in; black and anything under the range land in bin 0. */
export function exposureBin(luminance: number): number {
  if (!(luminance > 0)) return 0;
  const t = (Math.log2(luminance) - EXPOSURE_LOG_MIN) / (EXPOSURE_LOG_MAX - EXPOSURE_LOG_MIN);
  return Math.min(EXPOSURE_BINS - 1, Math.max(0, Math.floor(t * EXPOSURE_BINS)));
}

/** log2 luminance at the centre of bin `i`. */
export function exposureBinLog(i: number): number {
  return EXPOSURE_LOG_MIN + ((i + 0.5) / EXPOSURE_BINS) * (EXPOSURE_LOG_MAX - EXPOSURE_LOG_MIN);
}

/**
 * CPU reference of the histogram kernel: `rgba` holds `count` linear RGBA texels (any
 * `ArrayLike`); `out` (64 entries) receives the counts (cleared first).
 */
export function exposureHistogram(
  rgba: ArrayLike<number>,
  count: number,
  out: Uint32Array = new Uint32Array(EXPOSURE_BINS),
): Uint32Array {
  out.fill(0);
  for (let i = 0; i < count; i++) {
    const l = LUMA_R * rgba[i * 4]! + LUMA_G * rgba[i * 4 + 1]! + LUMA_B * rgba[i * 4 + 2]!;
    out[exposureBin(l)]!++;
  }
  return out;
}

/**
 * CPU reference of the average kernel: the mean log2 luminance of the texels between the
 * `low` and `high` percentiles of `hist` (bins partially inside the range count partially).
 * Returns `EXPOSURE_LOG_MIN` for an empty histogram.
 */
export function exposureAverage(hist: ArrayLike<number>, low: number, high: number): number {
  let total = 0;
  for (let i = 0; i < EXPOSURE_BINS; i++) total += hist[i]!;
  if (total <= 0) return EXPOSURE_LOG_MIN;
  const lo = total * Math.min(1, Math.max(0, low));
  const hi = total * Math.min(1, Math.max(0, high));
  let seen = 0;
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < EXPOSURE_BINS; i++) {
    const n = hist[i]!;
    const start = seen;
    seen += n;
    // The part of this bin inside [lo, hi].
    const inside = Math.max(0, Math.min(seen, hi) - Math.max(start, lo));
    if (inside > 0) {
      sum += inside * exposureBinLog(i);
      weight += inside;
    }
  }
  return weight > 0 ? sum / weight : EXPOSURE_LOG_MIN;
}

/** The EV the metered average asks for: `log2(keyValue / average)`, clamped to the range. */
export function exposureTarget(
  averageLog: number,
  keyValue: number,
  minEv: number,
  maxEv: number,
): number {
  const ev = Math.log2(Math.max(keyValue, 1e-6)) - averageLog;
  return Math.min(maxEv, Math.max(minEv, ev));
}

/**
 * One step of the adaptation: `ev` eased toward `target` over `dt` seconds, at `speedUp`
 * per second when rising and `speedDown` when falling (exponential, so it settles without
 * overshoot and a long `dt` lands on the target).
 */
export function adaptExposure(
  ev: number,
  target: number,
  dt: number,
  speedUp: number,
  speedDown: number,
): number {
  const speed = target > ev ? speedUp : speedDown;
  if (!(speed > 0) || !(dt > 0)) return ev;
  return target + (ev - target) * Math.exp(-speed * dt);
}

/** Bytes of the params block the kernels read: low, high, -, - (as f32). */
const PARAM_FLOATS = 4;

const HISTOGRAM_WGSL = /* wgsl */ `
struct Params { low: f32, high: f32, pad0: f32, pad1: f32 };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> hist: array<atomic<u32>, ${EXPOSURE_BINS}>;
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> local: array<atomic<u32>, ${EXPOSURE_BINS}>;

const LOG_MIN: f32 = ${EXPOSURE_LOG_MIN}.0;
const LOG_RANGE: f32 = ${EXPOSURE_LOG_MAX - EXPOSURE_LOG_MIN}.0;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li < ${EXPOSURE_BINS}u) {
    atomicStore(&local[li], 0u);
  }
  workgroupBarrier();
  let dim = textureDimensions(colorTex);
  if (gid.x < dim.x && gid.y < dim.y) {
    let c = textureLoad(colorTex, vec2i(gid.xy), 0).rgb;
    let l = dot(c, vec3f(${LUMA_R}, ${LUMA_G}, ${LUMA_B}));
    var bin = 0u;
    if (l > 0.0) {
      let t = (log2(l) - LOG_MIN) / LOG_RANGE;
      bin = u32(clamp(floor(t * ${EXPOSURE_BINS}.0), 0.0, ${EXPOSURE_BINS - 1}.0));
    }
    atomicAdd(&local[bin], 1u);
  }
  workgroupBarrier();
  if (li < ${EXPOSURE_BINS}u) {
    let n = atomicLoad(&local[li]);
    if (n > 0u) {
      atomicAdd(&hist[li], n);
    }
  }
}
`;

const AVERAGE_WGSL = /* wgsl */ `
struct Params { low: f32, high: f32, pad0: f32, pad1: f32 };
@group(0) @binding(0) var<storage, read> hist: array<u32, ${EXPOSURE_BINS}>;
@group(0) @binding(1) var<storage, read_write> result: vec4f;
@group(0) @binding(2) var<uniform> params: Params;

const LOG_MIN: f32 = ${EXPOSURE_LOG_MIN}.0;
const LOG_RANGE: f32 = ${EXPOSURE_LOG_MAX - EXPOSURE_LOG_MIN}.0;

@compute @workgroup_size(1, 1, 1)
fn main() {
  var total = 0.0;
  for (var i = 0u; i < ${EXPOSURE_BINS}u; i++) {
    total += f32(hist[i]);
  }
  if (total <= 0.0) {
    result = vec4f(LOG_MIN, 0.0, 0.0, 0.0);
    return;
  }
  let lo = total * clamp(params.low, 0.0, 1.0);
  let hi = total * clamp(params.high, 0.0, 1.0);
  var seen = 0.0;
  var sum = 0.0;
  var weight = 0.0;
  for (var i = 0u; i < ${EXPOSURE_BINS}u; i++) {
    let n = f32(hist[i]);
    let start = seen;
    seen += n;
    let inside = max(0.0, min(seen, hi) - max(start, lo));
    if (inside > 0.0) {
      sum += inside * (LOG_MIN + ((f32(i) + 0.5) / ${EXPOSURE_BINS}.0) * LOG_RANGE);
      weight += inside;
    }
  }
  var avg = LOG_MIN;
  if (weight > 0.0) {
    avg = sum / weight;
  }
  result = vec4f(avg, total, 0.0, 0.0);
}
`;

/**
 * The two compute passes and their buffers. `encode` records both (clearing the histogram
 * first) and the copy into the readback buffer; `poll` maps it when free and stores the last
 * average in `averageLog`. On a device without `mapAsync` (the fake one) nothing is read back.
 */
export class ExposurePasses {
  private readonly device: GPUDevice;
  private readonly histogram: GPUComputePipeline;
  private readonly average: GPUComputePipeline;
  private readonly histLayout: GPUBindGroupLayout;
  private readonly histBuffer: GPUBuffer;
  private readonly resultBuffer: GPUBuffer;
  private readonly readBuffer: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly paramData = new Float32Array(PARAM_FLOATS);
  private readonly averageGroup: GPUBindGroup;
  private histGroup: GPUBindGroup | null = null;
  private boundColor: GPUTextureView | null = null;
  private readonly histDesc: GPUComputePassDescriptor = { label: 'pass:post-exposure-histogram' };
  private readonly avgDesc: GPUComputePassDescriptor = { label: 'pass:post-exposure-average' };
  /** A copy into the readback buffer is in flight (the next `poll` may map it). */
  private pending = false;
  private mapping = false;
  /** The last metered average log2 luminance (`EXPOSURE_LOG_MIN` until the first readback). */
  averageLog = EXPOSURE_LOG_MIN;
  /** How many readbacks have landed. */
  readbacks = 0;
  private readonly onMapped: () => void;
  private readonly onMapFailed: () => void;

  constructor(renderer: Renderer) {
    const device = renderer.device;
    this.device = device;
    const compute = GPUShaderStage.COMPUTE;
    this.histLayout = device.createBindGroupLayout({
      label: 'pass:post-exposure-histogram',
      entries: [
        { binding: 0, visibility: compute, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: compute, buffer: { type: 'storage' } },
        { binding: 2, visibility: compute, buffer: {} },
      ],
    });
    const avgLayout = device.createBindGroupLayout({
      label: 'pass:post-exposure-average',
      entries: [
        { binding: 0, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: compute, buffer: { type: 'storage' } },
        { binding: 2, visibility: compute, buffer: {} },
      ],
    });
    this.histogram = device.createComputePipeline({
      label: 'pass:post-exposure-histogram',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.histLayout] }),
      compute: {
        module: createShaderModule(device, HISTOGRAM_WGSL, 'pass:post-exposure-histogram'),
        entryPoint: 'main',
      },
    });
    this.average = device.createComputePipeline({
      label: 'pass:post-exposure-average',
      layout: device.createPipelineLayout({ bindGroupLayouts: [avgLayout] }),
      compute: {
        module: createShaderModule(device, AVERAGE_WGSL, 'pass:post-exposure-average'),
        entryPoint: 'main',
      },
    });
    this.histBuffer = device.createBuffer({
      label: 'post-exposure-histogram',
      size: EXPOSURE_BINS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.resultBuffer = device.createBuffer({
      label: 'post-exposure-average',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuffer = device.createBuffer({
      label: 'post-exposure-readback',
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.params = device.createBuffer({
      label: 'post-exposure-params',
      size: PARAM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.averageGroup = device.createBindGroup({
      label: 'pass:post-exposure-average',
      layout: avgLayout,
      entries: [
        { binding: 0, resource: { buffer: this.histBuffer } },
        { binding: 1, resource: { buffer: this.resultBuffer } },
        { binding: 2, resource: { buffer: this.params } },
      ],
    });
    this.onMapped = () => {
      const data = new Float32Array(this.readBuffer.getMappedRange());
      this.averageLog = data[0]!;
      this.readBuffer.unmap();
      this.mapping = false;
      this.pending = false;
      this.readbacks++;
    };
    this.onMapFailed = () => {
      this.mapping = false;
      this.pending = false;
    };
  }

  /**
   * Map the last copy if one is waiting and the buffer is free (call before `encode`, once the
   * previous frame's work has been submitted).
   */
  poll(): void {
    if (!this.pending || this.mapping) return;
    if (typeof this.readBuffer.mapAsync !== 'function') return;
    if (this.readBuffer.mapState !== 'unmapped') return;
    this.mapping = true;
    this.readBuffer.mapAsync(GPUMapMode.READ).then(this.onMapped, this.onMapFailed);
  }

  /** Record the histogram, the average and (when the readback buffer is free) the copy. */
  encode(
    encoder: GPUCommandEncoder,
    color: GPUTextureView,
    width: number,
    height: number,
    low: number,
    high: number,
  ): void {
    if (color !== this.boundColor) {
      this.boundColor = color;
      this.histGroup = this.device.createBindGroup({
        label: 'pass:post-exposure-histogram',
        layout: this.histLayout,
        entries: [
          { binding: 0, resource: color },
          { binding: 1, resource: { buffer: this.histBuffer } },
          { binding: 2, resource: { buffer: this.params } },
        ],
      });
    }
    this.paramData[0] = low;
    this.paramData[1] = high;
    this.device.queue.writeBuffer(this.params, 0, this.paramData);
    encoder.clearBuffer(this.histBuffer);
    const h = encoder.beginComputePass(this.histDesc);
    h.setPipeline(this.histogram);
    h.setBindGroup(0, this.histGroup!);
    h.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    h.end();
    const a = encoder.beginComputePass(this.avgDesc);
    a.setPipeline(this.average);
    a.setBindGroup(0, this.averageGroup);
    a.dispatchWorkgroups(1);
    a.end();
    if (!this.pending) {
      encoder.copyBufferToBuffer(this.resultBuffer, 0, this.readBuffer, 0, 16);
      this.pending = true;
    }
  }

  /** Forget a stale bind group (the colour texture was replaced). */
  invalidate(): void {
    this.boundColor = null;
    this.histGroup = null;
  }

  destroy(): void {
    this.histBuffer.destroy();
    this.resultBuffer.destroy();
    this.readBuffer.destroy();
    this.params.destroy();
  }
}
