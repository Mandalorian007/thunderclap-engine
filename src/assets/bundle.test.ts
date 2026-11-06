import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import { type Bundle, type BundleProgress, createBundle, type ReadResult } from './bundle';
import type { GltfJson } from './gltf';
import type { GltfImageSource } from './gltf-load';
import { defineManifest, type Manifest } from './manifest';

const enc = new TextEncoder();
const bytes = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

/** A fake decoded image: what `createImageBitmap` would give, for the fake GPU. */
function fakeBitmap(w = 4, h = 4): ImageBitmap {
  return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap;
}
const decodeImage = async (): Promise<ImageBitmap> => fakeBitmap();
const decodeGltfImage = async (): Promise<GltfImageSource> => fakeBitmap();

/** A `.gltf` (JSON text) with one external buffer `scene.bin` and one external image `tex.png`. */
function sampleGltf(): { gltf: ArrayBuffer; bin: ArrayBuffer } {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const bin = new Uint8Array(tri.byteLength + uv.byteLength);
  bin.set(new Uint8Array(tri.buffer), 0);
  bin.set(new Uint8Array(uv.buffer), tri.byteLength);
  const json: GltfJson = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength, uri: 'scene.bin' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: tri.byteLength },
      { buffer: 0, byteOffset: tri.byteLength, byteLength: uv.byteLength },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    images: [{ uri: 'tex.png' }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
  return { gltf: bytes(JSON.stringify(json)), bin: bin.buffer };
}

interface FakeReader {
  read: (uri: string) => Promise<ReadResult>;
  calls: string[];
  inFlight: () => number;
  maxInFlight: () => number;
  /** Resolve every read that is waiting (when `manual`). */
  flush: () => void;
}

/** A `read` over a map, with an optional per-read delay or manual release. */
function reader(
  files: Record<string, ReadResult | (() => ReadResult)>,
  opts: { delay?: number; manual?: boolean; fail?: string[]; failTimes?: number } = {},
): FakeReader {
  const calls: string[] = [];
  let active = 0;
  let max = 0;
  let failures = 0;
  const pending: (() => void)[] = [];
  const read = (uri: string): Promise<ReadResult> => {
    calls.push(uri);
    active++;
    if (active > max) max = active;
    const finish = (): ReadResult => {
      active--;
      if (opts.fail?.includes(uri) && (opts.failTimes === undefined || failures < opts.failTimes)) {
        failures++;
        throw new Error(`no such file: ${uri}`);
      }
      const f = files[uri];
      if (f === undefined) throw new Error(`no such file: ${uri}`);
      return typeof f === 'function' ? f() : f;
    };
    if (opts.manual)
      return new Promise((res, rej) =>
        pending.push(() => Promise.resolve().then(finish).then(res, rej)),
      );
    return new Promise((res, rej) => {
      setTimeout(() => {
        try {
          res(finish());
        } catch (e) {
          rej(e);
        }
      }, opts.delay ?? 0);
    });
  };
  return {
    read,
    calls,
    inFlight: () => active,
    maxInFlight: () => max,
    flush: () => {
      const p = pending.splice(0);
      for (const f of p) f();
    },
  };
}

function gpu() {
  const fake = createFakeDevice();
  const renderer = new Renderer(fakeRendererGpu(fake));
  return { fake, renderer };
}

const plain = defineManifest({
  config: { kind: 'json', uri: 'config.json' },
  credits: { kind: 'text', uri: 'credits.txt' },
  blob: { kind: 'bytes', uri: 'blob.bin' },
  copy: { kind: 'text', uri: 'config.json' },
});

const plainFiles = {
  'config.json': bytes('{"lives":3}'),
  'credits.txt': new Blob([bytes('thanks')]),
  'blob.bin': new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
};

describe('createBundle', () => {
  afterEach(() => vi.useRealTimers());

  it('loads json, text and bytes and types them', async () => {
    const r = reader(plainFiles);
    const b = createBundle(plain, { read: r.read });
    expect(b.has('config')).toBe(false);
    expect(() => b.get('config')).toThrow(/"config" is not loaded/);
    await b.load();
    expect(b.get('config')).toEqual({ lives: 3 });
    expect(b.get('credits')).toBe('thanks');
    expect(new Uint8Array(b.get('blob'))).toEqual(new Uint8Array([1, 2, 3]));
    expect(b.get('copy')).toBe('{"lives":3}');
    expect(b.has('config')).toBe(true);
    expect(b.errors).toEqual([]);
    expect(b.progress).toMatchObject({ loaded: 4, failed: 0, total: 4, fraction: 1 });
    // Bytes: config.json 11, credits 6, blob 3; config.json shared, counted once.
    expect(b.progress.bytes).toBe(11 + 6 + 3);
    expect(b.progress.bytesTotal).toBeNull();
  });

  it('reads a uri shared by two entries once', async () => {
    const r = reader(plainFiles);
    const b = createBundle(plain, { read: r.read });
    await b.load();
    expect(r.calls.filter((u) => u === 'config.json')).toHaveLength(1);
    expect(r.calls).toHaveLength(3);
  });

  it('never exceeds concurrency and honours priority', async () => {
    const files: Record<string, ReadResult> = {};
    const entries: Manifest = {};
    for (let i = 0; i < 10; i++) {
      files[`f${i}`] = bytes(`${i}`);
      entries[`k${i}`] = { kind: 'text', uri: `f${i}` };
    }
    const r = reader(files, { delay: 2 });
    const b = createBundle(entries, {
      read: r.read,
      concurrency: 3,
      priority: (k) => (k === 'k9' ? 10 : k === 'k5' ? 5 : 0),
    });
    await b.load();
    expect(r.maxInFlight()).toBe(3);
    expect(r.calls.slice(0, 2)).toEqual(['f9', 'f5']);
    expect(r.calls).toHaveLength(10);
    for (let i = 0; i < 10; i++) expect(b.get(`k${i}`)).toBe(`${i}`);
  });

  it('reports monotonic progress ending at 1, asset and done events', async () => {
    const r = reader(plainFiles, { delay: 1 });
    const b = createBundle(plain, { read: r.read });
    const fractions: number[] = [];
    const assets: string[] = [];
    let done: BundleProgress | null = null;
    b.on('progress', (p) => fractions.push(p.fraction));
    b.on('asset', (a) => assets.push(a.key));
    b.on('done', (p) => {
      done = { ...p };
    });
    await b.load();
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    expect(fractions.at(-1)).toBe(1);
    expect(assets.sort()).toEqual(['blob', 'config', 'copy', 'credits']);
    expect(done).toMatchObject({ loaded: 4, total: 4, fraction: 1 });
  });

  it('counts bytes and bytesTotal from { data, total } results', async () => {
    const r = reader({
      'config.json': { data: bytes('{"lives":3}'), total: 100 },
      'credits.txt': { data: new Blob([bytes('thanks')]), total: 50 },
      'blob.bin': new ArrayBuffer(3),
    });
    const b = createBundle(plain, { read: r.read });
    await b.load();
    expect(b.progress.bytes).toBe(11 + 6 + 3);
    expect(b.progress.bytesTotal).toBe(150);
  });

  it('cancel stops further reads and leaves the rest unloaded; load resumes them', async () => {
    const files: Record<string, ReadResult> = {};
    const entries: Manifest = {};
    for (let i = 0; i < 8; i++) {
      files[`f${i}`] = bytes(`${i}`);
      entries[`k${i}`] = { kind: 'text', uri: `f${i}` };
    }
    const r = reader(files, { manual: true });
    const b = createBundle(entries, { read: r.read, concurrency: 2 });
    let done = 0;
    b.on('done', () => done++);
    const loading = b.load();
    await vi.waitFor(() => expect(r.calls).toEqual(['f0', 'f1']));
    r.flush(); // f0 and f1 land; f2 and f3 start
    await vi.waitFor(() => expect(r.calls).toHaveLength(4));
    b.cancel();
    expect(b.cancelled).toBe(true);
    r.flush(); // f2, f3 resolve but are dropped
    await loading;
    expect(r.calls).toHaveLength(4);
    expect(b.progress.loaded).toBe(2);
    expect(b.progress.fraction).toBeLessThan(1);
    expect(b.errors).toEqual([]);
    expect(done).toBe(0);
    expect(b.has('k2')).toBe(false);

    const again = b.load();
    expect(b.cancelled).toBe(false);
    let settled = false;
    again.then(() => {
      settled = true;
    });
    while (!settled) {
      await new Promise((res) => setTimeout(res, 1));
      r.flush();
    }
    expect(b.progress).toMatchObject({ loaded: 8, total: 8, fraction: 1 });
    expect(done).toBe(1);
  });

  it('records per-key errors without failing load; strict rejects', async () => {
    const r = reader(plainFiles, { fail: ['credits.txt'] });
    const b = createBundle(plain, { read: r.read });
    const errors: string[] = [];
    b.on('error', (e) => errors.push(e.key));
    await b.load();
    expect(errors).toEqual(['credits']);
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatchObject({ key: 'credits', uri: 'credits.txt' });
    expect(b.errors[0]!.message).toMatch(/no such file/);
    expect(b.progress).toMatchObject({ loaded: 3, failed: 1, total: 4, fraction: 1 });
    expect(() => b.get('credits')).toThrow(/"credits" failed to load: no such file/);
    expect(b.get('config')).toEqual({ lives: 3 });

    const strict = createBundle(plain, {
      read: reader(plainFiles, { fail: ['credits.txt'] }).read,
      strict: true,
    });
    await expect(strict.load()).rejects.toMatchObject({ key: 'credits' });
    expect(strict.cancelled).toBe(true);

    // A later load retries failed keys.
    const r2 = reader(plainFiles, { fail: ['credits.txt'], failTimes: 1 });
    const b2 = createBundle(plain, { read: r2.read });
    await b2.load();
    expect(b2.errors).toHaveLength(1);
    await b2.load();
    expect(b2.errors).toEqual([]);
    expect(b2.get('credits')).toBe('thanks');
    expect(b2.progress).toMatchObject({ loaded: 4, failed: 0, total: 4 });
  });

  it('retries a failed read `retries` times', async () => {
    const r = reader(plainFiles, { fail: ['credits.txt'], failTimes: 2 });
    const b = createBundle(plain, { read: r.read, retries: 2 });
    await b.load();
    expect(b.errors).toEqual([]);
    expect(r.calls.filter((u) => u === 'credits.txt')).toHaveLength(3);
    const r2 = reader(plainFiles, { fail: ['credits.txt'], failTimes: 2 });
    const b2 = createBundle(plain, { read: r2.read, retries: 1 });
    await b2.load();
    expect(b2.errors).toHaveLength(1);
  });

  it('loads only the keys asked for, and rejects unknown keys', async () => {
    const r = reader(plainFiles);
    const b = createBundle(plain, { read: r.read });
    await b.load(['blob']);
    expect(b.progress).toMatchObject({ loaded: 1, total: 1, fraction: 1 });
    expect(b.has('blob')).toBe(true);
    expect(b.has('config')).toBe(false);
    await expect(b.load(['nope' as 'blob'])).rejects.toThrow(/unknown key "nope"/);
  });

  it('decodes textures, texture arrays, images and atlases on the GPU, and releases them', async () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return {
            drawImage() {},
            createImageData: (w: number, h: number) => ({
              width: w,
              height: h,
              data: new Uint8ClampedArray(w * h * 4),
            }),
            putImageData() {},
          };
        }
      },
    );
    try {
      const { renderer } = gpu();
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer as ArrayBuffer;
      const m = defineManifest({
        hero: { kind: 'texture', uri: 'hero.png', options: { mips: false } },
        tiles: { kind: 'texture-array', uris: ['a.png', 'b.png'] },
        icon: { kind: 'image', uri: 'icon.png' },
        sprites: { kind: 'atlas', uris: { coin: 'a.png', gem: 'hero.png' } },
      });
      const r = reader({
        'hero.png': png,
        'a.png': new Blob([png]),
        'b.png': png,
        'icon.png': png,
      });
      const b = createBundle(m, { read: r.read, renderer, decodeImage });
      await b.load();
      expect(b.errors).toEqual([]);
      const hero = b.get('hero');
      expect(hero.width).toBe(4);
      expect(hero.mipLevels).toBe(1);
      const tiles = b.get('tiles');
      expect(tiles.layers).toBe(2);
      expect(tiles.viewDimension).toBe('2d-array');
      expect(b.get('icon').width).toBe(4);
      const sprites = b.get('sprites');
      expect(Object.keys(sprites.rects).sort()).toEqual(['coin', 'gem']);
      expect(sprites.texture.width).toBe(sprites.layout.width);
      expect(sprites.rects.coin.w).toBe(4);
      // hero.png and a.png are each read once across their two users.
      expect(r.calls.filter((u) => u === 'hero.png')).toHaveLength(1);
      expect(r.calls.filter((u) => u === 'a.png')).toHaveLength(1);

      const destroyed: string[] = [];
      for (const [k, t] of [
        ['hero', hero],
        ['tiles', tiles],
        ['sprites', sprites.texture],
      ] as const) {
        t.destroy = () => destroyed.push(k);
      }
      const icon = b.get('icon');
      b.release('hero');
      expect(destroyed).toEqual(['hero']);
      expect(b.has('hero')).toBe(false);
      expect(b.progress).toMatchObject({ loaded: 3, total: 3 });
      b.release();
      expect(destroyed.sort()).toEqual(['hero', 'sprites', 'tiles']);
      expect((icon as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
      expect(b.progress).toMatchObject({ loaded: 0, total: 0, fraction: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('names the missing renderer or audio context', async () => {
    const m = defineManifest({
      hero: { kind: 'texture', uri: 'hero.png' },
      jump: { kind: 'audio', uri: 'jump.wav' },
    });
    const r = reader({ 'hero.png': new ArrayBuffer(4), 'jump.wav': new ArrayBuffer(4) });
    const b = createBundle(m, { read: r.read, decodeImage });
    await b.load();
    expect(b.errors.map((e) => e.key).sort()).toEqual(['hero', 'jump']);
    expect(b.errors.find((e) => e.key === 'hero')!.message).toMatch(
      /needs createBundle\(\{ renderer \}\)/,
    );
    expect(b.errors.find((e) => e.key === 'jump')!.message).toMatch(
      /needs createBundle\(\{ audio \}\)/,
    );
    // A locked AudioEngine (context null) is the same error.
    const locked = createBundle(m, { read: r.read, audio: { context: null } });
    await locked.load(['jump']);
    expect(locked.errors[0]!.message).toMatch(/audio "jump" needs/);
  });

  it('decodes audio through the context, on a copy of shared bytes', async () => {
    const m = defineManifest({
      jump: { kind: 'audio', uri: 'jump.wav' },
      raw: { kind: 'bytes', uri: 'jump.wav' },
    });
    const wav = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
    const decoded = { duration: 1 } as AudioBuffer;
    const seen: ArrayBuffer[] = [];
    const audio = {
      context: {
        decodeAudioData: async (d: ArrayBuffer) => {
          seen.push(d);
          return decoded;
        },
      },
    };
    const b = createBundle(m, { read: reader({ 'jump.wav': wav }).read, audio });
    await b.load();
    expect(b.get('jump')).toBe(decoded);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(wav);
    expect(new Uint8Array(seen[0]!)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(b.get('raw')).toBe(wav);
  });

  it('loads a .gltf with its external buffer and image through the resources map', async () => {
    const { renderer } = gpu();
    const { gltf, bin } = sampleGltf();
    const m = defineManifest({
      level: {
        kind: 'gltf',
        uri: 'level.gltf',
        resources: { 'tex.png': 'textures/tex.png' },
        options: { decodeImage: decodeGltfImage },
      },
    });
    const r = reader({
      'level.gltf': gltf,
      'scene.bin': bin,
      'textures/tex.png': new ArrayBuffer(8),
    });
    const b = createBundle(m, { read: r.read, renderer });
    await b.load();
    expect(b.errors).toEqual([]);
    expect(r.calls.sort()).toEqual(['level.gltf', 'scene.bin', 'textures/tex.png']);
    const scene = b.get('level');
    expect(scene.meshes).toHaveLength(1);
    expect(scene.textures).toHaveLength(1);
    let destroyed = false;
    scene.destroy = () => {
      destroyed = true;
    };
    b.release('level');
    expect(destroyed).toBe(true);
  });

  it('reports a glTF whose external resource is missing against that uri', async () => {
    const { renderer } = gpu();
    const { gltf, bin } = sampleGltf();
    const m = defineManifest({ level: { kind: 'gltf', uri: 'level.gltf' } });
    const r = reader({ 'level.gltf': gltf, 'scene.bin': bin });
    const b = createBundle(m, { read: r.read, renderer });
    await b.load();
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatchObject({ key: 'level', uri: 'tex.png' });
  });

  it('dispose cancels, releases and drops listeners', async () => {
    const r = reader(plainFiles);
    const b: Bundle<typeof plain> = createBundle(plain, { read: r.read });
    let events = 0;
    b.on('progress', () => events++);
    await b.load();
    b.dispose();
    const after = events;
    expect(b.has('config')).toBe(false);
    expect(b.progress.total).toBe(0);
    await b.load(['blob']);
    expect(events).toBe(after);
  });
});
