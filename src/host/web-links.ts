/**
 * The web host's link service (D-036): opening and copying. Reached through `Host.openExternal`
 * and `Host.copyText` (createWebHost); nothing else in the engine calls `window.open` or the
 * clipboard.
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
import {
  type CopyResult,
  type LinkActivation,
  type OpenResult,
  safeExternalUrl,
} from '../platform/links';

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
