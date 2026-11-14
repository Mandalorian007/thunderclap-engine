/**
 * Counted work (E-041, D1 P9 and §2.17; D2 R2): what a frame does, counted rather than timed, so
 * a shared CI machine can hold it. A shared machine cannot time the main thread, but it can count
 * what the main thread asks of the GPU, how many typed arrays it makes and how often it reads the
 * clock.
 *
 * `createWorkMeter(device)` wraps a `GPUDevice` (the fake one from `createFakeDevice`, or any
 * other) in a Proxy that counts every method call on the device, its queue, its command encoders
 * and their passes. The engine is handed `meter.device`; `meter.run(frame, { frames, warmup })`
 * runs a game's frame and reports the work per frame. Nothing in the engine knows the meter.
 */

/** GPU work in one frame (per-frame averages in a `WorkReport`). */
export interface GpuCounts {
  /** Every method call on the device, its queue, its command encoders and their passes. */
  commands: number;
  draw: number;
  drawIndexed: number;
  drawIndirect: number;
  drawIndexedIndirect: number;
  setPipeline: number;
  setBindGroup: number;
  setVertexBuffer: number;
  setIndexBuffer: number;
  /** `dispatchWorkgroups` plus `dispatchWorkgroupsIndirect`. */
  dispatch: number;
  beginRenderPass: number;
  beginComputePass: number;
  /** `executeBundles` calls (each replays a recorded bundle). */
  executeBundles: number;
  submit: number;
  writeBuffer: number;
  /** Bytes `queue.writeBuffer` moved. */
  writeBufferBytes: number;
  writeTexture: number;
  /** `copyBufferToBuffer`, `copyBufferToTexture`, `copyTextureToBuffer`, `copyTextureToTexture`. */
  copies: number;
  createBuffer: number;
  createTexture: number;
  createBindGroup: number;
  /** Every other `device.create*` (pipelines, layouts, samplers, shader modules, query sets). */
  createOther: number;
  /** Calls by method name, every call counted in `commands`. */
  byMethod: Record<string, number>;
}

/** Allocations the code under test made (the device's own are not counted). */
export interface AllocCounts {
  /** `new` of any typed-array constructor (`Float32Array`, `Uint8Array`, ...). */
  typedArrays: number;
  /** `new ArrayBuffer` and `new SharedArrayBuffer`. */
  arrayBuffers: number;
  /** `new DataView`. */
  dataViews: number;
  /** Counts by constructor name. */
  byType: Record<string, number>;
}

/** What `WorkMeter.run` reports: everything per measured frame (averages over `frames`). */
export interface WorkReport {
  /** Measured frames. */
  frames: number;
  gpu: GpuCounts;
  allocs: AllocCounts;
  /** `performance.now()` and `Date.now()` calls the code under test made. */
  clockReads: number;
  /**
   * GPU work per view, when the frame marks views with `meter.view(name)`: the commands from a
   * mark to the next mark (or the frame's end) belong to that view. Commands before the first
   * mark of a frame are under `'frame'`. Empty when no view was marked.
   */
  views: Record<string, GpuCounts>;
  /** `gpu.commands` of each measured frame, in order (steady when all are equal). */
  commandsPerFrame: number[];
  /**
   * The normalized call trace of the measured frames (see `WorkMeterOptions.trace`), one call a
   * line, each frame ended by `'--'`; null without `trace`.
   */
  trace: string[] | null;
}

export interface WorkMeterOptions {
  /**
   * Record a normalized call trace while measuring: `method(args)` per call, numbers and
   * strings as written, arrays as `[length]`, binary data as `<bytes:N>`, objects by `label`
   * (or by the call that made them, `createBuffer#3`, when unlabelled). Feed it to
   * `traceGolden`. Default false.
   */
  trace?: boolean;
}

export interface RunOptions {
  /** Measured frames. Default 60. */
  frames?: number;
  /** Frames run first, uncounted, so pipelines, buffers and caches settle. Default 10. */
  warmup?: number;
}

export interface WorkMeter {
  /** The counted device: hand it to the engine (a `Renderer`, `createGame`'s `gpu`) in place of the original. */
  readonly device: GPUDevice;
  /**
   * Run `frame(i)` `warmup` times uncounted (`i` from `-warmup` to -1), then `frames` times
   * counted (`i` from 0), and report the work per frame.
   */
  run(frame: (i: number) => void, opts?: RunOptions): WorkReport;
  /** Count one call of `fn` as one frame. */
  measure(fn: () => void): WorkReport;
  /** Attribute the GPU calls that follow, until the next mark or the frame's end, to view `name`. */
  view(name: string): void;
}

/** Thrown by `budget` and `expectProportional`. */
export class BudgetError extends Error {
  override readonly name = 'BudgetError';
}

// ------------------------------------------------------------------------------- the counters

/** Depth of calls into the counted device: allocations and clock reads inside it are the device's. */
let inDevice = 0;
/** True while a meter is measuring; the global wrappers count only then. */
let counting = false;
/** The open frame's allocation and clock counters (one meter measures at a time). */
const live = { typed: 0, buffers: 0, views: 0, clock: 0, byType: new Map<string, number>() };

const TYPED_ARRAYS = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
] as const;

interface Saved {
  ctors: [string, unknown][];
  perfNow: (() => number) | null;
  dateNow: () => number;
}

/** Wrap the typed-array constructors and the clocks on `globalThis` while a measurement runs. */
function installCounters(): Saved {
  const g = globalThis as unknown as Record<string, unknown>;
  const ctors: [string, unknown][] = [];
  const wrap = (name: string, kind: 'typed' | 'buffers' | 'views') => {
    const C = g[name];
    if (typeof C !== 'function') return;
    ctors.push([name, C]);
    g[name] = new Proxy(C, {
      construct(target, args, newTarget) {
        if (counting && inDevice === 0) {
          live[kind]++;
          live.byType.set(name, (live.byType.get(name) ?? 0) + 1);
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
  };
  for (const n of TYPED_ARRAYS) wrap(n, 'typed');
  wrap('ArrayBuffer', 'buffers');
  wrap('SharedArrayBuffer', 'buffers');
  wrap('DataView', 'views');
  const perf = (globalThis as { performance?: Performance }).performance;
  const perfNow = perf ? perf.now : null;
  if (perf && perfNow) {
    perf.now = () => {
      if (counting && inDevice === 0) live.clock++;
      return perfNow.call(perf);
    };
  }
  const dateNow = Date.now;
  Date.now = () => {
    if (counting && inDevice === 0) live.clock++;
    return dateNow.call(Date);
  };
  return { ctors, perfNow, dateNow };
}

function restoreCounters(s: Saved): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [name, C] of s.ctors) g[name] = C;
  const perf = (globalThis as { performance?: Performance }).performance;
  if (perf && s.perfNow) perf.now = s.perfNow;
  Date.now = s.dateNow;
}

function resetLive(): void {
  live.typed = 0;
  live.buffers = 0;
  live.views = 0;
  live.clock = 0;
  live.byType.clear();
}

/**
 * Count the allocations `fn` makes (typed arrays, array buffers, data views), outside any counted
 * device. Returns the counts and leaves the globals as they were.
 */
export function countAllocs(fn: () => void): AllocCounts {
  if (counting) throw new Error('countAllocs: a measurement is already running');
  const saved = installCounters();
  resetLive();
  counting = true;
  try {
    fn();
  } finally {
    counting = false;
    restoreCounters(saved);
  }
  return {
    typedArrays: live.typed,
    arrayBuffers: live.buffers,
    dataViews: live.views,
    byType: Object.fromEntries(live.byType),
  };
}

// ------------------------------------------------------------------------------- GPU counts

function emptyGpu(): GpuCounts {
  return {
    commands: 0,
    draw: 0,
    drawIndexed: 0,
    drawIndirect: 0,
    drawIndexedIndirect: 0,
    setPipeline: 0,
    setBindGroup: 0,
    setVertexBuffer: 0,
    setIndexBuffer: 0,
    dispatch: 0,
    beginRenderPass: 0,
    beginComputePass: 0,
    executeBundles: 0,
    submit: 0,
    writeBuffer: 0,
    writeBufferBytes: 0,
    writeTexture: 0,
    copies: 0,
    createBuffer: 0,
    createTexture: 0,
    createBindGroup: 0,
    createOther: 0,
    byMethod: {},
  };
}

/** The `GpuCounts` field a method adds to, besides `commands` and `byMethod`. */
const FIELD: Record<string, keyof Omit<GpuCounts, 'byMethod'>> = {
  draw: 'draw',
  drawIndexed: 'drawIndexed',
  drawIndirect: 'drawIndirect',
  drawIndexedIndirect: 'drawIndexedIndirect',
  setPipeline: 'setPipeline',
  setBindGroup: 'setBindGroup',
  setVertexBuffer: 'setVertexBuffer',
  setIndexBuffer: 'setIndexBuffer',
  dispatchWorkgroups: 'dispatch',
  dispatchWorkgroupsIndirect: 'dispatch',
  beginRenderPass: 'beginRenderPass',
  beginComputePass: 'beginComputePass',
  executeBundles: 'executeBundles',
  submit: 'submit',
  writeBuffer: 'writeBuffer',
  writeTexture: 'writeTexture',
  copyBufferToBuffer: 'copies',
  copyBufferToTexture: 'copies',
  copyTextureToBuffer: 'copies',
  copyTextureToTexture: 'copies',
  createBuffer: 'createBuffer',
  createTexture: 'createTexture',
  createBindGroup: 'createBindGroup',
};

/**
 * Pass and encoder methods a device may lack (the fake records no indirect draws yet): a counted
 * no-op stands in, so code that calls them is counted rather than thrown at.
 */
const STUBBED = new Set([
  'drawIndirect',
  'drawIndexedIndirect',
  'dispatchWorkgroupsIndirect',
  'executeBundles',
  'insertDebugMarker',
  'pushDebugGroup',
  'popDebugGroup',
]);

/** Methods whose result is itself counted (an encoder, a pass, a bundle encoder). */
const WRAPS_RESULT = new Set([
  'createCommandEncoder',
  'createRenderBundleEncoder',
  'beginRenderPass',
  'beginComputePass',
]);

function add(c: GpuCounts, method: string, bytes: number): void {
  c.commands++;
  c.byMethod[method] = (c.byMethod[method] ?? 0) + 1;
  const f = FIELD[method];
  if (f) c[f]++;
  else if (method.startsWith('create')) c.createOther++;
  if (bytes > 0) c.writeBufferBytes += bytes;
}

function addInto(into: GpuCounts, from: GpuCounts): void {
  for (const k of Object.keys(from) as (keyof GpuCounts)[]) {
    if (k === 'byMethod') {
      for (const [m, n] of Object.entries(from.byMethod)) {
        into.byMethod[m] = (into.byMethod[m] ?? 0) + n;
      }
    } else into[k] += from[k];
  }
}

function scaled(c: GpuCounts, k: number): GpuCounts {
  const out = emptyGpu();
  for (const key of Object.keys(c) as (keyof GpuCounts)[]) {
    if (key === 'byMethod') {
      for (const [m, n] of Object.entries(c.byMethod)) out.byMethod[m] = n * k;
    } else out[key] = c[key] * k;
  }
  return out;
}

/** `queue.writeBuffer`'s byte count, as WebGPU reads its arguments. */
function writeBytes(args: unknown[]): number {
  const data = args[2] as ArrayBuffer | ArrayBufferView | undefined;
  if (!data) return 0;
  const dataOffset = (args[3] as number | undefined) ?? 0;
  const dataSize = args[4] as number | undefined;
  if (ArrayBuffer.isView(data)) {
    const bpe = (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    return (dataSize ?? data.byteLength / bpe - dataOffset) * bpe;
  }
  return dataSize ?? data.byteLength - dataOffset;
}

// ------------------------------------------------------------------------------- the meter

/**
 * Wrap `device` so every call on it, its queue, its command encoders and their passes is counted.
 * Hand `meter.device` to the engine before it creates anything, then `meter.run` a frame.
 * Resources the device makes (buffers, textures, bind groups) are returned as they are.
 */
export function createWorkMeter(device: GPUDevice, opts: WorkMeterOptions = {}): WorkMeter {
  const tracing = opts.trace === true;
  let frameCounts = emptyGpu();
  /** The view the next calls belong to, and whether this frame marked any. */
  let viewName = 'frame';
  let marked = false;
  let viewCounts: Map<string, GpuCounts> = new Map();
  let trace: string[] | null = null;
  /** Names for objects the device made, for the trace: their label or `method#n`. */
  const names = new WeakMap<object, string>();
  const made = new Map<string, number>();

  const arg = (a: unknown): string => {
    if (a === null || a === undefined || typeof a === 'number' || typeof a === 'boolean') {
      return String(a);
    }
    if (typeof a === 'string') return JSON.stringify(a);
    if (typeof a === 'bigint') return `${a}n`;
    if (ArrayBuffer.isView(a)) return `<bytes:${a.byteLength}>`;
    if (a instanceof ArrayBuffer) return `<bytes:${a.byteLength}>`;
    if (Array.isArray(a)) return `[${a.length}]`;
    if (typeof a === 'object' || typeof a === 'function') {
      const known = names.get(a as object);
      if (known !== undefined) return `{${known}}`;
      const label = (a as { label?: unknown }).label;
      if (typeof label === 'string' && label !== '') return `{${label}}`;
      if (Symbol.iterator in (a as object)) return '[...]';
      return '{}';
    }
    return '?';
  };

  const count = (method: string, args: unknown[]): void => {
    if (!counting) return;
    const bytes = method === 'writeBuffer' ? writeBytes(args) : 0;
    add(frameCounts, method, bytes);
    let v = viewCounts.get(viewName);
    if (!v) {
      v = emptyGpu();
      viewCounts.set(viewName, v);
    }
    add(v, method, bytes);
    if (trace) trace.push(`${method}(${args.map(arg).join(',')})`);
  };

  const remember = (method: string, args: unknown[], out: unknown): void => {
    if (!out || (typeof out !== 'object' && typeof out !== 'function')) return;
    const d = args[0] as { label?: unknown } | undefined;
    if (d && typeof d === 'object' && typeof d.label === 'string' && d.label !== '') {
      names.set(out as object, d.label);
      return;
    }
    const n = (made.get(method) ?? 0) + 1;
    made.set(method, n);
    names.set(out as object, `${method}#${n}`);
  };

  const wrapObject = <T extends object>(target: T): T => {
    const fns = new Map<PropertyKey, unknown>();
    let queue: unknown = null;
    return new Proxy(target, {
      get(t, prop) {
        if (prop === 'queue' && (t as { queue?: unknown }).queue) {
          queue ??= wrapObject((t as unknown as { queue: object }).queue);
          return queue;
        }
        const v = Reflect.get(t, prop, t) as unknown;
        if (typeof prop !== 'string') return v;
        if (typeof v !== 'function' && !(v === undefined && STUBBED.has(prop))) return v;
        let fn = fns.get(prop);
        if (fn) return fn;
        const method = prop;
        fn = (...args: unknown[]): unknown => {
          count(method, args);
          inDevice++;
          let out: unknown;
          try {
            const f = Reflect.get(t, method, t) as ((...a: unknown[]) => unknown) | undefined;
            out = f ? f.apply(t, args) : undefined;
          } finally {
            inDevice--;
          }
          if (method.startsWith('create')) remember(method, args, out);
          if (WRAPS_RESULT.has(method) && out && typeof out === 'object') {
            const w = wrapObject(out as object);
            const name = names.get(out as object);
            if (name !== undefined) names.set(w, name);
            return w;
          }
          return out;
        };
        fns.set(prop, fn);
        return fn;
      },
    });
  };

  const counted = wrapObject(device as unknown as object) as unknown as GPUDevice;

  const run = (frame: (i: number) => void, o: RunOptions = {}): WorkReport => {
    const frames = Math.max(1, Math.floor(o.frames ?? 60));
    const warmup = Math.max(0, Math.floor(o.warmup ?? 10));
    if (counting) throw new Error('WorkMeter.run: a measurement is already running');
    for (let i = -warmup; i < 0; i++) frame(i);
    const total = emptyGpu();
    const views = new Map<string, GpuCounts>();
    const perFrame: number[] = [];
    trace = tracing ? [] : null;
    const saved = installCounters();
    resetLive();
    let byType = new Map<string, number>();
    let typed = 0;
    let buffers = 0;
    let dataViews = 0;
    let clock = 0;
    try {
      for (let i = 0; i < frames; i++) {
        frameCounts = emptyGpu();
        viewCounts = new Map();
        viewName = 'frame';
        marked = false;
        counting = true;
        try {
          frame(i);
        } finally {
          counting = false;
        }
        perFrame.push(frameCounts.commands);
        addInto(total, frameCounts);
        if (marked)
          for (const [name, c] of viewCounts) {
            let v = views.get(name);
            if (!v) {
              v = emptyGpu();
              views.set(name, v);
            }
            addInto(v, c);
          }
        trace?.push('--');
      }
      typed = live.typed;
      buffers = live.buffers;
      dataViews = live.views;
      clock = live.clock;
      byType = new Map(live.byType);
    } finally {
      restoreCounters(saved);
      viewName = 'frame';
    }
    const k = 1 / frames;
    const out: WorkReport = {
      frames,
      gpu: scaled(total, k),
      allocs: {
        typedArrays: typed * k,
        arrayBuffers: buffers * k,
        dataViews: dataViews * k,
        byType: Object.fromEntries([...byType].map(([n, c]) => [n, c * k])),
      },
      clockReads: clock * k,
      views: Object.fromEntries([...views].map(([n, c]) => [n, scaled(c, k)])),
      commandsPerFrame: perFrame,
      trace,
    };
    trace = null;
    return out;
  };

  return {
    device: counted,
    run,
    measure: (fn) => run(() => fn(), { frames: 1, warmup: 0 }),
    view(name: string) {
      if (!counting) return;
      viewName = name;
      marked = true;
    },
  };
}

// ------------------------------------------------------------------------------- budgets

/** A ceiling per counter: any `GpuCounts` number, or an allocation or clock count. */
export type BudgetLimits = Partial<Record<Exclude<keyof GpuCounts, 'byMethod'>, number>> & {
  typedArrays?: number;
  arrayBuffers?: number;
  dataViews?: number;
  clockReads?: number;
};

/** Read one counter of a report by its `BudgetLimits` key. */
function counter(r: WorkReport, key: keyof BudgetLimits): number {
  if (key === 'clockReads') return r.clockReads;
  if (key === 'typedArrays' || key === 'arrayBuffers' || key === 'dataViews') return r.allocs[key];
  return r.gpu[key];
}

/**
 * Hold a report to a budget: every counter in `limits` must be at most its limit, per frame.
 * Throws a `BudgetError` naming each counter over its limit; returns the report otherwise.
 * `label` names the scene in the message.
 */
export function budget(report: WorkReport, limits: BudgetLimits, label = 'frame'): WorkReport {
  const over: string[] = [];
  for (const key of Object.keys(limits) as (keyof BudgetLimits)[]) {
    const limit = limits[key];
    if (limit === undefined) continue;
    const got = counter(report, key);
    if (got > limit) over.push(`${key} ${round(got)} > ${limit}`);
  }
  if (over.length > 0) {
    throw new BudgetError(`${label}: over budget per frame: ${over.join('; ')}`);
  }
  return report;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export interface ProportionalOptions {
  /**
   * `'flat'`: the count is the same at every size (work that must not grow with what is held).
   * `'linear'`: the count grows along a straight line with the size (work proportional to
   * change), from a fixed overhead that is not negative. Default `'linear'`.
   */
  shape?: 'flat' | 'linear';
  /** Allowed difference from the shape, in counts, at each size. Default 0 (exact). */
  slack?: number;
  /** A ceiling on the cost per unit of size (`'linear'` only). */
  perUnit?: number;
  /** Names the count in the message. */
  label?: string;
}

export interface ProportionalResult {
  sizes: number[];
  values: number[];
  /** Cost per unit of size (0 for `'flat'`). */
  slope: number;
  /** The fixed cost at size 0. */
  intercept: number;
}

/**
 * Run `run(size)` at each size and check that the counts it returns are flat, or proportional to
 * the size (see `ProportionalOptions.shape`). Throws a `BudgetError` listing every count
 * otherwise. `sizes` needs two or more distinct values.
 */
export function expectProportional(
  run: (size: number) => number,
  sizes: readonly number[],
  opts: ProportionalOptions = {},
): ProportionalResult {
  const xs = [...sizes];
  if (xs.length < 2 || new Set(xs).size < 2) {
    throw new RangeError('expectProportional: give two or more distinct sizes');
  }
  const shape = opts.shape ?? 'linear';
  const slack = opts.slack ?? 0;
  const label = opts.label ?? 'count';
  const values = xs.map((x) => run(x));
  const lo = xs.indexOf(Math.min(...xs));
  const hi = xs.indexOf(Math.max(...xs));
  const slope = shape === 'flat' ? 0 : (values[hi]! - values[lo]!) / (xs[hi]! - xs[lo]!);
  const intercept = shape === 'flat' ? values[lo]! : values[lo]! - slope * xs[lo]!;
  const table = xs.map((x, i) => `${x}: ${round(values[i]!)}`).join(', ');
  const fail = (why: string) => {
    throw new BudgetError(`${label} is not ${shape} in size (${why}): ${table}`);
  };
  for (let i = 0; i < xs.length; i++) {
    const want = intercept + slope * xs[i]!;
    if (Math.abs(values[i]! - want) > slack + 1e-9) {
      fail(`at ${xs[i]} it is ${round(values[i]!)}, the line says ${round(want)}`);
    }
  }
  if (shape === 'linear') {
    if (intercept < -slack - 1e-9) fail(`negative overhead ${round(intercept)}`);
    if (opts.perUnit !== undefined && slope > opts.perUnit + 1e-9) {
      fail(`${round(slope)} per unit > ${opts.perUnit}`);
    }
  }
  return { sizes: xs, values, slope, intercept };
}

// ------------------------------------------------------------------------------- trace goldens

/** A frame trace reduced to what a golden file keeps (Forge's `fixtures/frame-trace.json`). */
export interface TraceGolden {
  /** sha256 (hex) of the trace's lines joined by `\n`: every call of every frame, in order. */
  sha256: string;
  /** Frames in the trace. */
  frames: number;
  /** Calls each frame, run-length: `[calls, frames]`. */
  perFrame: [number, number][];
  /** The first frame's calls, to read a difference by. */
  first: string[];
}

/** Reduce a `WorkReport.trace` (frames ended by `'--'`) to a `TraceGolden`. */
export function traceGolden(trace: readonly string[]): TraceGolden {
  const perFrame: [number, number][] = [];
  const first: string[] = [];
  let n = 0;
  let frames = 0;
  for (const line of trace) {
    if (line !== '--') {
      n++;
      if (frames === 0) first.push(line);
      continue;
    }
    const last = perFrame[perFrame.length - 1];
    if (last && last[0] === n) last[1]++;
    else perFrame.push([n, 1]);
    n = 0;
    frames++;
  }
  return { sha256: sha256Hex(trace.join('\n')), frames, perFrame, first };
}

/**
 * Compare a trace golden with the one kept: null when they match, else what differs first (the
 * first frame's calls, the calls per frame, then the hash). A test fails on a non-null result,
 * and a change that means to change the frame writes the golden again and says why in its PR.
 */
export function diffTraceGolden(got: TraceGolden, want: TraceGolden): string | null {
  const len = Math.max(got.first.length, want.first.length);
  for (let i = 0; i < len; i++) {
    if (got.first[i] !== want.first[i]) {
      return `first frame, call ${i}: got ${got.first[i] ?? '(none)'}, want ${want.first[i] ?? '(none)'}`;
    }
  }
  if (JSON.stringify(got.perFrame) !== JSON.stringify(want.perFrame)) {
    return `calls per frame: got ${JSON.stringify(got.perFrame)}, want ${JSON.stringify(want.perFrame)}`;
  }
  if (got.frames !== want.frames) return `frames: got ${got.frames}, want ${want.frames}`;
  if (got.sha256 !== want.sha256) return 'a later frame differs (same calls in the first frame)';
  return null;
}

// ------------------------------------------------------------------------------- sha256

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** sha256 of a string's UTF-8 bytes, as lowercase hex (sync, no platform crypto). */
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLen = msg.length * 8;
  const padded = new Uint8Array((((msg.length + 9 + 63) >> 6) << 6) >>> 0);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += h[i]!.toString(16).padStart(8, '0');
  return hex;
}
