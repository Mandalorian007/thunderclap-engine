/**
 * Ambient declarations for the parts of the WebXR Device API, the WebXR Hand Input module and
 * the WebXR/WebGPU binding the engine uses (ws/xr). TypeScript's DOM lib has none of them and
 * the engine takes no `@types/webxr` dependency. Everything here is optional at runtime: callers
 * check `navigator.xr` and `XRGPUBinding` before touching them, so the engine typechecks and
 * runs where WebXR is missing (every row of the e2e matrix). Files that use these types
 * reference this file with `/// <reference path="…/xr-types.d.ts" />` so a program that enters
 * the engine through `harness/` (tsconfig.e2e.json) sees them too.
 */

type XRSessionMode = 'inline' | 'immersive-vr' | 'immersive-ar';
type XRReferenceSpaceType = 'viewer' | 'local' | 'local-floor' | 'bounded-floor' | 'unbounded';
type XREye = 'none' | 'left' | 'right';
type XRHandedness = 'none' | 'left' | 'right';
type XRTargetRayMode = 'gaze' | 'tracked-pointer' | 'screen' | 'transient-pointer';
type XRHandJoint =
  | 'wrist'
  | 'thumb-metacarpal'
  | 'thumb-phalanx-proximal'
  | 'thumb-phalanx-distal'
  | 'thumb-tip'
  | 'index-finger-metacarpal'
  | 'index-finger-phalanx-proximal'
  | 'index-finger-phalanx-intermediate'
  | 'index-finger-phalanx-distal'
  | 'index-finger-tip'
  | 'middle-finger-metacarpal'
  | 'middle-finger-phalanx-proximal'
  | 'middle-finger-phalanx-intermediate'
  | 'middle-finger-phalanx-distal'
  | 'middle-finger-tip'
  | 'ring-finger-metacarpal'
  | 'ring-finger-phalanx-proximal'
  | 'ring-finger-phalanx-intermediate'
  | 'ring-finger-phalanx-distal'
  | 'ring-finger-tip'
  | 'pinky-finger-metacarpal'
  | 'pinky-finger-phalanx-proximal'
  | 'pinky-finger-phalanx-intermediate'
  | 'pinky-finger-phalanx-distal'
  | 'pinky-finger-tip';

interface XRSessionInit {
  requiredFeatures?: string[];
  optionalFeatures?: string[];
}

interface XRSystem {
  isSessionSupported(mode: XRSessionMode): Promise<boolean>;
  requestSession(mode: XRSessionMode, init?: XRSessionInit): Promise<XRSession>;
}

interface Navigator {
  /** The WebXR entry point; undefined where the browser has no WebXR. */
  readonly xr?: XRSystem;
}

interface XRRigidTransform {
  readonly position: DOMPointReadOnly;
  readonly orientation: DOMPointReadOnly;
  /** Column-major 4×4, the same layout as `mat4`. */
  readonly matrix: Float32Array;
  readonly inverse: XRRigidTransform;
}

// biome-ignore lint/suspicious/noEmptyInterface: an opaque handle
interface XRSpace {}

interface XRReferenceSpace extends XRSpace {
  getOffsetReferenceSpace(originOffset: XRRigidTransform): XRReferenceSpace;
}

interface XRJointSpace extends XRSpace {
  readonly jointName: XRHandJoint;
}

interface XRHand {
  readonly size: number;
  get(joint: XRHandJoint): XRJointSpace | undefined;
}

interface XRPose {
  readonly transform: XRRigidTransform;
  readonly emulatedPosition: boolean;
}

interface XRJointPose extends XRPose {
  /** Joint radius in metres. */
  readonly radius: number | undefined;
}

interface XRViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface XRView {
  readonly eye: XREye;
  /** Column-major 4×4 projection for this eye. */
  readonly projectionMatrix: Float32Array;
  /** The eye's pose in the reference space; `transform.inverse.matrix` is the view matrix. */
  readonly transform: XRRigidTransform;
  readonly recommendedViewportScale?: number | null;
  requestViewportScale?(scale: number | null): void;
}

interface XRViewerPose extends XRPose {
  readonly views: readonly XRView[];
}

interface XRInputSource {
  readonly handedness: XRHandedness;
  readonly targetRayMode: XRTargetRayMode;
  readonly targetRaySpace: XRSpace;
  readonly gripSpace?: XRSpace | null;
  /** `xr-standard` mapping: `buttons[0]` is the trigger, `buttons[1]` the squeeze. */
  readonly gamepad?: Gamepad | null;
  readonly hand?: XRHand | null;
  readonly profiles: readonly string[];
}

interface XRInputSourceArray {
  readonly length: number;
  [index: number]: XRInputSource;
  [Symbol.iterator](): IterableIterator<XRInputSource>;
}

interface XRFrame {
  readonly session: XRSession;
  readonly predictedDisplayTime: number;
  getViewerPose(referenceSpace: XRReferenceSpace): XRViewerPose | undefined;
  getPose(space: XRSpace, baseSpace: XRSpace): XRPose | undefined;
  /** Hand Input module; missing where hands are not supported. */
  getJointPose?(joint: XRJointSpace, baseSpace: XRSpace): XRJointPose | undefined;
}

type XRFrameRequestCallback = (time: DOMHighResTimeStamp, frame: XRFrame) => void;

interface XRRenderStateInit {
  depthNear?: number;
  depthFar?: number;
  layers?: XRLayer[];
}

interface XRRenderState {
  readonly depthNear: number;
  readonly depthFar: number;
  readonly layers?: readonly XRLayer[];
}

interface XRSessionEvent extends Event {
  readonly session: XRSession;
}

interface XRInputSourceEvent extends Event {
  readonly frame: XRFrame;
  readonly inputSource: XRInputSource;
}

interface XRInputSourcesChangeEvent extends Event {
  readonly session: XRSession;
  readonly added: readonly XRInputSource[];
  readonly removed: readonly XRInputSource[];
}

interface XRSessionEventMap {
  end: XRSessionEvent;
  inputsourceschange: XRInputSourcesChangeEvent;
  select: XRInputSourceEvent;
  selectstart: XRInputSourceEvent;
  selectend: XRInputSourceEvent;
  squeeze: XRInputSourceEvent;
  squeezestart: XRInputSourceEvent;
  squeezeend: XRInputSourceEvent;
  visibilitychange: XRSessionEvent;
}

interface XRSession extends EventTarget {
  readonly inputSources: XRInputSourceArray;
  readonly renderState: XRRenderState;
  readonly visibilityState: 'visible' | 'visible-blurred' | 'hidden';
  requestReferenceSpace(type: XRReferenceSpaceType): Promise<XRReferenceSpace>;
  updateRenderState(state?: XRRenderStateInit): void;
  requestAnimationFrame(callback: XRFrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  end(): Promise<void>;
  addEventListener<K extends keyof XRSessionEventMap>(
    type: K,
    listener: (this: XRSession, ev: XRSessionEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof XRSessionEventMap>(
    type: K,
    listener: (this: XRSession, ev: XRSessionEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

// ── WebXR Layers + WebXR/WebGPU binding ───────────────────────────────────────

// biome-ignore lint/suspicious/noEmptyInterface: an opaque handle
interface XRLayer {}

interface XRCompositionLayer extends XRLayer {
  readonly layout: 'default' | 'mono' | 'stereo' | 'stereo-left-right' | 'stereo-top-bottom';
  readonly mipLevels: number;
  needsRedraw: boolean;
  destroy(): void;
}

interface XRProjectionLayer extends XRCompositionLayer {
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly textureArrayLength: number;
  readonly ignoreDepthValues: boolean;
  fixedFoveation?: number | null;
}

interface XRGPUProjectionLayerInit {
  colorFormat?: GPUTextureFormat;
  depthStencilFormat?: GPUTextureFormat;
  /** `texture` (default): one texture, eyes side by side; `texture-array`: one layer per eye. */
  textureType?: 'texture' | 'texture-array';
  textureUsage?: GPUTextureUsageFlags;
  scaleFactor?: number;
}

interface XRGPUSubImage {
  readonly colorTexture: GPUTexture;
  readonly depthStencilTexture?: GPUTexture | null;
  /** The part of `colorTexture` this view draws into, in texture pixels, origin top-left. */
  readonly viewport: XRViewport;
  /** The texture view to make (array layer, mip) for this view. */
  getViewDescriptor(): GPUTextureViewDescriptor;
}

interface XRGPUBinding {
  readonly nativeProjectionScaleFactor: number;
  createProjectionLayer(init?: XRGPUProjectionLayerInit): XRProjectionLayer;
  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRGPUSubImage;
  getPreferredColorFormat(): GPUTextureFormat;
}

interface XRGPUBindingConstructor {
  readonly prototype: XRGPUBinding;
  new (session: XRSession, device: GPUDevice): XRGPUBinding;
}

/** The WebXR/WebGPU binding; undefined where the browser does not have it. */
declare var XRGPUBinding: XRGPUBindingConstructor | undefined;
