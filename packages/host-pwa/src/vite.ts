/**
 * `pwaPlugin(opts)`: the Vite plugin that turns a game's build into an installable app. It
 * imports nothing from the engine or the browser side of this package, so a `vite.config.ts` can
 * load it from `@thunderclap-engine/host-pwa/vite` in Node without pulling the host in.
 *
 * Build only (`apply: 'build'`). Hooks, in the order Vite runs them:
 *
 * 1. `buildStart`: rasterises the SVG icon where the environment can (see `rasterise`).
 * 2. `generateBundle`: reads the emitted chunks and assets into the precache list, stamps the
 *    version from it, and emits `manifest.webmanifest`, the icon(s) and `sw.js` (worker.ts).
 * 3. `transformIndexHtml` (post: Vite's own html plugin runs the post hooks in its
 *    `generateBundle`, which comes after this plugin's): injects the manifest link, the theme
 *    colour and the registration snippet with that version (manifest.ts `injectTags`).
 *
 * Imports carry `.ts` extensions because a `vite.config.ts` may load this file through Vite's
 * native config loader, which requires them.
 */
import type { Plugin } from 'vite';
import {
  type BundleLike,
  buildManifest,
  ICON_SIZES,
  injectTags,
  type ManifestOptions,
  pngIconFile,
  precacheList,
  SVG_ICON_FILE,
  versionStamp,
} from './manifest.ts';
import { workerSource } from './worker.ts';

export interface PwaPluginOptions {
  manifest: ManifestOptions;
  /**
   * Scope-relative path prefixes (`data/`, `levels/`) served stale-while-revalidate from the
   * runtime cache: things the game fetches at play time that are not in the bundle. Default none.
   */
  runtimeCache?: string[];
  /** Most entries the runtime cache keeps; the oldest are evicted first. Default 60. */
  maxRuntimeEntries?: number;
  /**
   * The version stamp. Default: a hash of the precache list and the page, so an identical
   * rebuild is not an update and any changed asset is.
   */
  version?: string;
  /** Default `sw.js`. */
  swFile?: string;
  /** Default `manifest.webmanifest`. */
  manifestFile?: string;
}

/**
 * Rasterises an SVG to PNG bytes at `size`, or returns null where the build environment has no
 * `OffscreenCanvas` (Node). Guarded so the plugin never fails a build over an icon.
 */
async function rasterise(svg: string, size: number): Promise<Uint8Array | null> {
  const g = globalThis as unknown as {
    OffscreenCanvas?: new (
      w: number,
      h: number,
    ) => {
      getContext(kind: '2d'): {
        drawImage(img: unknown, x: number, y: number, w: number, h: number): void;
      };
      convertToBlob(opts: { type: string }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
    };
    createImageBitmap?: (blob: Blob) => Promise<unknown>;
  };
  if (!g.OffscreenCanvas || !g.createImageBitmap) return null;
  try {
    const bitmap = await g.createImageBitmap(new Blob([svg], { type: 'image/svg+xml' }));
    const canvas = new g.OffscreenCanvas(size, size);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, size, size);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

export function pwaPlugin(opts: PwaPluginOptions): Plugin {
  const swFile = opts.swFile ?? 'sw.js';
  const manifestFile = opts.manifestFile ?? 'manifest.webmanifest';
  const runtimePrefixes = opts.runtimeCache ?? [];
  const maxRuntimeEntries = opts.maxRuntimeEntries ?? 60;
  let base = '/';
  let precache: string[] = [];
  let version = opts.version ?? '';
  let rasterised = false;
  const svg = opts.manifest.svg;
  let pngs: { size: number; bytes: Uint8Array }[] = [];

  const iconFiles = (): string[] => [
    ...(svg ? [SVG_ICON_FILE] : []),
    ...pngs.map((p) => pngIconFile(p.size)),
  ];

  return {
    name: 'thunderclap:pwa',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    async buildStart() {
      pngs = [];
      if (!svg) return;
      for (const size of ICON_SIZES) {
        const bytes = await rasterise(svg, size);
        if (bytes) pngs.push({ size, bytes });
      }
      rasterised = pngs.length === ICON_SIZES.length;
      if (!rasterised) pngs = [];
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return injectTags(html, base, {
          manifestFile,
          swFile,
          version,
          themeColor: opts.manifest.theme_color ?? '#000000',
        });
      },
    },
    generateBundle(_options, bundle) {
      precache = precacheList(bundle as unknown as BundleLike, [
        swFile,
        manifestFile,
        ...iconFiles(),
      ]);
      if (!opts.version) version = versionStamp(precache);
      const manifest = buildManifest(opts.manifest, rasterised);
      this.emitFile({
        type: 'asset',
        fileName: manifestFile,
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
      if (svg) this.emitFile({ type: 'asset', fileName: SVG_ICON_FILE, source: svg });
      for (const p of pngs) {
        this.emitFile({ type: 'asset', fileName: pngIconFile(p.size), source: p.bytes });
      }
      this.emitFile({
        type: 'asset',
        fileName: swFile,
        source: workerSource({ version, precache, runtimePrefixes, maxRuntimeEntries }),
      });
    },
  };
}
