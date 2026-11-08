/**
 * XR controllers and hands as pointers (ws/xr; ARCHITECTURE "Input"). `XrPointerSource` is a
 * `PointerSource` the router polls like any other: each `XRInputSource` of the session becomes
 * one `PointerSample` whose ray is the source's target ray in the reference space (`x`, `y`
 * NaN: there is no screen), with `xr.trigger` and `xr.squeeze` from the `xr-standard` gamepad
 * (buttons 0 and 1) or, without a gamepad, from the session's select and squeeze events, and
 * `xr.pinch` from the hand's index-finger tip and thumb tip when the Hand Input module reports
 * joints. `select = trigger || pinch`, `secondary = squeeze`, `hand` is the handedness. Nothing in
 * the router changes; `{ xr: 'trigger' | 'squeeze' | 'pinch', hand? }` bindings read these.
 *
 * Poses are only readable inside an `XRFrame`, so the source takes a getter for the frame that is
 * running (`() => xrHost.frame`); polled outside one it reports no pointers.
 */
import type {
  XRFrame,
  XRInputSource,
  XRInputSourceEvent,
  XRInputSourcesChangeEvent,
  XRPose,
  XRReferenceSpace,
  XRSession,
} from '../platform/xr-types';
import { createSample, type PointerSample, type PointerSource } from './pointer-sources';
import type { RayCamera } from './rays';

export interface XrPointerSourceOptions {
  /** Index tip to thumb tip distance (metres) at or under which a pinch starts. Default 0.02. */
  pinchStart?: number;
  /** Distance over which a pinch ends (hysteresis). Default 0.035. */
  pinchEnd?: number;
}

interface Pressed {
  select: boolean;
  squeeze: boolean;
}

/** Position of a joint pose's transform; the pose's `position` is read, not its matrix. */
function dist(a: XRPose, b: XRPose): number {
  const p = a.transform.position;
  const q = b.transform.position;
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

export class XrPointerSource implements PointerSource {
  private readonly samples = new Map<XRInputSource, PointerSample>();
  private readonly pressed = new Map<XRInputSource, Pressed>();
  private readonly pinching = new Map<XRInputSource, boolean>();
  private readonly out: PointerSample[] = [];
  private readonly pinchStart: number;
  private readonly pinchEnd: number;
  private nextKey = 0;
  private listening = false;

  constructor(
    readonly session: XRSession,
    readonly referenceSpace: XRReferenceSpace,
    /** The `XRFrame` running now, or null between frames (`() => xrHost.frame`). */
    private readonly frame: () => XRFrame | null,
    opts: XrPointerSourceOptions = {},
  ) {
    this.pinchStart = opts.pinchStart ?? 0.02;
    this.pinchEnd = opts.pinchEnd ?? 0.035;
    this.attach();
  }

  /** Listens to the session's select and squeeze events (the router calls this; idempotent). */
  attach(): void {
    if (this.listening) return;
    this.listening = true;
    const s = this.session;
    s.addEventListener('selectstart', this.onSelectStart);
    s.addEventListener('selectend', this.onSelectEnd);
    s.addEventListener('squeezestart', this.onSqueezeStart);
    s.addEventListener('squeezeend', this.onSqueezeEnd);
    s.addEventListener('inputsourceschange', this.onSourcesChange);
  }

  /** Stops listening and forgets every pointer. */
  detach(): void {
    if (!this.listening) return;
    this.listening = false;
    const s = this.session;
    s.removeEventListener('selectstart', this.onSelectStart);
    s.removeEventListener('selectend', this.onSelectEnd);
    s.removeEventListener('squeezestart', this.onSqueezeStart);
    s.removeEventListener('squeezeend', this.onSqueezeEnd);
    s.removeEventListener('inputsourceschange', this.onSourcesChange);
    this.samples.clear();
    this.pressed.clear();
    this.pinching.clear();
  }

  poll(_camera: RayCamera | null): readonly PointerSample[] {
    const out = this.out;
    out.length = 0;
    const frame = this.frame();
    if (!frame) return out;
    const sources = this.session.inputSources;
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]!;
      const pose = frame.getPose(src.targetRaySpace, this.referenceSpace);
      if (!pose) continue;
      let s = this.samples.get(src);
      if (!s) {
        s = createSample(this.nextKey++, 'xr');
        s.xr = { trigger: false, squeeze: false, pinch: false };
        this.samples.set(src, s);
      }
      s.hand = src.handedness === 'left' || src.handedness === 'right' ? src.handedness : null;
      const m = pose.transform.matrix;
      const ray = s.ray;
      ray.origin[0] = m[12]!;
      ray.origin[1] = m[13]!;
      ray.origin[2] = m[14]!;
      // The target ray points down the space's -z: the negated third column, normalised.
      const dx = -m[8]!;
      const dy = -m[9]!;
      const dz = -m[10]!;
      const len = Math.hypot(dx, dy, dz) || 1;
      ray.dir[0] = dx / len;
      ray.dir[1] = dy / len;
      ray.dir[2] = dz / len;
      const gp = src.gamepad;
      const ev = this.pressed.get(src);
      const b = s.xr!;
      b.trigger = (gp?.buttons[0]?.pressed ?? false) || (ev?.select ?? false);
      b.squeeze = (gp?.buttons[1]?.pressed ?? false) || (ev?.squeeze ?? false);
      b.pinch = this.pinch(frame, src);
      s.select = b.trigger || b.pinch;
      s.secondary = b.squeeze;
      out.push(s);
    }
    return out;
  }

  /** Index tip to thumb tip under `pinchStart` starts a pinch; over `pinchEnd` ends it. */
  private pinch(frame: XRFrame, src: XRInputSource): boolean {
    const hand = src.hand;
    const getJointPose = frame.getJointPose;
    if (!hand || !getJointPose) return false;
    const index = hand.get('index-finger-tip');
    const thumb = hand.get('thumb-tip');
    if (!index || !thumb) return false;
    const a = getJointPose.call(frame, index, this.referenceSpace);
    const b = getJointPose.call(frame, thumb, this.referenceSpace);
    if (!a || !b) return false;
    const d = dist(a, b);
    const was = this.pinching.get(src) ?? false;
    const now = was ? d <= this.pinchEnd : d <= this.pinchStart;
    if (now !== was) this.pinching.set(src, now);
    return now;
  }

  private state(src: XRInputSource): Pressed {
    let p = this.pressed.get(src);
    if (!p) {
      p = { select: false, squeeze: false };
      this.pressed.set(src, p);
    }
    return p;
  }

  private readonly onSelectStart = (e: XRInputSourceEvent): void => {
    this.state(e.inputSource).select = true;
  };
  private readonly onSelectEnd = (e: XRInputSourceEvent): void => {
    this.state(e.inputSource).select = false;
  };
  private readonly onSqueezeStart = (e: XRInputSourceEvent): void => {
    this.state(e.inputSource).squeeze = true;
  };
  private readonly onSqueezeEnd = (e: XRInputSourceEvent): void => {
    this.state(e.inputSource).squeeze = false;
  };
  /** A removed source's pointer ends (its key stops appearing) and its state is dropped. */
  private readonly onSourcesChange = (e: XRInputSourcesChangeEvent): void => {
    for (const src of e.removed) {
      this.samples.delete(src);
      this.pressed.delete(src);
      this.pinching.delete(src);
    }
  };
}
