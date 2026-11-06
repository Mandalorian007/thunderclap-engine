/**
 * The bundle: loads a `Manifest` through a game-supplied `read(uri)` with bounded concurrency,
 * priorities, progress (assets and bytes), cancellation, per-key errors, retries and release.
 * The engine never fetches (VISION rule 4): `read` is the game's `fetch`, a zip reader, an
 * Electron file read. Decoding is the engine's: images through `createImageBitmap`, audio
 * through the context the game passes, glTF through `parseGltf` + `loadGltf`, JSON and text
 * directly.
 */
import { Emitter } from '../core/events';
import type { Renderer } from '../render/renderer';
import { loadTexture, loadTextureArray, type Texture } from '../render/texture';
import { type AtlasSource, createAtlasTexture, packAtlas } from './atlas';
import { type GltfDocument, type GltfJson, parseGltf } from './gltf';
import { type GltfScene, type LoadGltfOptions, loadGltf } from './gltf-load';
import type { AssetOf, AtlasAsset, Manifest, ManifestEntry } from './manifest';

/** What `read` resolves: the bytes, a decoded image, or bytes with the resource's full size. */
export type ReadResult =
  | ArrayBuffer
  | Blob
  | ImageBitmap
  | { data: ArrayBuffer | Blob | ImageBitmap; total?: number };

/** The game's loader: never called twice for one uri inside one `load` batch. */
export type AssetReader = (uri: string) => Promise<ReadResult>;

/** Anything that decodes audio: an `AudioEngine` (its `context`, once unlocked) or a context. */
export type AudioDecoder =
  | { context: { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> } | null }
  | { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> };

export interface BundleOptions<M extends Manifest> {
  read: AssetReader;
  /** Needed by `texture`, `texture-array`, `gltf` and `atlas` entries. */
  renderer?: Renderer;
  /** Needed by `audio` entries. */
  audio?: AudioDecoder;
  /** Reads in flight at once (default 4). */
  concurrency?: number;
  /** Times a failed `read` is retried before the key fails (default 0). */
  retries?: number;
  /** Higher loads first (default 0 for every key). */
  priority?: (key: keyof M & string) => number;
  /** Reject `load` on the first failed asset and cancel the rest (default false: `errors`). */
  strict?: boolean;
  /**
   * How bytes become an image for `texture`, `texture-array`, `image` and `atlas` entries
   * (default `createImageBitmap(blob)`). Workers and tests without image decoding pass their own.
   */
  decodeImage?: (blob: Blob) => Promise<ImageBitmap>;
}

export interface BundleProgress {
  /** Assets loaded. */
  loaded: number;
  /** Assets that failed (counted as settled, so `fraction` still reaches 1). */
  failed: number;
  /** Assets requested so far through `load`. */
  total: number;
  /** Bytes read so far (`byteLength` of buffers, `size` of blobs). */
  bytes: number;
  /** Sum of the `total` sizes `read` reported, or null when it reported none. */
  bytesTotal: number | null;
  /** `(loaded + failed) / total`, 1 when nothing was requested. */
  fraction: number;
}

export interface BundleError {
  key: string;
  /** The uri whose read or decode failed, when known. */
  uri: string | null;
  message: string;
  cause: unknown;
}

export interface BundleEvents {
  progress: BundleProgress;
  asset: { key: string; asset: unknown };
  error: BundleError;
  /** A `load` batch finished (not emitted when it was cancelled). */
  done: BundleProgress;
}

export interface Bundle<M extends Manifest> {
  readonly manifest: M;
  readonly progress: BundleProgress;
  readonly errors: BundleError[];
  /** True after `cancel()` until the next `load`. */
  readonly cancelled: boolean;
  /** Load `keys` (default every key not yet loaded or loading). Resolves when they settled. */
  load(keys?: (keyof M & string)[]): Promise<void>;
  /** The loaded asset; throws when the key is not loaded (naming its error if it failed). */
  get<K extends keyof M & string>(key: K): AssetOf<M[K]>;
  has(key: keyof M & string): boolean;
  on<K extends keyof BundleEvents>(type: K, fn: (payload: BundleEvents[K]) => void): () => void;
  /** Stop starting reads and decodes; in-flight reads finish but their assets are dropped. */
  cancel(): void;
  /** Destroy what the bundle made for `key` (or every key) and forget it. */
  release(key?: keyof M & string): void;
  /** Cancel, release everything and drop listeners. */
  dispose(): void;
}

/** `cancelled`: requested (counted in `total`) but stopped by `cancel()`; the next `load` resumes it. */
type Status = 'idle' | 'loading' | 'loaded' | 'failed' | 'cancelled';

const GLB_MAGIC = 0x46546c67; // 'glTF'

class Cancelled extends Error {
  constructor() {
    super('bundle: cancelled');
  }
}

interface Slot {
  priority: number;
  seq: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** Bounded reads, highest priority first, insertion order among equals. */
class ReadGate {
  private active = 0;
  private seq = 0;
  private readonly waiting: Slot[] = [];
  constructor(readonly limit: number) {}

  acquire(priority: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiting.push({ priority, seq: this.seq++, resolve, reject });
    });
  }

  release(): void {
    let best = -1;
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i]!;
      const b = best < 0 ? null : this.waiting[best]!;
      if (!b || w.priority > b.priority || (w.priority === b.priority && w.seq < b.seq)) best = i;
    }
    if (best < 0) {
      this.active--;
      return;
    }
    const [next] = this.waiting.splice(best, 1);
    next!.resolve();
  }

  /** Turn every waiter away (its read never starts). */
  drain(): void {
    const w = this.waiting.splice(0);
    for (const s of w) s.reject(new Cancelled());
  }
}

async function toBuffer(data: ArrayBuffer | Blob): Promise<ArrayBuffer> {
  return data instanceof Blob ? data.arrayBuffer() : data;
}

function isBitmap(x: unknown): x is ImageBitmap {
  return (
    typeof x === 'object' &&
    x !== null &&
    !(x instanceof ArrayBuffer) &&
    !(x instanceof Blob) &&
    'width' in x &&
    'height' in x &&
    !('data' in x)
  );
}

function sizeOf(data: ArrayBuffer | Blob | ImageBitmap): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Blob) return data.size;
  return 0;
}

export function createBundle<M extends Manifest>(manifest: M, opts: BundleOptions<M>): Bundle<M> {
  return new BundleImpl(manifest, opts);
}

class BundleImpl<M extends Manifest> implements Bundle<M> {
  readonly progress: BundleProgress = {
    loaded: 0,
    failed: 0,
    total: 0,
    bytes: 0,
    bytesTotal: null,
    fraction: 1,
  };
  readonly errors: BundleError[] = [];
  cancelled = false;

  private readonly status = new Map<string, Status>();
  private readonly assets = new Map<string, unknown>();
  /** Bitmaps the bundle created for `image` and `atlas` entries, closed on release. */
  private readonly owned = new Map<string, { close(): void }[]>();
  private readonly emitter = new Emitter<BundleEvents>();
  private readonly gate: ReadGate;
  private readonly retries: number;
  private readonly cache = new Map<string, Promise<ReadResult>>();
  /** Uris whose size was already counted into `bytes`/`bytesTotal`. */
  private readonly counted = new Set<string>();
  private inFlight = 0;

  constructor(
    readonly manifest: M,
    private readonly opts: BundleOptions<M>,
  ) {
    this.gate = new ReadGate(Math.max(1, Math.floor(opts.concurrency ?? 4)));
    this.retries = Math.max(0, Math.floor(opts.retries ?? 0));
    for (const key of Object.keys(manifest)) this.status.set(key, 'idle');
  }

  // --------------------------------------------------------------------------------- public

  async load(keys?: (keyof M & string)[]): Promise<void> {
    this.cancelled = false;
    const wanted = (keys ?? (Object.keys(this.manifest) as (keyof M & string)[])).filter((k) => {
      const s = this.status.get(k);
      if (s === undefined) throw new Error(`bundle: unknown key "${k}"`);
      return s === 'idle' || s === 'failed' || s === 'cancelled';
    });
    for (const k of wanted) {
      const s = this.status.get(k);
      if (s === 'failed') {
        this.progress.failed--;
        const i = this.errors.findIndex((e) => e.key === k);
        if (i >= 0) this.errors.splice(i, 1);
      } else if (s === 'idle') this.progress.total++;
      this.status.set(k, 'loading');
    }
    this.refresh();
    if (wanted.length === 0) {
      if (this.inFlight === 0 && !this.cancelled) this.emitter.emit('done', this.progress);
      return;
    }
    const priority = this.opts.priority;
    const ordered = wanted
      .map((key, i) => ({ key, p: priority ? priority(key) : 0, i }))
      .sort((a, b) => b.p - a.p || a.i - b.i);
    this.inFlight += ordered.length;
    const settled = await Promise.all(ordered.map(({ key, p }) => this.loadOne(key, p)));
    this.inFlight -= ordered.length;
    if (this.inFlight === 0) this.cache.clear();
    const firstError = settled.find((e) => e !== null) ?? null;
    if (!this.cancelled && this.inFlight === 0) this.emitter.emit('done', this.progress);
    if (this.opts.strict && firstError) throw firstError;
  }

  get<K extends keyof M & string>(key: K): AssetOf<M[K]> {
    const s = this.status.get(key);
    if (s === 'loaded') return this.assets.get(key) as AssetOf<M[K]>;
    if (s === undefined) throw new Error(`bundle: unknown key "${key}"`);
    const err = this.errors.find((e) => e.key === key);
    throw new Error(
      err ? `bundle: "${key}" failed to load: ${err.message}` : `bundle: "${key}" is not loaded`,
    );
  }

  has(key: keyof M & string): boolean {
    return this.status.get(key) === 'loaded';
  }

  on<K extends keyof BundleEvents>(type: K, fn: (payload: BundleEvents[K]) => void): () => void {
    return this.emitter.on(type, fn);
  }

  cancel(): void {
    this.cancelled = true;
    this.gate.drain();
  }

  release(key?: keyof M & string): void {
    if (key === undefined) {
      for (const k of Object.keys(this.manifest) as (keyof M & string)[]) this.release(k);
      return;
    }
    const s = this.status.get(key);
    if (s === undefined) throw new Error(`bundle: unknown key "${key}"`);
    if (s === 'loaded') {
      this.destroyAsset(this.manifest[key]!, this.assets.get(key));
      this.progress.loaded--;
      this.progress.total--;
    } else if (s === 'failed') {
      this.progress.failed--;
      this.progress.total--;
      const i = this.errors.findIndex((e) => e.key === key);
      if (i >= 0) this.errors.splice(i, 1);
    } else if (s === 'loading' || s === 'cancelled') {
      // In flight: the task sees 'idle' when it finishes and destroys what it made.
      this.progress.total--;
    }
    for (const b of this.owned.get(key) ?? []) b.close();
    this.owned.delete(key);
    this.assets.delete(key);
    this.status.set(key, 'idle');
    this.refresh();
  }

  dispose(): void {
    this.cancel();
    this.release();
    this.emitter.clear();
  }

  // -------------------------------------------------------------------------------- loading

  private refresh(): void {
    const p = this.progress;
    p.fraction = p.total === 0 ? 1 : (p.loaded + p.failed) / p.total;
    this.emitter.emit('progress', p);
  }

  /** Resolves null on success, the error on failure (cancellation is neither). */
  private async loadOne(key: keyof M & string, priority: number): Promise<BundleError | null> {
    const entry = this.manifest[key]!;
    let uri: string | null = 'uri' in entry ? entry.uri : null;
    try {
      const asset = await this.decode(key, entry, priority, (u) => {
        uri = u;
      });
      if (this.status.get(key) !== 'loading') {
        // Released while loading: nothing to keep.
        this.destroyAsset(entry, asset);
        return null;
      }
      this.assets.set(key, asset);
      this.status.set(key, 'loaded');
      this.progress.loaded++;
      this.refresh();
      this.emitter.emit('asset', { key, asset });
      return null;
    } catch (cause) {
      if (cause instanceof Cancelled || this.status.get(key) !== 'loading') {
        // Cancelled: still counted in `total` (so `fraction` stays below 1) until the next `load`.
        if (this.status.get(key) === 'loading') this.status.set(key, 'cancelled');
        return null;
      }
      const err: BundleError = {
        key,
        uri,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      };
      this.errors.push(err);
      this.status.set(key, 'failed');
      this.progress.failed++;
      this.refresh();
      this.emitter.emit('error', err);
      if (this.opts.strict) this.cancel();
      return err;
    }
  }

  private checkCancelled(): void {
    if (this.cancelled) throw new Cancelled();
  }

  /** One `read` through the gate and the per-batch cache, with retries; counts bytes once per uri. */
  private async read(uri: string, priority: number): Promise<ArrayBuffer | Blob | ImageBitmap> {
    this.checkCancelled();
    let pending = this.cache.get(uri);
    if (!pending) {
      pending = this.readUncached(uri, priority);
      pending.catch(() => this.cache.delete(uri));
      this.cache.set(uri, pending);
    }
    const res = await pending;
    this.checkCancelled();
    const data =
      res instanceof ArrayBuffer || res instanceof Blob || isBitmap(res) ? res : res.data;
    if (!this.counted.has(uri)) {
      this.counted.add(uri);
      this.progress.bytes += sizeOf(data);
      const total = !(res instanceof ArrayBuffer || res instanceof Blob || isBitmap(res))
        ? res.total
        : undefined;
      if (total !== undefined) this.progress.bytesTotal = (this.progress.bytesTotal ?? 0) + total;
      this.refresh();
    }
    return data;
  }

  private async readUncached(uri: string, priority: number): Promise<ReadResult> {
    await this.gate.acquire(priority);
    try {
      let attempt = 0;
      for (;;) {
        this.checkCancelled();
        try {
          return await this.opts.read(uri);
        } catch (e) {
          if (attempt++ >= this.retries) throw e;
        }
      }
    } finally {
      this.gate.release();
    }
  }

  private async bytes(uri: string, priority: number): Promise<ArrayBuffer> {
    const data = await this.read(uri, priority);
    if (isBitmap(data)) throw new Error(`bundle: read("${uri}") returned an image, bytes needed`);
    return toBuffer(data);
  }

  private async bitmap(uri: string, priority: number, key: string): Promise<ImageBitmap> {
    const data = await this.read(uri, priority);
    if (isBitmap(data)) return data;
    const blob = data instanceof Blob ? data : new Blob([data]);
    const bmp = await (this.opts.decodeImage ?? defaultDecodeImage)(blob);
    this.checkCancelled();
    const list = this.owned.get(key) ?? [];
    list.push(bmp);
    this.owned.set(key, list);
    return bmp;
  }

  private renderer(kind: string, key: string): Renderer {
    const r = this.opts.renderer;
    if (!r) throw new Error(`bundle: ${kind} "${key}" needs createBundle({ renderer })`);
    return r;
  }

  private async decode(
    key: keyof M & string,
    entry: ManifestEntry,
    priority: number,
    setUri: (uri: string) => void,
  ): Promise<unknown> {
    switch (entry.kind) {
      case 'bytes':
        return this.bytes(entry.uri, priority);
      case 'text':
        return new TextDecoder().decode(await this.bytes(entry.uri, priority));
      case 'json':
        return JSON.parse(new TextDecoder().decode(await this.bytes(entry.uri, priority)));
      case 'image': {
        const bmp = await this.bitmap(entry.uri, priority, key);
        this.owned.delete(key); // the asset itself; `release` closes it as the asset
        return bmp;
      }
      case 'audio': {
        const buf = await this.bytes(entry.uri, priority);
        const audio = this.opts.audio;
        const ctx = audio && 'decodeAudioData' in audio ? audio : audio?.context;
        if (!ctx) {
          throw new Error(
            `bundle: audio "${key}" needs createBundle({ audio }) with a context (an unlocked AudioEngine, or an OfflineAudioContext to decode before the first gesture)`,
          );
        }
        // decodeAudioData detaches its buffer; another entry may share these bytes.
        return ctx.decodeAudioData(buf.slice(0));
      }
      case 'texture': {
        const device = this.renderer(entry.kind, key).device;
        const bmp = await this.bitmap(entry.uri, priority, key);
        const tex = loadTexture(device, bmp, { label: key, ...entry.options });
        this.closeOwned(key);
        return tex;
      }
      case 'texture-array': {
        const device = this.renderer(entry.kind, key).device;
        const bitmaps = await Promise.all(
          entry.uris.map((u) => {
            setUri(u);
            return this.bitmap(u, priority, key);
          }),
        );
        const tex = loadTextureArray(device, bitmaps, { label: key, ...entry.options });
        this.closeOwned(key);
        return tex;
      }
      case 'atlas': {
        const device = this.renderer(entry.kind, key).device;
        const names = Object.keys(entry.uris);
        const bitmaps = await Promise.all(
          names.map((n) => {
            const u = entry.uris[n]!;
            setUri(u);
            return this.bitmap(u, priority, key);
          }),
        );
        const images: Record<string, AtlasSource> = {};
        names.forEach((n, i) => {
          images[n] = bitmaps[i]!;
        });
        const layout = packAtlas(images, entry.options);
        const { texture, rects } = createAtlasTexture(device, layout, images, { label: key });
        this.closeOwned(key);
        const asset: AtlasAsset = { texture, rects, layout };
        return asset;
      }
      case 'gltf': {
        const renderer = this.renderer(entry.kind, key);
        const mapped = (u: string): string => entry.resources?.[u] ?? u;
        const main = await this.bytes(entry.uri, priority);
        const resources: NonNullable<LoadGltfOptions['resources']> = {
          ...entry.options?.resources,
        };
        let doc: GltfDocument;
        if (main.byteLength >= 4 && new DataView(main).getUint32(0, true) === GLB_MAGIC) {
          doc = parseGltf(main);
        } else {
          // A .gltf: its external buffers must be in hand before the parse.
          const json = JSON.parse(new TextDecoder().decode(main)) as GltfJson;
          const bufferUris = (json.buffers ?? []).map((b) =>
            b.uri !== undefined && !b.uri.startsWith('data:') ? b.uri : null,
          );
          const buffers = await Promise.all(
            bufferUris.map(async (u) => {
              if (u === null) return undefined;
              const given = resources[u];
              if (given instanceof ArrayBuffer) return given;
              setUri(mapped(u));
              return this.bytes(mapped(u), priority);
            }),
          );
          doc = parseGltf({ json, buffers: buffers as ArrayBuffer[] });
          // Consumed by the parse; keep them out of the image reads below.
          for (const u of bufferUris) if (u !== null) resources[u] ??= new ArrayBuffer(0);
        }
        const external = doc.externalUris.filter((u) => !(u in resources));
        const images = await Promise.all(
          external.map((u) => {
            setUri(mapped(u));
            return this.bytes(mapped(u), priority);
          }),
        );
        external.forEach((u, i) => {
          resources[u] = images[i]!;
        });
        setUri(entry.uri);
        this.checkCancelled();
        return loadGltf(renderer, doc, { label: key, ...entry.options, resources });
      }
    }
  }

  private closeOwned(key: string): void {
    for (const b of this.owned.get(key) ?? []) b.close();
    this.owned.delete(key);
  }

  private destroyAsset(entry: ManifestEntry, asset: unknown): void {
    switch (entry.kind) {
      case 'texture':
      case 'texture-array':
        (asset as Texture | undefined)?.destroy();
        break;
      case 'gltf':
        (asset as GltfScene | undefined)?.destroy();
        break;
      case 'atlas':
        (asset as AtlasAsset | undefined)?.texture.destroy();
        break;
      case 'image':
        (asset as ImageBitmap | undefined)?.close();
        break;
      default:
        break;
    }
  }
}

function defaultDecodeImage(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    return Promise.reject(
      new Error('bundle: no createImageBitmap here; pass createBundle({ decodeImage })'),
    );
  }
  return createImageBitmap(blob);
}
