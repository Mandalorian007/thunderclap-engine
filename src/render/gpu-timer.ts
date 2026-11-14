/**
 * GPU pass timing with `timestamp-query` (feature-detected; see `initGpu`).
 *
 * One sampled frame is in flight at a time. On a sampled frame, every pass that asks for
 * `pass(label)` gets begin/end timestamp writes; passes sharing a label are summed (the bloom
 * mip chain is many passes, one label). `mark()` opens the frame with an empty compute pass so
 * the work encoded before the first labelled pass (pre-passes, drawable prepare) is counted.
 *
 * Results land in `result` (plain object, reused) after the readback maps. Per-frame work is
 * allocation-free apart from the `mapAsync` promise and the mapped range on sampled frames.
 */

/** Pass label → GPU ms for the last resolved frame. */
export type GpuPassTimes = Record<string, number>;

export interface GpuTimerResult {
  /** First timestamp to last timestamp of the sampled frame (ms). */
  totalMs: number;
  /** Per-label sums (ms). `pre` is the gap between `mark()` and the first labelled pass. */
  passes: GpuPassTimes;
  /** Frames resolved so far. */
  samples: number;
}

/** True when the device was created with the `timestamp-query` feature. */
export function supportsTimestamps(device: GPUDevice): boolean {
  const f = (device as { features?: GPUSupportedFeatures }).features;
  return !!f && typeof f.has === 'function' && f.has('timestamp-query');
}

/**
 * How a pass's cost is taken from its timestamps (ws/actor-post-fit):
 * - `'overlap'`: its end minus the later of its own begin and the previous pass's end;
 * - `'chain'`: its end minus the previous pass's end (the frame mark's for the first), its begin
 *   unread. WebKit (Metal) writes begin timestamps that do not hold the pass's start, so there
 *   `'overlap'` moves time between passes; ends are in order everywhere, so a chain of ends
 *   still adds up to the frame. A gap between passes counts to the later one.
 * - `'auto'` (default): `'chain'` on WebKit (a Safari, iPad or Playwright WebKit user agent),
 *   else `'overlap'`.
 */
export type GpuTimerMeasure = 'auto' | 'overlap' | 'chain';

export interface GpuTimerOptions {
  /** See `GpuTimerMeasure`. Default `'auto'`. */
  measure?: GpuTimerMeasure;
}

/**
 * True for a browser on WebKit's engine: Safari, every iOS browser (Chrome's `CriOS` too) and
 * Playwright's WebKit; not desktop Chromium.
 */
export function isWebKitUserAgent(ua: string): boolean {
  return /AppleWebKit/.test(ua) && !/Chrome\/|Chromium|Edg\/|Electron/.test(ua);
}

function resolveMeasure(m: GpuTimerMeasure | undefined): 'overlap' | 'chain' {
  if (m === 'overlap' || m === 'chain') return m;
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return typeof nav?.userAgent === 'string' && isWebKitUserAgent(nav.userAgent)
    ? 'chain'
    : 'overlap';
}

export class GpuTimer {
  /** How pass costs are taken (`GpuTimerOptions.measure`, `'auto'` resolved). */
  readonly measure: 'overlap' | 'chain';
  readonly maxPasses: number;
  readonly result: GpuTimerResult = { totalMs: 0, passes: {}, samples: 0 };
  /** True between `begin()` and `resolve()`: passes should take `pass(label)` writes. */
  active = false;

  private readonly querySet: GPUQuerySet;
  private readonly resolveBuf: GPUBuffer;
  private readonly readBuf: GPUBuffer;
  private readonly writes: GPURenderPassTimestampWrites[] = [];
  private readonly markWrites: GPUComputePassTimestampWrites;
  private readonly markDesc: GPUComputePassDescriptor;
  /** Label index per used pair this frame. */
  private readonly pairLabel: Int32Array;
  private readonly labels: string[] = [];
  private readonly labelIndex = new Map<string, number>();
  private readonly sums: Float64Array;
  private used = 0;
  private marked = false;
  private pending = false;
  private destroyed = false;
  private readonly listeners = new Set<(r: GpuTimerResult) => void>();
  private readonly onMapped = (): void => this.read();
  private readonly onMapFailed = (): void => {
    this.pending = false;
  };

  constructor(device: GPUDevice, maxPasses = 48, opts: GpuTimerOptions = {}) {
    this.maxPasses = maxPasses;
    this.measure = resolveMeasure(opts.measure);
    // Pair 0 is the frame mark; pairs 1.. are labelled passes.
    const count = (maxPasses + 1) * 2;
    this.querySet = device.createQuerySet({ label: 'gpu-timer', type: 'timestamp', count });
    this.resolveBuf = device.createBuffer({
      label: 'gpu-timer-resolve',
      size: count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuf = device.createBuffer({
      label: 'gpu-timer-read',
      size: count * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    for (let i = 1; i <= maxPasses; i++) {
      this.writes.push({
        querySet: this.querySet,
        beginningOfPassWriteIndex: i * 2,
        endOfPassWriteIndex: i * 2 + 1,
      });
    }
    this.markWrites = {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
    this.markDesc = { label: 'gpu-timer-mark', timestampWrites: this.markWrites };
    this.pairLabel = new Int32Array(maxPasses);
    this.sums = new Float64Array(maxPasses);
  }

  /** True while a sampled frame is being read back (the next `begin` would be refused). */
  get busy(): boolean {
    return this.pending || this.active;
  }

  /** Called with each resolved frame. Returns unsubscribe. */
  onResult(fn: (r: GpuTimerResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start a sampled frame. Returns false (and stays inactive) while the last one is in flight. */
  begin(): boolean {
    if (this.busy || this.destroyed) return false;
    this.active = true;
    this.used = 0;
    this.marked = false;
    return true;
  }

  /** Frame start marker: an empty compute pass with timestamps. Call first in the encoder. */
  mark(encoder: GPUCommandEncoder): void {
    if (!this.active) return;
    encoder.beginComputePass(this.markDesc).end();
    this.marked = true;
  }

  /**
   * Timestamp writes for one pass under `label`, or undefined when not sampling (or out of
   * slots). Pass the result as the render/compute pass descriptor's `timestampWrites`.
   */
  pass(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.active || this.used >= this.maxPasses) return undefined;
    let li = this.labelIndex.get(label);
    if (li === undefined) {
      li = this.labels.length;
      if (li >= this.maxPasses) return undefined;
      this.labels.push(label);
      this.labelIndex.set(label, li);
    }
    this.pairLabel[this.used] = li;
    return this.writes[this.used++];
  }

  /** Resolve the queries into the readback buffer. Call after the last timed pass. */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.active) return;
    this.active = false;
    if (this.used === 0 && !this.marked) return;
    const count = (this.used + 1) * 2;
    encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, count * 8);
    this.pending = true;
  }

  /** Start the readback. Call after `queue.submit`. */
  afterSubmit(): void {
    if (!this.pending || this.readBuf.mapState !== 'unmapped') return;
    this.readBuf.mapAsync(GPUMapMode.READ).then(this.onMapped, this.onMapFailed);
  }

  /**
   * Per-pass cost is the pass's *marginal* time: its end minus the later of its own start and
   * the previous pass's end. Tiled GPUs (Apple, many mobiles) overlap consecutive passes, so a
   * plain end − begin counts the overlap twice and sums past the frame; ends are in order, so
   * marginal times add up to the frame total. In `'chain'` (WebKit) the begin is not read: the
   * cost is its end minus the previous end.
   */
  private read(): void {
    if (this.destroyed) return;
    const ts = new BigInt64Array(this.readBuf.getMappedRange());
    const used = this.used;
    const sums = this.sums;
    sums.fill(0);
    const markB = this.marked ? ts[0]! : 0n;
    const markE = this.marked ? ts[1]! : 0n;
    let first = markB;
    let prevEnd = markE;
    let firstPass = 0n;
    const chain = this.measure === 'chain';
    for (let i = 0; i < used; i++) {
      const b = ts[(i + 1) * 2]!;
      const e = ts[(i + 1) * 2 + 1]!;
      // A zero timestamp was never written (a skipped pass): ignore the pair. A chain reads
      // only the end (a begin past it is WebKit's, not a skipped pass).
      if (chain ? e <= 0n : b <= 0n || e < b) continue;
      if (b > 0n && (first === 0n || b < first)) first = b;
      if (firstPass === 0n) firstPass = b;
      // biome-ignore lint/complexity/useMathMinMax: bigint (Math.max takes numbers)
      const from = chain && prevEnd > 0n ? prevEnd : prevEnd > b ? prevEnd : b;
      if (e > from) sums[this.pairLabel[i]!]! += Number(e - from) / 1e6;
      if (e > prevEnd) prevEnd = e;
    }
    this.readBuf.unmap();
    this.pending = false;
    const r = this.result;
    r.totalMs = first > 0n && prevEnd > first ? Number(prevEnd - first) / 1e6 : 0;
    for (let i = 0; i < this.labels.length; i++) r.passes[this.labels[i]!] = sums[i]!;
    // A chain counts the time from the mark to the first pass's start in that pass.
    r.passes.pre = !chain && markE > 0n && firstPass > markE ? Number(firstPass - markE) / 1e6 : 0;
    r.samples++;
    for (const fn of this.listeners) fn(r);
  }

  destroy(): void {
    this.destroyed = true;
    this.querySet.destroy();
    this.resolveBuf.destroy();
    this.readBuf.destroy();
  }
}
