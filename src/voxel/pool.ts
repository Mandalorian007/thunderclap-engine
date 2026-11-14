/**
 * `SectionMeshPool`: mesher Workers with a priority queue of sections waiting for a mesh.
 *
 * Sections are queued by key; a job's input is made (`build`, usually `SectionStore.jobFor`)
 * only when a Worker has room, so the page never packs work the camera has moved away from.
 * A section is queued at most once and never meshed twice at the same time: asking again
 * while it is in flight meshes it once more after its result (results for one section arrive
 * in order). Failures never cost a slot: a job the mesher throws on comes back as a failure;
 * a Worker that dies is replaced (`respawn`) and its jobs queued again once, and a section
 * whose job is lost twice in a row is skipped. Both are counted in `errors`.
 */
import type { SectionCodec, VoxelFormat } from './format';
import {
  installSectionMesherWorker,
  type SectionMesherReply,
  type SectionMesherRequest,
  type SectionMeshResult,
} from './section-protocol';
import { jobTransfers, type SectionJob } from './sources';

/** One mesher thread as the pool sees it. */
export interface MesherPort {
  post(message: SectionMesherRequest, transfer: ArrayBuffer[]): void;
  onResult(cb: (reply: SectionMesherReply) => void): void;
  /** The thread died or a reply could not be read: its jobs will not be answered. */
  onError?(cb: (message: string) => void): void;
  terminate(): void;
}

/** A Web Worker (or anything shaped like one) as a `MesherPort`. */
export function workerMesherPort(worker: Worker): MesherPort {
  return {
    post: (m, t) => worker.postMessage(m, t),
    onResult: (cb) => worker.addEventListener('message', (e) => cb(e.data as SectionMesherReply)),
    onError: (cb) => {
      worker.addEventListener('error', (e) => cb((e as ErrorEvent).message ?? 'worker error'));
      worker.addEventListener('messageerror', () => cb('a reply could not be read'));
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * A mesher on the page's own thread, answering on a microtask: for tests, tools, and hosts
 * without Workers. Meshing then costs frame time.
 */
export function inThreadMesherPort(codec: SectionCodec): MesherPort {
  let listener: ((r: SectionMesherReply) => void) | null = null;
  const handle = installSectionMesherWorker(
    { codec },
    { postMessage: () => {}, addEventListener: () => {} },
  );
  let alive = true;
  return {
    post(m) {
      const reply = handle(m);
      if (reply) queueMicrotask(() => alive && listener?.(reply));
    },
    onResult: (cb) => {
      listener = cb;
    },
    terminate: () => {
      alive = false;
    },
  };
}

/** Options for `SectionMeshPool`. */
export interface SectionMeshPoolOptions {
  format: VoxelFormat;
  ports: MesherPort[];
  /** A section's job, made when a Worker has room; null when it no longer needs a mesh. */
  build: (key: number) => SectionJob | null;
  onMesh: (key: number, result: SectionMeshResult) => void;
  /** Merge faces greedily. Default true. */
  greedy?: boolean;
  /** Jobs in flight per Worker. Default 2. */
  perWorker?: number;
  /** A new port to replace port `i` when it dies; without it the slot is dropped. */
  respawn?: (index: number) => MesherPort;
}

/** What `SectionMeshPool.stats` reports. */
export interface SectionMeshPoolStats {
  queued: number;
  inFlight: number;
  /** Page time spent making jobs, ms. */
  buildMs: number;
}

/** Failed jobs and replaced Workers. */
export interface SectionMeshPoolErrors {
  count: number;
  restarts: number;
  last: string | null;
}

interface Pending {
  key: number;
  priority: number;
  dropped?: boolean;
}

interface InFlight extends Pending {
  worker: number;
}

/** See the file comment. */
export class SectionMeshPool {
  readonly stats: SectionMeshPoolStats = { queued: 0, inFlight: 0, buildMs: 0 };
  readonly errors: SectionMeshPoolErrors = { count: 0, restarts: 0, last: null };
  private readonly ports: MesherPort[];
  private readonly load: number[];
  private readonly generation: number[];
  private readonly perWorker: number;
  private readonly greedy: boolean;
  private queue: Pending[] = [];
  private dropped = 0;
  private readonly queued = new Map<number, Pending>();
  private readonly inFlight = new Set<number>();
  private readonly again = new Map<number, number>();
  private readonly jobs = new Map<number, InFlight>();
  private readonly lost = new Set<number>();
  private sorted = true;
  private nextJob = 1;

  constructor(private readonly opts: SectionMeshPoolOptions) {
    this.ports = [...opts.ports];
    this.load = this.ports.map(() => 0);
    this.generation = this.ports.map(() => 0);
    this.perWorker = opts.perWorker ?? 2;
    this.greedy = opts.greedy !== false;
    for (let i = 0; i < this.ports.length; i++) this.attach(this.ports[i], i);
  }

  private attach(port: MesherPort, i: number): void {
    const gen = this.generation[i];
    port.onResult((r) => {
      if (this.generation[i] === gen) this.reply(r);
    });
    port.onError?.((message) => {
      if (this.generation[i] === gen) this.died(i, message);
    });
    port.post({ type: 'init', format: this.opts.format }, []);
  }

  get size(): number {
    return this.ports.length;
  }

  /** Nothing queued or in flight. */
  get idle(): boolean {
    return this.queue.length === this.dropped && this.stats.inFlight === 0;
  }

  /** Queue a section (lower priority runs first), or again after its job in flight. */
  enqueue(key: number, priority: number): void {
    if (this.inFlight.has(key)) {
      const was = this.again.get(key);
      this.again.set(key, was === undefined ? priority : Math.min(was, priority));
      return;
    }
    const existing = this.queued.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
    } else {
      const p = { key, priority };
      this.queued.set(key, p);
      this.queue.push(p);
    }
    this.sorted = false;
    this.stats.queued = this.queue.length - this.dropped;
  }

  isQueued(key: number): boolean {
    return this.queued.has(key);
  }

  /** Drop a queued section (it left the view). A job in flight still answers. */
  cancel(key: number): void {
    this.again.delete(key);
    this.lost.delete(key);
    const p = this.queued.get(key);
    if (!p) return;
    this.queued.delete(key);
    p.dropped = true;
    this.dropped++;
    if (this.dropped > 256 && this.dropped * 2 > this.queue.length) {
      this.queue = this.queue.filter((q) => !q.dropped);
      this.dropped = 0;
    }
    this.stats.queued = this.queue.length - this.dropped;
  }

  /** Recompute every queued section's priority (the camera moved). */
  reprioritize(priority: (key: number) => number): void {
    for (const p of this.queue) p.priority = priority(p.key);
    this.sorted = false;
  }

  /** Send jobs to every Worker with room. */
  pump(): void {
    if (!this.sorted) {
      this.queue.sort((a, b) => b.priority - a.priority);
      this.sorted = true;
    }
    for (let i = 0; i < this.ports.length && this.queue.length > 0; i++) {
      while (this.load[i] < this.perWorker && this.queue.length > 0) {
        const p = this.queue.pop()!;
        if (p.dropped) {
          this.dropped--;
          continue;
        }
        this.queued.delete(p.key);
        const t0 = performance.now();
        const input = this.opts.build(p.key);
        this.stats.buildMs += performance.now() - t0;
        if (!input) continue;
        const job = this.nextJob++;
        this.load[i]++;
        this.stats.inFlight++;
        this.inFlight.add(p.key);
        this.jobs.set(job, { key: p.key, priority: p.priority, worker: i });
        this.ports[i].post({ type: 'mesh', job, input, greedy: this.greedy }, jobTransfers(input));
      }
    }
    this.stats.queued = this.queue.length - this.dropped;
  }

  terminate(): void {
    for (const p of this.ports) p.terminate();
  }

  private settle(id: number): InFlight | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    this.jobs.delete(id);
    this.load[job.worker]--;
    this.stats.inFlight--;
    this.inFlight.delete(job.key);
    return job;
  }

  private requeue(key: number): void {
    const priority = this.again.get(key);
    if (priority === undefined) return;
    this.again.delete(key);
    this.enqueue(key, priority);
  }

  private reply(r: SectionMesherReply): void {
    const job = this.settle(r.job);
    if (!job) return;
    if (r.type === 'error') {
      this.failed(`section ${r.sx},${r.sy},${r.sz}: ${r.message}`);
    } else {
      this.lost.delete(job.key);
      this.opts.onMesh(job.key, r);
    }
    this.requeue(job.key);
    this.pump();
  }

  private failed(message: string): void {
    this.errors.count++;
    this.errors.last = message;
  }

  private died(i: number, message: string): void {
    this.generation[i]++;
    try {
      this.ports[i].terminate();
    } catch {
      // Already gone.
    }
    const orphans = [...this.jobs.entries()].filter(([, j]) => j.worker === i);
    for (const [id] of orphans) this.settle(id);
    this.errors.restarts++;
    this.errors.last = `worker ${i} died: ${message}`;
    if (this.opts.respawn) {
      const port = this.opts.respawn(i);
      this.ports[i] = port;
      this.load[i] = 0;
      this.attach(port, i);
    } else {
      this.load[i] = Number.POSITIVE_INFINITY;
    }
    for (const [, j] of orphans) {
      this.again.delete(j.key);
      if (this.lost.has(j.key)) {
        this.lost.delete(j.key);
        this.failed(`section key ${j.key}: skipped after its job was lost twice`);
        continue;
      }
      this.lost.add(j.key);
      this.enqueue(j.key, j.priority);
    }
    this.pump();
  }
}
