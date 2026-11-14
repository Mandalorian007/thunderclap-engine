/**
 * A headset on the page (ws/xr-merge): the fake WebXR stack (`installFakeXr`) on a real GPU
 * device, its session stepped by the browser's animation frames, and the layer's two eyes copied
 * side by side onto a canvas so a page (and an e2e spec) can see what a headset would. A game
 * enters VR as it would on a headset (`ctx.xr.enter()`); nothing in the game changes.
 *
 * For tests and harness pages only (`@thunderclap-engine/engine/testing`). The mirror copies the
 * layer's colour texture, so the layer is made with `COPY_SRC` and the canvas is configured in
 * the layer's format with `COPY_DST`.
 */
import { type FakeXr, type FakeXrOptions, type FakeXrSession, installFakeXr } from './xr-fake';

/** GPUTextureUsage.COPY_SRC | RENDER_ATTACHMENT, spelled out so Node needs no GPU globals. */
const LAYER_USAGE = 0x01 | 0x10;
/** GPUTextureUsage.COPY_DST | RENDER_ATTACHMENT. */
const MIRROR_USAGE = 0x02 | 0x10;

export interface EmulateXrOptions extends Omit<FakeXrOptions, 'textureUsage'> {
  /** A canvas to mirror both eyes onto (sized to the layer). Default none. */
  mirror?: HTMLCanvasElement | null;
  /** Where the head stands (metres). Default 0, 1.6, 0. */
  head?: [number, number, number];
}

export interface XrEmulator {
  readonly xr: FakeXr;
  /** The session the game requested, or null before `ctx.xr.enter()`. */
  readonly session: FakeXrSession | null;
  /** XR frames stepped so far. */
  readonly frames: number;
  /** Frames mirrored onto the canvas. */
  readonly mirrored: number;
  /** Stop stepping and remove the fake. */
  stop(): void;
}

/**
 * Install the fake XR stack and step its session on `requestAnimationFrame` (call it before
 * `createGame`, or at least before `ctx.xr.enter()`).
 */
export function emulateXr(opts: EmulateXrOptions = {}): XrEmulator {
  const { mirror = null, head, ...fake } = opts;
  const xr = installFakeXr({ ...fake, textureUsage: LAYER_USAGE });
  let frames = 0;
  let mirrored = 0;
  let last = -1;
  let raf = 0;
  let stopped = false;
  let mirrorCtx: GPUCanvasContext | null = null;
  let mirrorDevice: GPUDevice | null = null;

  const current = (): FakeXrSession | null => {
    const s = xr.system.sessions[xr.system.sessions.length - 1];
    return s && !s.ended ? s : null;
  };

  const copy = (): void => {
    if (!mirror) return;
    const binding = xr.bindings[xr.bindings.length - 1];
    const layer = binding?.layers[binding.layers.length - 1];
    const color = layer?.colorTextures[layer.colorTextures.length - 1];
    if (!binding || !layer || !color) return;
    const device = binding.device;
    if (!mirrorCtx || mirrorDevice !== device) {
      mirror.width = layer.textureWidth;
      mirror.height = layer.textureHeight;
      mirrorCtx = mirror.getContext('webgpu');
      if (!mirrorCtx) return;
      mirrorCtx.configure({
        device,
        format: color.format,
        usage: MIRROR_USAGE,
        alphaMode: 'opaque',
      });
      mirrorDevice = device;
    }
    const enc = device.createCommandEncoder({ label: 'xr-mirror' });
    enc.copyTextureToTexture({ texture: color }, { texture: mirrorCtx.getCurrentTexture() }, [
      layer.textureWidth,
      layer.textureHeight,
      1,
    ]);
    device.queue.submit([enc.finish()]);
    mirrored++;
  };

  const tick = (now: number): void => {
    if (stopped) return;
    const s = current();
    if (s && s.pendingFrames > 0) {
      if (head) s.headPosition = head;
      const dt = last < 0 ? 1000 / 72 : Math.min(100, Math.max(1, now - last));
      s.step(dt);
      frames++;
      copy();
    }
    last = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    xr,
    get session() {
      return current();
    },
    get frames() {
      return frames;
    },
    get mirrored() {
      return mirrored;
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      xr.uninstall();
    },
  };
}
