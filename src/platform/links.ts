/**
 * External links: validation, embed detection, opening and copying (D-036). Logic only; the
 * widget is `externalLink` in engine/ui.
 *
 * Rules: nothing here runs on its own (call it from a player action), and nothing is fetched.
 *
 * Facts this is built on (docs/research/itch-webgpu.md, "Clipboard and popups"):
 * - A tab opened from a real click or key press on `<a target=_blank>` is allowed by popup
 *   blockers. A gamepad press is not a user activation, so `window.open` from it can be blocked
 *   (it then returns null).
 * - Embeds may lack `clipboard-write` in the iframe's permissions policy (itch.io does:
 *   https://github.com/itchio/itch.io/issues/1202), so Chromium rejects `clipboard.writeText`
 *   there. `execCommand('copy')` on a selected textarea, inside the gesture, still works.
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

/**
 * Opens `url` in a new tab. With a real gesture (`pointer`/`keyboard`) it clicks a temporary
 * `<a target=_blank rel="noopener noreferrer">`, which popup blockers allow; the browser gives no
 * signal back, so the result is `opened`. Otherwise (`gamepad`/`script`) it uses `window.open`,
 * whose null return means `blocked`; the opened tab's `opener` is cleared.
 */
export function openExternal(
  url: string,
  opts: { activation: LinkActivation },
  win: Window = window,
): OpenResult {
  const href = safeExternalUrl(url);
  if (!href) return 'invalid';
  if (opts.activation === 'pointer' || opts.activation === 'keyboard') {
    const doc = win.document;
    const a = doc.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    doc.body.append(a);
    a.click();
    a.remove();
    return 'opened';
  }
  let w: Window | null = null;
  try {
    // Not the 'noopener' feature: with it, window.open returns null even when the tab opened.
    w = win.open(href, '_blank');
  } catch {
    w = null;
  }
  if (!w) return 'blocked';
  try {
    w.opener = null;
  } catch {
    // Read-only in some browsers; the tab is open either way.
  }
  return 'opened';
}

/**
 * Copies `text`: the async Clipboard API, then a hidden textarea + `execCommand('copy')`, else
 * `manual`. Call it from the player's click or key handler; both methods need that gesture.
 */
export async function copyText(text: string, win: Window = window): Promise<CopyResult> {
  try {
    const clip = win.navigator.clipboard;
    if (clip?.writeText && clipboardWriteAllowed(win.document)) {
      await clip.writeText(text);
      return 'copied';
    }
  } catch {
    // Refused (permissions policy, no focus, no gesture): try the older way.
  }
  return execCopy(text, win.document) ? 'copied' : 'manual';
}

/**
 * False when the frame's permissions policy rules out `clipboard-write` (itch's iframe: its
 * `allow` list lacks it). Checked where the browser exposes the policy (Chromium), so the
 * Clipboard API is not even tried there and no policy-violation error is logged. Elsewhere true.
 */
export function clipboardWriteAllowed(doc: Document = document): boolean {
  type Policy = { allowsFeature?: (feature: string) => boolean };
  const d = doc as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy };
  const policy = d.permissionsPolicy ?? d.featurePolicy;
  try {
    return policy?.allowsFeature ? policy.allowsFeature('clipboard-write') : true;
  } catch {
    return true;
  }
}

/** `execCommand('copy')` from an off-screen textarea; focus goes back where it was. */
export function execCopy(text: string, doc: Document = document): boolean {
  const prev = doc.activeElement as HTMLElement | null;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.setAttribute('tabindex', '-1');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
  doc.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus?.({ preventScroll: true });
  return ok;
}
