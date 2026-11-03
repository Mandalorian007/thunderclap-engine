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

export class GpuTimer {
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

  constructor(device: GPUDevice, maxPasses = 48) {
    this.maxPasses = maxPasses;
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
   * marginal times add up to the frame total.
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
    for (let i = 0; i < used; i++) {
      const b = ts[(i + 1) * 2]!;
      const e = ts[(i + 1) * 2 + 1]!;
      // A zero timestamp was never written (a skipped pass): ignore the pair.
      if (b <= 0n || e < b) continue;
      if (first === 0n || b < first) first = b;
      if (firstPass === 0n) firstPass = b;
      // biome-ignore lint/complexity/useMathMinMax: bigint (Math.max takes numbers)
      const from = prevEnd > b ? prevEnd : b;
      if (e > from) sums[this.pairLabel[i]!]! += Number(e - from) / 1e6;
      if (e > prevEnd) prevEnd = e;
    }
    this.readBuf.unmap();
    this.pending = false;
    const r = this.result;
    r.totalMs = first > 0n && prevEnd > first ? Number(prevEnd - first) / 1e6 : 0;
    for (let i = 0; i < this.labels.length; i++) r.passes[this.labels[i]!] = sums[i]!;
    r.passes.pre = markE > 0n && firstPass > markE ? Number(firstPass - markE) / 1e6 : 0;
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
