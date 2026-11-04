/**
 * External links (D-036): URL validation, embed detection and the result types. Opening and
 * copying are host services: `Host.openExternal` and `Host.copyText` (engine/host; the web
 * implementation is host/web-links.ts). The widget is `externalLink` in engine/ui.
 */

/** How the player asked for the link: a real gesture (pointer/keyboard) or not (gamepad/script). */
export type LinkActivation = 'pointer' | 'keyboard' | 'gamepad' | 'script';

/** `invalid`: the URL failed `safeExternalUrl`, so nothing was attempted. */
export type OpenResult = 'opened' | 'blocked' | 'invalid';

/** `manual`: every copy method failed; show the URL for the player to copy by hand. */
export type CopyResult = 'copied' | 'manual';

/** Where the page runs: top level, or in a frame of the same or another origin (e.g. itch.io). */
export type EmbedContext = 'top' | 'same-origin-frame' | 'cross-origin-frame';

/**
 * The URL if it is a plain absolute `https:` link (no credentials, no whitespace), else null.
 * Callers hide the control on null, so a blank or bad constant never renders a dead link.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  const t = (url ?? '').trim();
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

/** Detects (does not assume) whether the page is framed, and whether by another origin. */
export function embedContext(win: Window = window): EmbedContext {
  let framed: boolean;
  try {
    framed = win.self !== win.top;
  } catch {
    return 'cross-origin-frame';
  }
  if (!framed) return 'top';
  try {
    // Reading a cross-origin parent's location throws (or yields nothing).
    return win.top?.location.href ? 'same-origin-frame' : 'cross-origin-frame';
  } catch {
    return 'cross-origin-frame';
  }
}
