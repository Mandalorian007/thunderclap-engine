/**
 * Messages between the page and section mesher Workers, and the Worker side
 * (`installSectionMesherWorker`). A Worker is told the world's format once (`init`), then
 * meshes jobs; a job the mesher throws on is answered with a failure, never left unanswered.
 */
import type { SectionCodec, VoxelFormat } from './format';
import { type SectionMesh, SectionMesher } from './section-mesher';
import { SectionInputBuilder, type SectionJob } from './sources';

/** Page to Worker. */
export type SectionMesherRequest =
  | { type: 'init'; format: VoxelFormat }
  | { type: 'mesh'; job: number; input: SectionJob; greedy: boolean };

/** A meshed job. */
export interface SectionMeshResult {
  type: 'mesh';
  job: number;
  sx: number;
  sy: number;
  sz: number;
  mesh: SectionMesh;
  /** Time in the Worker, building the input included, ms. */
  ms: number;
}

/** Worker to page: a mesh, or the failure of one job (the Worker carries on). */
export type SectionMesherReply =
  | SectionMeshResult
  | { type: 'error'; job: number; sx: number; sy: number; sz: number; message: string };

/** The buffers a reply hands over without copying. */
export function sectionReplyTransfers(r: SectionMesherReply): ArrayBuffer[] {
  return r.type === 'mesh' ? [r.mesh.opaque, r.mesh.liquid, r.mesh.foliage] : [];
}

/** A Worker's global scope, as much of it as the mesher uses. */
export interface SectionWorkerScopeLike {
  postMessage(message: SectionMesherReply, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

/**
 * Answer `SectionMesherRequest`s on `scope` (default the Worker's `self`), decoding sections
 * with the game's `codec`. Returns the handler, for running it in-thread (tests, no Workers).
 * Call it from the game's own Worker script, which imports its codec.
 */
export function installSectionMesherWorker(
  opts: { codec: SectionCodec },
  scope: SectionWorkerScopeLike = self as unknown as SectionWorkerScopeLike,
): (req: SectionMesherRequest) => SectionMesherReply | null {
  let mesher: SectionMesher | null = null;
  let builder: SectionInputBuilder | null = null;
  const handle = (req: SectionMesherRequest): SectionMesherReply | null => {
    if (req.type === 'init') {
      mesher = new SectionMesher(req.format);
      builder = new SectionInputBuilder(req.format, opts.codec);
      return null;
    }
    const { sx, sy, sz } = req.input;
    try {
      if (!mesher || !builder) throw new Error('mesh before init');
      const t0 = performance.now();
      const mesh = mesher.mesh(builder.build(req.input), { greedy: req.greedy });
      return { type: 'mesh', job: req.job, sx, sy, sz, mesh, ms: performance.now() - t0 };
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { type: 'error', job: req.job, sx, sy, sz, message };
    }
  };
  scope.addEventListener('message', (e) => {
    const reply = handle(e.data as SectionMesherRequest);
    if (reply) scope.postMessage(reply, sectionReplyTransfers(reply));
  });
  return handle;
}
