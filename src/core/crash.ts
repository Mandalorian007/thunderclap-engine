/**
 * The crash screen (#6, E-040; ported from The Last Rune's `crash.ts`): an opt-in guard that
 * shows one calm card, "Something went wrong", for an uncaught error or unhandled rejection
 * from the game's own code, or for a throw while the game boots. The save is flushed first;
 * the card says the progress is saved only when that flush says it reached real storage. It
 * offers Reload, and Keep playing while the game still runs (Reload only for a boot throw).
 *
 * Shown at most once per page; later errors only reach the console. Noise that is not the
 * game's never shows it: browser extensions, other origins' scripts (and their cross-origin
 * "Script error."), ResizeObserver loop notices, and benign `AbortError` / `NotAllowedError`
 * rejections (an aborted fetch, a refused autoplay or fullscreen). It defers to the engine's own
 * fatal screens: while an unsupported or device-lost screen is up, it stays hidden.
 *
 * It is the engine's message screen (`showMessageScreen`, `.engine-msg` classes), so a game
 * restyles it with the same CSS as the unsupported screen. `createGame({ crash })` installs it
 * (and reports a boot throw); `installCrashScreen` is the same guard for a game that wants it
 * before `createGame` runs.
 */
import { showMessageScreen } from '../platform';

export interface CrashScreenOptions {
  /** Where the card mounts (the game's root element). */
  root: HTMLElement;
  /** The eyebrow line: the game's name. */
  title?: string;
  /**
   * Write pending progress now, before the card shows. Return true only when it reached real
   * storage: the card then says the progress is saved. A throw counts as not saved.
   */
  flush?: () => boolean;
  /** Reload the page. Default `location.reload()`. */
  reload?: () => void;
  /** The window whose errors are watched. Default `window`. */
  win?: Window;
}

export interface CrashScreen {
  /**
   * Show the card for `err` (once per page). `fatal`: the game is not running (a boot throw),
   * so the card offers Reload only.
   */
  report(err: unknown, opts?: { fatal?: boolean }): void;
  /** Whether the card has been shown on this page. */
  readonly shown: boolean;
  /** Stop watching the window's errors (a card already up stays). */
  dispose(): void;
}

const EXTENSION = /^[a-z-]*extension:\/\//;
const NOISE = [/ResizeObserver loop/, /^Script error\.?$/];
const BENIGN_NAMES = new Set(['AbortError', 'NotAllowedError']);

/** Is a script URL someone else's: a browser extension or another web origin? */
function foreign(url: string, origin: string): boolean {
  if (EXTENSION.test(url)) return true;
  return /^https?:\/\//.test(url) && !url.startsWith(`${origin}/`);
}

/** Is this window `error` event the page's own (not an extension or a cross-origin script)? */
export function isOwnError(ev: Pick<ErrorEvent, 'message' | 'filename'>, origin: string): boolean {
  const msg = ev.message ?? '';
  if (NOISE.some((re) => re.test(msg))) return false;
  return !foreign(ev.filename ?? '', origin);
}

/** Is this unhandled rejection reason the page's own, and not a benign abort? */
export function isOwnRejection(reason: unknown, origin: string): boolean {
  if (typeof reason !== 'object' || reason === null) return true;
  const r = reason as { name?: unknown; stack?: unknown };
  if (typeof r.name === 'string' && BENIGN_NAMES.has(r.name)) return false;
  // The first script URL in the stack says whose code it was.
  const first = typeof r.stack === 'string' ? r.stack.match(/[a-z-]+:\/\/[^\s)]+/)?.[0] : null;
  return !(first && foreign(first, origin));
}

/**
 * Watch the window for uncaught errors and unhandled rejections and show the crash card for
 * the game's own. Off until called; `createGame({ crash: true })` calls it for you.
 */
export function installCrashScreen(opts: CrashScreenOptions): CrashScreen {
  const win = opts.win ?? window;
  const origin = win.location.origin;
  let shown = false;

  const report = (_err: unknown, r: { fatal?: boolean } = {}): void => {
    if (shown) return;
    // Another fatal screen (no WebGPU, device lost) already says what to do.
    if (opts.root.querySelector('.engine-msg')) return;
    shown = true;
    let saved = false;
    try {
      saved = opts.flush?.() === true;
    } catch {
      saved = false;
    }
    const reload = opts.reload ?? (() => win.location.reload());
    const actions = [{ label: 'Reload', onClick: reload }];
    let close = () => {};
    if (!r.fatal) {
      actions.push({
        label: 'Keep playing',
        onClick: () => {
          close();
          opts.root.querySelector('canvas')?.focus();
        },
      });
    }
    close = showMessageScreen(opts.root, {
      eyebrow: opts.title,
      heading: 'Something went wrong',
      body: [
        r.fatal
          ? 'The game hit an unexpected error while starting.'
          : 'The game hit an unexpected error.',
        saved
          ? 'Your progress is saved. Reloading the page picks up where you left off.'
          : 'Reloading the page usually fixes it.',
      ],
      actions,
    });
  };

  const onError = (ev: ErrorEvent): void => {
    if (isOwnError(ev, origin)) report(ev.error ?? ev.message);
  };
  const onRejection = (ev: PromiseRejectionEvent): void => {
    if (isOwnRejection(ev.reason, origin)) report(ev.reason);
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return {
    report,
    get shown() {
      return shown;
    },
    dispose() {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
    },
  };
}
