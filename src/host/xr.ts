/// <reference path="../platform/xr-types.d.ts" />
/**
 * The XR host (ws/xr): a `Host` whose frames come from `XRSession.requestAnimationFrame`, so
 * `GameLoop.setFrames(createXrHost(session, host))` moves a running game into the headset and
 * every other host service (links, clipboard, fullscreen, storage, window, lifecycle, haptics,
 * safe area) keeps coming from the host it wraps. The session hands each frame callback an `XRFrame`; the host keeps it in `frame`
 * for the length of that tick (poses, input sources and the layer's textures are only valid
 * then), so `XrSurface.views(host.frame)` and `XrPointerSource` read it from here.
 */
import type { Host } from './types';

export interface XrHost extends Host {
  readonly kind: 'xr';
  readonly session: XRSession;
  /** The host this one delegates everything but frames to. */
  readonly base: Host;
  /** The `XRFrame` of the frame callback that is running now; null between frames. */
  readonly frame: XRFrame | null;
}

/**
 * Wraps `session.requestAnimationFrame` / `cancelAnimationFrame` as a `FrameSource` and
 * delegates every other `Host` member to `base`. Allocates nothing per frame once the loop's
 * callback is stable (`GameLoop` passes the same function every time).
 */
export function createXrHost(session: XRSession, base: Host): XrHost {
  let current: XRFrame | null = null;
  let lastCb: ((timeMs: number) => void) | null = null;
  let lastWrapped: XRFrameRequestCallback | null = null;
  const wrap = (cb: (timeMs: number) => void): XRFrameRequestCallback => {
    if (cb === lastCb && lastWrapped) return lastWrapped;
    lastCb = cb;
    lastWrapped = (time, xrFrame) => {
      current = xrFrame;
      try {
        cb(time);
      } finally {
        current = null;
      }
    };
    return lastWrapped;
  };
  return {
    kind: 'xr',
    session,
    base,
    get frame() {
      return current;
    },
    requestFrame: (cb) => session.requestAnimationFrame(wrap(cb)),
    cancelFrame: (handle) => session.cancelAnimationFrame(handle),
    get embed() {
      return base.embed;
    },
    openExternal: (url, opts) => base.openExternal(url, opts),
    copyText: (text) => base.copyText(text),
    clipboardWriteAllowed: () => base.clipboardWriteAllowed(),
    get fullscreen() {
      return base.fullscreen;
    },
    get storage() {
      return base.storage;
    },
    get window() {
      return base.window;
    },
    get lifecycle() {
      return base.lifecycle;
    },
    get haptics() {
      return base.haptics;
    },
    get safeArea() {
      return base.safeArea;
    },
  };
}
