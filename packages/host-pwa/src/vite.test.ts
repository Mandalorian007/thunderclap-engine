import { describe, expect, it } from 'vitest';
import {
  type BundleLike,
  buildManifest,
  fnv1a,
  injectTags,
  precacheList,
  versionStamp,
} from './manifest';
import { pwaPlugin } from './vite';

const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';

describe('buildManifest', () => {
  it('fills the defaults a game leaves out', () => {
    expect(buildManifest({ name: 'Pairs' }, false)).toEqual({
      name: 'Pairs',
      short_name: 'Pairs',
      start_url: '.',
      scope: '.',
      display: 'standalone',
      orientation: 'landscape',
      theme_color: '#000000',
      background_color: '#000000',
      categories: ['games'],
      icons: [],
    });
  });
  it('lists the SVG icon, the PNGs only when rasterised, then the game icons', () => {
    const own = [{ src: 'icons/512.png', sizes: '512x512', type: 'image/png' }];
    const plain = buildManifest({ name: 'P', svg, icons: own }, false);
    expect(plain.icons.map((i) => i.src)).toEqual(['icon.svg', 'icons/512.png']);
    expect(plain.icons[0]).toMatchObject({ sizes: 'any', type: 'image/svg+xml' });
    const raster = buildManifest({ name: 'P', svg }, true);
    expect(raster.icons.map((i) => i.src)).toEqual(['icon.svg', 'icon-192.png', 'icon-512.png']);
    expect(raster.icons[2]).toMatchObject({ sizes: '512x512', type: 'image/png' });
  });
  it('keeps what the game sets', () => {
    const m = buildManifest(
      {
        name: 'P',
        short_name: 'Pz',
        description: 'd',
        display: 'fullscreen',
        orientation: 'any',
        theme_color: '#123',
        background_color: '#456',
        start_url: './?source=pwa',
        scope: '/play/',
        categories: ['games', 'puzzle'],
      },
      false,
    );
    expect(m).toMatchObject({
      short_name: 'Pz',
      description: 'd',
      display: 'fullscreen',
      orientation: 'any',
      theme_color: '#123',
      background_color: '#456',
      start_url: './?source=pwa',
      scope: '/play/',
      categories: ['games', 'puzzle'],
    });
  });
});

describe('injectTags', () => {
  const cfg = {
    manifestFile: 'manifest.webmanifest',
    swFile: 'sw.js',
    version: 'abc',
    themeColor: '#123',
  };
  it('adds the manifest link, theme colour and the registration snippet before </head>', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const out = injectTags(html, '/', cfg);
    expect(out).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(out).toContain('<meta name="theme-color" content="#123" />');
    expect(out).toContain('window.__tcPwa={sw:"/sw.js",version:"abc"}');
    expect(out).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(out.indexOf('<link rel="manifest"')).toBeLessThan(out.indexOf('</head>'));
    expect(out.indexOf('<title>')).toBeLessThan(out.indexOf('<link rel="manifest"'));
  });
  it('honours a sub-path base and a relative base', () => {
    expect(injectTags('<head></head>', '/game/', cfg)).toContain(
      'href="/game/manifest.webmanifest"',
    );
    expect(injectTags('<head></head>', './', cfg)).toContain('sw:"./sw.js"');
    expect(injectTags('<head></head>', '/game', cfg)).toContain(
      'href="/game/manifest.webmanifest"',
    );
  });
  it('prepends when the page has no head', () => {
    expect(injectTags('<p>x</p>', '/', cfg).startsWith('<link rel="manifest"')).toBe(true);
  });
});

describe('precacheList', () => {
  const bundle: BundleLike = {
    'assets/main-Ab12.js': { type: 'chunk', fileName: 'assets/main-Ab12.js' },
    'assets/main-Ab12.js.map': { type: 'asset', fileName: 'assets/main-Ab12.js.map' },
    'assets/style-Cd34.css': { type: 'asset', fileName: 'assets/style-Cd34.css' },
    'sw.js': { type: 'asset', fileName: 'sw.js' },
    'manifest.webmanifest': { type: 'asset', fileName: 'manifest.webmanifest' },
    'index.html': { type: 'asset', fileName: 'index.html' },
    'about.html': { type: 'asset', fileName: 'about.html' },
  };
  it('lists the chunks and assets, sorted, plus index.html, without the worker, manifest, maps or pages', () => {
    expect(precacheList(bundle, ['sw.js', 'manifest.webmanifest'])).toEqual([
      'assets/main-Ab12.js',
      'assets/style-Cd34.css',
      'index.html',
    ]);
  });
  it('is index.html alone for an empty bundle', () => {
    expect(precacheList({}, [])).toEqual(['index.html']);
  });
});

describe('versionStamp', () => {
  it('is stable for the same list and changes with any entry', () => {
    const a = versionStamp(['x.js', 'index.html']);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(versionStamp(['x.js', 'index.html'])).toBe(a);
    expect(versionStamp(['y.js', 'index.html'])).not.toBe(a);
    expect(versionStamp(['x.js', 'index.html', 'z.css'])).not.toBe(a);
    expect(fnv1a('')).toBe('811c9dc5');
  });
});

/** Runs the plugin's hooks the way Vite's build does, recording what it emits. */
async function runPlugin(
  opts: Parameters<typeof pwaPlugin>[0],
  base = '/',
  html = '<head></head>',
) {
  const plugin = pwaPlugin(opts);
  const emitted: Record<string, string | Uint8Array> = {};
  const ctx = {
    emitFile(f: { fileName: string; source: string | Uint8Array }) {
      emitted[f.fileName] = f.source;
      return f.fileName;
    },
  };
  const bundle: BundleLike = {
    'assets/main-Ab12.js': { type: 'chunk', fileName: 'assets/main-Ab12.js' },
  };
  const hooks = plugin as unknown as {
    apply: string;
    configResolved(c: { base: string }): void;
    buildStart(this: unknown): Promise<void>;
    transformIndexHtml: { order: string; handler(html: string): string };
    generateBundle(this: typeof ctx, o: unknown, b: BundleLike): void;
  };
  hooks.configResolved({ base });
  await hooks.buildStart.call(ctx);
  // Vite's order: this plugin's generateBundle, then the html plugin's, which runs the post hooks.
  hooks.generateBundle.call(ctx, {}, bundle);
  const page = hooks.transformIndexHtml.handler(html);
  return { plugin, hooks, emitted, page };
}

describe('pwaPlugin', () => {
  it('is a build-only plugin whose html hook runs after the worker is emitted', async () => {
    const { hooks } = await runPlugin({ manifest: { name: 'P' } });
    expect(hooks.apply).toBe('build');
    expect(hooks.transformIndexHtml.order).toBe('post');
  });
  it('emits the manifest, the SVG icon and a worker that precaches the bundle', async () => {
    const { emitted, page } = await runPlugin({
      manifest: { name: 'P', svg, theme_color: '#abc' },
      runtimeCache: ['data/'],
      maxRuntimeEntries: 9,
    });
    expect(Object.keys(emitted).sort()).toEqual(['icon.svg', 'manifest.webmanifest', 'sw.js']);
    const manifest = JSON.parse(emitted['manifest.webmanifest'] as string);
    expect(manifest.name).toBe('P');
    // Node has no OffscreenCanvas: the SVG goes alone, no PNGs are promised.
    expect(manifest.icons.map((i: { src: string }) => i.src)).toEqual(['icon.svg']);
    expect(emitted['icon.svg']).toBe(svg);
    const sw = emitted['sw.js'] as string;
    expect(sw).toContain('new Set(["assets/main-Ab12.js","index.html"])');
    expect(sw).toContain('const RUNTIME_PREFIXES = ["data/"];');
    expect(sw).toContain('const MAX_RUNTIME = 9;');
    const version = /const VERSION = "([0-9a-f]{8})";/.exec(sw)?.[1];
    expect(version).toBeDefined();
    expect(page).toContain(`version:"${version}"`);
    expect(page).toContain('content="#abc"');
  });
  it('takes a fixed version and custom file names', async () => {
    const { emitted, page } = await runPlugin(
      {
        manifest: { name: 'P' },
        version: '2.1.0',
        swFile: 'worker.js',
        manifestFile: 'app.webmanifest',
      },
      '/play/',
    );
    expect(Object.keys(emitted).sort()).toEqual(['app.webmanifest', 'worker.js']);
    expect(emitted['worker.js']).toContain('const VERSION = "2.1.0";');
    expect(page).toContain('href="/play/app.webmanifest"');
    expect(page).toContain('sw:"/play/worker.js",version:"2.1.0"');
  });
});
