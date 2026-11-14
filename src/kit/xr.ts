/**
 * The XR service (ws/kit): `ctx.xr.enter()` requests an `immersive-vr` session, swaps the loop's
 * frames to it, adds the controllers and hands to the pointer router and builds the XR surface
 * the loop renders each eye into; leaving puts everything back.
 */

import type { GameLoop } from '../core/loop';
import { createXrHost, type Host, type XrHost } from '../host';
import { type PointerRouter, XrPointerSource } from '../input';
import { type GpuContext, XrSurface } from '../platform';
import type { XRFrame, XRReferenceSpace, XRSession, XrNavigator } from '../platform/xr-types';
import type { Renderer, SceneTargetAux } from '../render';
import type { KitPart, KitService, XrControl, XrOptions } from './types';

/** `createKitXr`'s dependencies. */
export interface KitXrDeps extends XrOptions {
  gpu: GpuContext;
  /** Its `format` is the layer's colour format. */
  renderer: Renderer;
  /** The page's host: frames come back to it when the session ends. */
  host: Host;
  /** The loop whose frames move to the session and back. */
  loop: GameLoop;
  /** Controllers and hands join it while a session runs; null for none. */
  pointers: PointerRouter<unknown> | null;
  /** The XR scene target's aux attachments (the renderer's). */
  aux?: SceneTargetAux;
}

/** What `createKitXr` returns: `ctx.xr` and the running session's frame for the render step. */
export interface KitXr extends KitPart<KitXrFields> {
  /** The XR surface while a session runs, else null (`control.surface`). */
  readonly surface: XrSurface | null;
  /** The `XRFrame` of the frame callback running now; null between frames or off-session. */
  readonly frame: XRFrame | null;
}

/** `ctx.xr`. */
export interface KitXrFields {
  readonly xr: XrControl;
}

/** Entering and leaving VR, as `ctx.xr`. Nothing runs until `enter()`. */
export function createKitXr(deps: KitXrDeps): KitXr {
  const { gpu, renderer, host, loop, pointers } = deps;
  // While a session runs: its host (frames and the current `XRFrame`) and its surface (eyes).
  let xrHost: XrHost | null = null;
  let xrSurface: XrSurface | null = null;
  let xrSession: XRSession | null = null;
  let xrEntering: Promise<void> | null = null;
  // Restores the page host, pointers and surface; set while a session runs, idempotent.
  let leaveXr: (() => void) | null = null;
  const xr: XrControl = {
    get active() {
      return xrSession !== null;
    },
    get session() {
      return xrSession;
    },
    get surface() {
      return xrSurface;
    },
    async supported() {
      const sys = (globalThis.navigator as XrNavigator | undefined)?.xr;
      if (!sys || !XrSurface.supported()) return false;
      try {
        return await sys.isSessionSupported('immersive-vr');
      } catch {
        return false;
      }
    },
    enter() {
      if (xrSession) return Promise.resolve();
      if (xrEntering) return xrEntering;
      const sys = (globalThis.navigator as XrNavigator | undefined)?.xr;
      if (!sys || !XrSurface.supported()) {
        return Promise.reject(new Error('WebXR with the WebGPU binding is not available here'));
      }
      const refType = deps.referenceSpace ?? 'local-floor';
      xrEntering = (async () => {
        const session = await sys.requestSession('immersive-vr', {
          requiredFeatures: ['webgpu', refType],
          optionalFeatures: ['hand-tracking'],
        });
        let referenceSpace: XRReferenceSpace;
        try {
          referenceSpace = await session.requestReferenceSpace(refType);
        } catch (err) {
          await session.end().catch(() => {});
          throw err;
        }
        const surface = new XrSurface(session, gpu.device, {
          referenceSpace,
          scene: true,
          colorFormat: renderer.format,
          aux: deps.aux,
        });
        const sessionHost = createXrHost(session, host);
        const removeSource = pointers
          ? pointers.addSource(
              new XrPointerSource(session, referenceSpace, () => sessionHost.frame),
            )
          : null;
        const onEnd = () => leaveXr?.();
        leaveXr = () => {
          leaveXr = null;
          session.removeEventListener('end', onEnd);
          removeSource?.();
          loop.setFrames(host);
          xrHost = null;
          xrSurface = null;
          xrSession = null;
          surface.destroy();
          deps.onExit?.();
        };
        session.addEventListener('end', onEnd);
        xrSession = session;
        xrSurface = surface;
        xrHost = sessionHost;
        loop.setFrames(sessionHost);
        deps.onEnter?.(session);
      })().finally(() => {
        xrEntering = null;
      });
      return xrEntering;
    },
    async exit() {
      const session = xrSession;
      if (!session) return;
      try {
        await session.end();
      } finally {
        // The `end` event normally restored everything; a session ending without it does here.
        leaveXr?.();
      }
    },
  };
  return {
    fields: { xr },
    get surface() {
      return xrSurface;
    },
    get frame() {
      return xrHost?.frame ?? null;
    },
  };
}

/**
 * The XR service: `ctx.xr`. While a session runs the loop records the scenes once through the
 * head and renders each eye. Needs the loop's frames from the host (not `frames: 'external'`).
 */
export function withXr(opts: XrOptions = {}): KitService<KitXrFields, KitXr> {
  return {
    setup(core) {
      return createKitXr({
        ...opts,
        gpu: core.gpu,
        renderer: core.renderer,
        host: core.host,
        loop: core.loop,
        pointers: core.pointers,
        aux: core.aux,
      });
    },
  };
}
