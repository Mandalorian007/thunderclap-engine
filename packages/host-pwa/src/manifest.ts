/**
 * Build-time pieces of the plugin as pure functions: the web manifest, the `index.html`
 * injection, the precache list from a bundle and the version stamp. vite.ts wires them into
 * Vite's hooks; vite.test.ts exercises them on fakes.
 */

export interface ManifestIcon {
  /** Path relative to the build root, e.g. `icons/icon-192.png`. */
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
}

export interface ManifestOptions {
  name: string;
  short_name?: string;
  description?: string;
  /** Default `#000000`. */
  theme_color?: string;
  /** Default `#000000`. */
  background_color?: string;
  /** Default `standalone`. */
  display?: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
  /** Default `landscape` (a game); `any` lets the page follow the device. */
  orientation?: 'any' | 'landscape' | 'portrait' | 'natural';
  /** Default `.` (the build root). */
  start_url?: string;
  /** Default `.`. */
  scope?: string;
  /** Default `games`. */
  categories?: string[];
  /**
   * One SVG document. The plugin emits it as `icon.svg` (`sizes: any`) and, where
   * `OffscreenCanvas` exists at build time, rasterises it to `icon-192.png` and `icon-512.png`.
   * Node has no `OffscreenCanvas`, so under `vite build` the SVG goes alone unless `icons` names
   * PNGs the game ships in `public/`.
   */
  svg?: string;
  /** Icons the game provides itself (paths relative to the build root). */
  icons?: ManifestIcon[];
}

export interface WebManifest {
  name: string;
  short_name: string;
  description?: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  theme_color: string;
  background_color: string;
  categories: string[];
  icons: ManifestIcon[];
}

/** Rasterised icons the plugin emits next to the manifest. */
export const ICON_SIZES = [192, 512] as const;
export const SVG_ICON_FILE = 'icon.svg';
export const pngIconFile = (size: number): string => `icon-${size}.png`;

/**
 * The manifest as written. `svg` adds the SVG icon (and the PNG names when `rasterised`); the
 * game's own `icons` follow.
 */
export function buildManifest(opts: ManifestOptions, rasterised: boolean): WebManifest {
  const icons: ManifestIcon[] = [];
  if (opts.svg) {
    icons.push({ src: SVG_ICON_FILE, sizes: 'any', type: 'image/svg+xml', purpose: 'any' });
    if (rasterised) {
      for (const s of ICON_SIZES) {
        icons.push({ src: pngIconFile(s), sizes: `${s}x${s}`, type: 'image/png', purpose: 'any' });
      }
    }
  }
  icons.push(...(opts.icons ?? []));
  const m: WebManifest = {
    name: opts.name,
    short_name: opts.short_name ?? opts.name,
    start_url: opts.start_url ?? '.',
    scope: opts.scope ?? '.',
    display: opts.display ?? 'standalone',
    orientation: opts.orientation ?? 'landscape',
    theme_color: opts.theme_color ?? '#000000',
    background_color: opts.background_color ?? '#000000',
    categories: opts.categories ?? ['games'],
    icons,
  };
  if (opts.description) m.description = opts.description;
  return m;
}

/** What the page learns from the build: read by `createPwaHost` when it is given no `swUrl`. */
export const PAGE_GLOBAL = '__tcPwa';

/**
 * The tags injected into `index.html`: the manifest link, a theme colour, and a snippet that
 * publishes `window.__tcPwa = { sw, version }` and registers the worker, so a page that never
 * calls `createPwaHost` still works offline. `base` is Vite's `base` (`/`, `./`, `/game/`).
 */
export function injectTags(html: string, base: string, cfg: HtmlInjection): string {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const sw = JSON.stringify(`${prefix}${cfg.swFile}`);
  const version = JSON.stringify(cfg.version);
  const tags = [
    `<link rel="manifest" href="${prefix}${cfg.manifestFile}" />`,
    `<meta name="theme-color" content="${cfg.themeColor}" />`,
    `<script>window.${PAGE_GLOBAL}={sw:${sw},version:${version}};if('serviceWorker' in navigator)navigator.serviceWorker.register(${sw}).catch(function(){});</script>`,
  ].join('\n    ');
  if (html.includes('</head>')) return html.replace(/\s*<\/head>/, `\n    ${tags}\n  </head>`);
  return `${tags}\n${html}`;
}

export interface HtmlInjection {
  manifestFile: string;
  swFile: string;
  version: string;
  themeColor: string;
}

/** The subset of a Rollup/Rolldown output bundle the precache list reads. */
export interface BundleLike {
  [fileName: string]: { type: 'chunk' | 'asset'; fileName: string };
}

/**
 * Scope-relative paths to precache: every emitted chunk and asset except the worker and the
 * manifest, plus `index.html`. Sorted so the list (and the version stamped from it) is stable.
 */
export function precacheList(bundle: BundleLike, exclude: Iterable<string>): string[] {
  const skip = new Set(exclude);
  const out = Object.values(bundle)
    .map((o) => o.fileName)
    .filter((f) => !skip.has(f) && !f.endsWith('.map') && !f.endsWith('.html'));
  out.push('index.html');
  return [...new Set(out)].sort();
}

/** FNV-1a over a string, as 8 hex digits. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The build's version stamp: a hash of the precache list. Every chunk and asset carries a content
 * hash in its name, so any changed code or asset changes the list and the stamp, while an
 * identical rebuild keeps it (no spurious update). `index.html` is not in the stamp: it is served
 * network-first and its cached copy is refreshed on every online load, so a page-only change
 * needs no new worker.
 */
export function versionStamp(precache: string[]): string {
  return fnv1a(precache.join('\n'));
}
