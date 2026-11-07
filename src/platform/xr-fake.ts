/// <reference path="./xr-types.d.ts" preserve="true" />
/**
 * A fake WebXR stack for unit tests (ws/xr): `XRSystem`, `XRSession`, `XRFrame`, input sources
 * and the WebXR/WebGPU binding, stepped by hand. `installFakeXr(device)` puts a `navigator.xr`
 * and a `globalThis.XRGPUBinding` in place over a fake GPU device (`createFakeDevice`), so
 * `createGame`'s `ctx.xr.enter()`, `XrSurface` and `XrPointerSource` run end to end in Node;
 * the returned `uninstall` restores the globals. Not exported from any module index.
 *
 * Geometry: two eyes at ±`ipd / 2` on x, looking down -z with a 90° projection, side by side in
 * one `textureType: 'texture'` layer texture (`2 * eyeWidth × eyeHeight`); a `texture-array`
 * layer gives each eye its own array layer. Input sources carry a position and point down -z.
 */

export interface FakeXrOptions {
  /** Per-eye texture size. Default 64 × 32. */
  eyeWidth?: number;
  eyeHeight?: number;
  /** Interpupillary distance (metres). Default 0.064. */
  ipd?: number;
  /** What `isSessionSupported('immersive-vr')` answers. Default true. */
  supported?: boolean;
  /** A new layer texture every frame (a real compositor rotates them). Default false. */
  rotateTextures?: boolean;
  /**
   * With `rotateTextures`, cycle through this many textures instead of making a new one every
   * frame, as a real compositor's swapchain does (ws/xr-fixes). Default 0: always new.
   */
  textureRing?: number;
  /**
   * Off-axis eye frusta as tangents, the way headsets have them (ws/xr-fixes): `outer` toward
   * the eye's own side (left for the left eye), `inner` toward the nose, `up`, `down`, all
   * positive. Default none: both eyes get the same symmetric 90° projection.
   */
  fov?: { outer: number; inner: number; up: number; down: number } | null;
}

function translation(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** A rigid transform that is a pure translation, with its inverse. */
export function fakeTransform(x: number, y: number, z: number): XRRigidTransform {
  const make = (sx: number, sy: number, sz: number, inv: () => XRRigidTransform) => ({
    position: { x: sx, y: sy, z: sz, w: 1 } as DOMPointReadOnly,
    orientation: { x: 0, y: 0, z: 0, w: 1 } as DOMPointReadOnly,
    matrix: translation(sx, sy, sz),
    get inverse() {
      return inv();
    },
  });
  const a: XRRigidTransform = make(x, y, z, () => b);
  const b: XRRigidTransform = make(-x, -y, -z, () => a);
  return a;
}

function perspective90(aspect: number): Float32Array {
  const near = 0.1;
  const far = 100;
  const m = new Float32Array(16);
  m[0] = 1 / aspect;
  m[5] = 1;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

/** An off-axis projection from tangents (left < 0 < right, bottom < 0 < top), depth 0..1. */
function offAxis(l: number, r: number, b: number, t: number): Float32Array {
  const m = perspective90(1);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[8] = (r + l) / (r - l);
  m[9] = (t + b) / (t - b);
  return m;
}

export class FakeXrSpace implements XRSpace {
  constructor(readonly name: string) {}
}

export class FakeXrReferenceSpace extends FakeXrSpace implements XRReferenceSpace {
  getOffsetReferenceSpace(): XRReferenceSpace {
    return this;
  }
}

export class FakeXrJointSpace extends FakeXrSpace implements XRJointSpace {
  constructor(readonly jointName: XRHandJoint) {
    super(jointName);
  }
}

/** A hand whose joint positions a test sets (`joints.set('thumb-tip', [x, y, z])`). */
export class FakeXrHand implements XRHand {
  readonly joints = new Map<XRHandJoint, [number, number, number]>();
  private readonly spaces = new Map<XRHandJoint, FakeXrJointSpace>();
  get size(): number {
    return this.spaces.size;
  }
  get(joint: XRHandJoint): XRJointSpace | undefined {
    let s = this.spaces.get(joint);
    if (!s) {
      s = new FakeXrJointSpace(joint);
      this.spaces.set(joint, s);
    }
    return s;
  }
}

export class FakeXrInputSource implements XRInputSource {
  readonly targetRayMode: XRTargetRayMode = 'tracked-pointer';
  readonly targetRaySpace: FakeXrSpace;
  readonly gripSpace: XRSpace | null = null;
  readonly profiles: readonly string[] = ['generic-trigger-squeeze'];
  /** Where the target ray starts, in the reference space; it points down -z. */
  position: [number, number, number] = [0, 1, 0];
  /** `buttons[0]` trigger, `buttons[1]` squeeze. */
  readonly buttons: { pressed: boolean; touched: boolean; value: number }[] = [
    { pressed: false, touched: false, value: 0 },
    { pressed: false, touched: false, value: 0 },
  ];
  /** Null for a source without a gamepad (events only). */
  gamepad: Gamepad | null;
  hand: FakeXrHand | null = null;

  constructor(
    readonly handedness: XRHandedness,
    opts: { gamepad?: boolean; hand?: boolean } = {},
  ) {
    this.targetRaySpace = new FakeXrSpace(`${handedness}-ray`);
    this.gamepad =
      opts.gamepad === false ? null : ({ buttons: this.buttons, axes: [] } as unknown as Gamepad);
    if (opts.hand) this.hand = new FakeXrHand();
  }
}

export class FakeXrFrame implements XRFrame {
  constructor(
    readonly session: FakeXrSession,
    readonly predictedDisplayTime: number,
  ) {}

  getViewerPose(referenceSpace: XRReferenceSpace): XRViewerPose | undefined {
    if (!this.session.tracking) return undefined;
    if (referenceSpace !== this.session.referenceSpace) return undefined;
    const s = this.session;
    const [hx, hy, hz] = s.headPosition;
    const half = s.opts.ipd / 2;
    const fov = s.opts.fov;
    const proj = perspective90(s.opts.eyeWidth / s.opts.eyeHeight);
    const view = (eye: XREye, dx: number): XRView => ({
      eye,
      projectionMatrix: !fov
        ? proj
        : eye === 'left'
          ? offAxis(-fov.outer, fov.inner, -fov.down, fov.up)
          : offAxis(-fov.inner, fov.outer, -fov.down, fov.up),
      transform: fakeTransform(hx + dx, hy, hz),
    });
    return {
      transform: fakeTransform(hx, hy, hz),
      emulatedPosition: false,
      views: [view('left', -half), view('right', half)],
    };
  }

  getPose(space: XRSpace, baseSpace: XRSpace): XRPose | undefined {
    if (baseSpace !== this.session.referenceSpace) return undefined;
    for (const src of this.session.inputSources) {
      if (src.targetRaySpace === space) {
        const [x, y, z] = src.position;
        return { transform: fakeTransform(x, y, z), emulatedPosition: false };
      }
    }
    return undefined;
  }

  getJointPose(joint: XRJointSpace, baseSpace: XRSpace): XRJointPose | undefined {
    if (baseSpace !== this.session.referenceSpace) return undefined;
    for (const src of this.session.inputSources) {
      const p = src.hand?.joints.get(joint.jointName);
      if (src.hand?.get(joint.jointName) === joint && p) {
        return {
          transform: fakeTransform(p[0], p[1], p[2]),
          emulatedPosition: false,
          radius: 0.01,
        };
      }
    }
    return undefined;
  }
}

class FakeInputSourceEvent extends Event implements XRInputSourceEvent {
  constructor(
    type: string,
    readonly frame: XRFrame,
    readonly inputSource: XRInputSource,
  ) {
    super(type);
  }
}

class FakeSourcesChangeEvent extends Event implements XRInputSourcesChangeEvent {
  constructor(
    readonly session: XRSession,
    readonly added: readonly XRInputSource[],
    readonly removed: readonly XRInputSource[],
  ) {
    super('inputsourceschange');
  }
}

export class FakeXrSession extends EventTarget implements XRSession {
  readonly inputSources: FakeXrInputSource[] = [];
  readonly referenceSpace = new FakeXrReferenceSpace('reference');
  renderState: XRRenderState = { depthNear: 0.1, depthFar: 1000, layers: [] };
  visibilityState: 'visible' | 'visible-blurred' | 'hidden' = 'visible';
  headPosition: [number, number, number] = [0, 1.6, 0];
  /** False makes `getViewerPose` return nothing (tracking lost). */
  tracking = true;
  ended = false;
  /** Every `requestReferenceSpace` type asked for. */
  readonly referenceSpaceRequests: XRReferenceSpaceType[] = [];
  readonly renderStateUpdates: XRRenderStateInit[] = [];
  private readonly pending = new Map<number, XRFrameRequestCallback>();
  private nextHandle = 1;
  private frameTime = 0;

  constructor(
    readonly mode: XRSessionMode,
    readonly init: XRSessionInit | undefined,
    readonly opts: Required<FakeXrOptions>,
  ) {
    super();
  }

  /** The clock of the frame running now (the last `step`), ms. */
  get now(): number {
    return this.frameTime;
  }

  /** Callbacks waiting for the next frame. */
  get pendingFrames(): number {
    return this.pending.size;
  }

  requestReferenceSpace(type: XRReferenceSpaceType): Promise<XRReferenceSpace> {
    this.referenceSpaceRequests.push(type);
    return Promise.resolve(this.referenceSpace);
  }

  updateRenderState(state: XRRenderStateInit = {}): void {
    this.renderStateUpdates.push(state);
    this.renderState = { ...this.renderState, ...state };
  }

  requestAnimationFrame(callback: XRFrameRequestCallback): number {
    const h = this.nextHandle++;
    this.pending.set(h, callback);
    return h;
  }

  cancelAnimationFrame(handle: number): void {
    this.pending.delete(handle);
  }

  /** Run the pending frame callbacks with a new `XRFrame`, `dtMs` after the last one. */
  step(dtMs = 1000 / 72): FakeXrFrame {
    this.frameTime += dtMs;
    const frame = new FakeXrFrame(this, this.frameTime);
    const cbs = [...this.pending.values()];
    this.pending.clear();
    for (const cb of cbs) cb(this.frameTime, frame);
    return frame;
  }

  /** Add an input source (fires `inputsourceschange`). */
  addInputSource(src: FakeXrInputSource): void {
    this.inputSources.push(src);
    this.dispatchEvent(new FakeSourcesChangeEvent(this, [src], []));
  }

  removeInputSource(src: FakeXrInputSource): void {
    const i = this.inputSources.indexOf(src);
    if (i < 0) return;
    this.inputSources.splice(i, 1);
    this.dispatchEvent(new FakeSourcesChangeEvent(this, [], [src]));
  }

  /** Fire `selectstart` / `selectend` (or `squeeze…`) for a source, as a headset would. */
  fire(kind: 'select' | 'squeeze', src: FakeXrInputSource, down: boolean): void {
    const frame = new FakeXrFrame(this, this.frameTime);
    this.dispatchEvent(new FakeInputSourceEvent(`${kind}${down ? 'start' : 'end'}`, frame, src));
    if (!down) this.dispatchEvent(new FakeInputSourceEvent(kind, frame, src));
  }

  end(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.pending.clear();
      const ev = new Event('end') as Event & { session: XRSession };
      ev.session = this;
      this.dispatchEvent(ev);
    }
    return Promise.resolve();
  }
}

export class FakeXrSystem implements XRSystem {
  readonly sessions: FakeXrSession[] = [];
  constructor(readonly opts: Required<FakeXrOptions>) {}

  isSessionSupported(mode: XRSessionMode): Promise<boolean> {
    return Promise.resolve(this.opts.supported && mode === 'immersive-vr');
  }

  requestSession(mode: XRSessionMode, init?: XRSessionInit): Promise<XRSession> {
    if (!this.opts.supported) return Promise.reject(new Error('NotSupportedError'));
    const s = new FakeXrSession(mode, init, this.opts);
    this.sessions.push(s);
    return Promise.resolve(s);
  }

  /** The session requested last. */
  get session(): FakeXrSession {
    const s = this.sessions.at(-1);
    if (!s) throw new Error('no session requested');
    return s;
  }
}

export class FakeXrProjectionLayer implements XRProjectionLayer {
  readonly layout = 'stereo' as const;
  readonly mipLevels = 1;
  needsRedraw = false;
  readonly ignoreDepthValues = false;
  fixedFoveation: number | null = null;
  destroyed = false;
  /** Textures handed out so far (one per frame when rotating). */
  readonly colorTextures: GPUTexture[] = [];
  readonly depthTextures: GPUTexture[] = [];
  private color: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private lastFrameTime = -1;
  private ringIndex = -1;

  constructor(
    readonly binding: FakeXRGPUBinding,
    readonly init: XRGPUProjectionLayerInit,
  ) {}

  get textureType(): 'texture' | 'texture-array' {
    return this.init.textureType ?? 'texture';
  }
  get textureWidth(): number {
    const w = this.binding.session.opts.eyeWidth;
    return this.textureType === 'texture' ? 2 * w : w;
  }
  get textureHeight(): number {
    return this.binding.session.opts.eyeHeight;
  }
  get textureArrayLength(): number {
    return this.textureType === 'texture' ? 1 : 2;
  }

  /** This frame's textures, made on first use and, when rotating, anew each frame. */
  textures(frameTime: number): { color: GPUTexture; depth: GPUTexture | null } {
    const rotate = this.binding.session.opts.rotateTextures && frameTime !== this.lastFrameTime;
    this.lastFrameTime = frameTime;
    const ring = this.binding.session.opts.textureRing;
    if (rotate && ring > 0 && this.colorTextures.length >= ring) {
      this.ringIndex = (this.ringIndex + 1) % ring;
      this.color = this.colorTextures[this.ringIndex]!;
      this.depth = this.depthTextures[this.ringIndex] ?? null;
      return { color: this.color, depth: this.depth };
    }
    if (!this.color || rotate) {
      const size = [this.textureWidth, this.textureHeight, this.textureArrayLength];
      const device = this.binding.device;
      this.color = device.createTexture({
        label: 'xr-layer-color',
        size,
        format: this.init.colorFormat ?? 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.colorTextures.push(this.color);
      this.depth = this.init.depthStencilFormat
        ? device.createTexture({
            label: 'xr-layer-depth',
            size,
            format: this.init.depthStencilFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          })
        : null;
      if (this.depth) this.depthTextures.push(this.depth);
    }
    return { color: this.color, depth: this.depth };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export class FakeXRGPUBinding implements XRGPUBinding {
  readonly nativeProjectionScaleFactor = 1;
  readonly layers: FakeXrProjectionLayer[] = [];

  constructor(
    readonly session: FakeXrSession,
    readonly device: GPUDevice,
  ) {}

  createProjectionLayer(init: XRGPUProjectionLayerInit = {}): XRProjectionLayer {
    const l = new FakeXrProjectionLayer(this, init);
    this.layers.push(l);
    return l;
  }

  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRGPUSubImage {
    const l = layer as FakeXrProjectionLayer;
    const { color, depth } = l.textures(this.session.now);
    const w = this.session.opts.eyeWidth;
    const h = this.session.opts.eyeHeight;
    const right = view.eye === 'right';
    const array = l.textureType === 'texture-array';
    return {
      colorTexture: color,
      depthStencilTexture: depth,
      viewport: { x: right && !array ? w : 0, y: 0, width: w, height: h },
      getViewDescriptor: () =>
        array ? { dimension: '2d', baseArrayLayer: right ? 1 : 0, arrayLayerCount: 1 } : {},
    };
  }

  getPreferredColorFormat(): GPUTextureFormat {
    return 'rgba8unorm';
  }
}

export interface FakeXr {
  readonly system: FakeXrSystem;
  /** Every binding `new XRGPUBinding(session, device)` made. */
  readonly bindings: FakeXRGPUBinding[];
  /** Advance the session's frame clock and run its pending frame callbacks. */
  step(dtMs?: number): FakeXrFrame;
  uninstall(): void;
}

/**
 * Install `navigator.xr` and `XRGPUBinding` fakes. `supported: false` keeps `navigator.xr` but
 * answers no to `immersive-vr`; to test a browser with no WebXR at all, install nothing.
 */
export function installFakeXr(opts: FakeXrOptions = {}): FakeXr {
  const full: Required<FakeXrOptions> = {
    eyeWidth: opts.eyeWidth ?? 64,
    eyeHeight: opts.eyeHeight ?? 32,
    ipd: opts.ipd ?? 0.064,
    supported: opts.supported ?? true,
    rotateTextures: opts.rotateTextures ?? false,
    textureRing: opts.textureRing ?? 0,
    fov: opts.fov ?? null,
  };
  const system = new FakeXrSystem(full);
  const bindings: FakeXRGPUBinding[] = [];
  const Binding = function (this: unknown, session: XRSession, device: GPUDevice) {
    const b = new FakeXRGPUBinding(session as FakeXrSession, device);
    bindings.push(b);
    return b;
  } as unknown as XRGPUBindingConstructor;

  const g = globalThis as { navigator?: Navigator; XRGPUBinding?: unknown };
  const hadBinding = Object.getOwnPropertyDescriptor(g, 'XRGPUBinding');
  Object.defineProperty(g, 'XRGPUBinding', { value: Binding, configurable: true, writable: true });
  let nav = g.navigator;
  let madeNavigator = false;
  if (!nav) {
    nav = {} as Navigator;
    Object.defineProperty(g, 'navigator', { value: nav, configurable: true, writable: true });
    madeNavigator = true;
  }
  const hadXr = Object.getOwnPropertyDescriptor(nav, 'xr');
  Object.defineProperty(nav, 'xr', { value: system, configurable: true });

  return {
    system,
    bindings,
    step: (dtMs) => system.session.step(dtMs),
    uninstall() {
      if (hadBinding) Object.defineProperty(g, 'XRGPUBinding', hadBinding);
      else delete g.XRGPUBinding;
      if (madeNavigator) delete g.navigator;
      else if (hadXr) Object.defineProperty(nav as object, 'xr', hadXr);
      else delete (nav as { xr?: unknown }).xr;
    },
  };
}
