/**
 * The shell's security rules as pure functions (unit-tested in policy.test.ts):
 * which links may leave the app, which files the `app://` protocol may serve, and which
 * requests may leave the renderer. src/main/main.ts applies them.
 */
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

/** The privileged scheme the shell serves the page from. One fixed origin keeps saves put. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * The main process's copy of the engine's `safeExternalUrl` (platform/links.ts): the URL when
 * it is a plain absolute `https:` link with no credentials and no whitespace, else null. It is
 * checked again here because the bridge can be called with anything.
 */
export function safeExternalHttps(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const t = url.trim();
  if (!t || /\s/.test(t) || !/^https:\/\//i.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return t;
}

/**
 * The file under `root` that `app://bundle/<path>` names, or null when the path leaves `root`
 * (`..`, encoded or not) or is malformed. `/` and paths without an extension serve index.html,
 * so a single-page app's routes resolve.
 */
export function bundleFile(root: string, requestUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  if (path === '/' || path === '' || !extname(path)) path = '/index.html';
  const base = resolve(root);
  const file = resolve(base, `.${path}`);
  const rel = relative(base, file);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return null;
  return file;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
};

export function mimeType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The Content-Security-Policy on every `app://` response. Same-origin only: no request can
 * leave the machine from the page, and no inline script runs. Inline styles are allowed
 * because engine widgets set them.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The dev server URL from `TC_RENDERER_URL`, when it is http(s) on this machine
 * (`localhost`, `127.0.0.1` or `[::1]`), else null.
 */
export function localDevUrl(url: string | undefined): URL | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
  return u;
}

/**
 * Whether the renderer may make this request. Only the page's own origin (`app://bundle`, or
 * the local dev server and its HMR socket) and in-memory URLs; everything that would reach
 * the network is cancelled.
 */
export function requestAllowed(url: string, dev: URL | null): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  switch (u.protocol) {
    case `${APP_SCHEME}:`:
      return u.host === APP_HOST;
    case 'data:':
    case 'blob:':
    case 'devtools:':
      return true;
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:':
      return !!dev && u.hostname === dev.hostname && u.port === dev.port;
    default:
      return false;
  }
}

/**
 * Whether a top-level navigation to `url` stays on the page's own origin. Compared by scheme
 * and host because `URL.origin` is the string "null" for every custom scheme such as `app:`.
 */
export function navigationAllowed(url: string, start: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(start);
    return a.protocol === b.protocol && a.host === b.host && !!a.host;
  } catch {
    return false;
  }
}
