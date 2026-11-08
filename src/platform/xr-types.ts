/**
 * The engine's own types for the parts of the WebXR Device API, the WebXR Hand Input module and
 * the WebXR/WebGPU binding it uses (ws/xr, E-039). TypeScript's DOM lib has none of them and the
 * engine takes no `@types/webxr` dependency. They are module exports, never globals, so a game
 * can install `@types/webxr` (or get WebXR from a future lib.dom) beside the engine without a
 * clash. Each one is a structural subset of `@types/webxr`'s type of the same name, so a real
 * `XRSession`, `XRFrame` or `XRReferenceSpace` typed by `@types/webxr` passes to every engine
 * signature. Everything here is optional at runtime: callers read `navigator.xr` and
 * `XRGPUBinding` through typed casts of `globalThis` (`XrNavigator`, `XrGlobals`) and check them
 * before touching them, so the engine typechecks and runs where WebXR is missing (every row of
 * the e2e matrix). Not re-exported from a barrel: public signatures name these types and the
 * emitted declarations import them from here.
 */

export type XRSessionMode = 'inline' | 'immersive-vr' | 'immersive-ar';
export type XRReferenceSpaceType =
  | 'viewer'
  | 'local'
  | 'local-floor'
  | 'bounded-floor'
  | 'unbounded';
export type XREye = 'none' | 'left' | 'right';
export type XRHandedness = 'none' | 'left' | 'right';
export type XRTargetRayMode = 'gaze' | 'tracked-pointer' | 'screen' | 'transient-pointer';
export type XRHandJoint =
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

export interface XRSessionInit {
  requiredFeatures?: string[];
  optionalFeatures?: string[];
}

export interface XRSystem {
  isSessionSupported(mode: XRSessionMode): Promise<boolean>;
  requestSession(mode: XRSessionMode, init?: XRSessionInit): Promise<XRSession>;
}

/** `navigator`, read through a cast (`globalThis.navigator as XrNavigator`): never an augmentation. */
export interface XrNavigator {
  /** The WebXR entry point; undefined where the browser has no WebXR. */
  readonly xr?: XRSystem;
}

export interface XRRigidTransform {
  readonly position: DOMPointReadOnly;
  readonly orientation: DOMPointReadOnly;
  /** Column-major 4×4, the same layout as `mat4`. */
  readonly matrix: Float32Array;
  readonly inverse: XRRigidTransform;
}

// biome-ignore lint/suspicious/noEmptyInterface: an opaque handle
export interface XRSpace {}

export interface XRReferenceSpace extends XRSpace {
  getOffsetReferenceSpace(originOffset: XRRigidTransform): XRReferenceSpace;
}

export interface XRJointSpace extends XRSpace {
  readonly jointName: XRHandJoint;
}

export interface XRHand {
  readonly size: number;
  get(joint: XRHandJoint): XRJointSpace | undefined;
}

export interface XRPose {
  readonly transform: XRRigidTransform;
  readonly emulatedPosition: boolean;
}

export interface XRJointPose extends XRPose {
  /** Joint radius in metres. */
  readonly radius: number | undefined;
}

export interface XRViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface XRView {
  readonly eye: XREye;
  /** Column-major 4×4 projection for this eye. */
  readonly projectionMatrix: Float32Array;
  /** The eye's pose in the reference space; `transform.inverse.matrix` is the view matrix. */
  readonly transform: XRRigidTransform;
  readonly recommendedViewportScale?: number | null;
  requestViewportScale?(scale: number | null): void;
}

export interface XRViewerPose extends XRPose {
  readonly views: readonly XRView[];
}

export interface XRInputSource {
  readonly handedness: XRHandedness;
  readonly targetRayMode: XRTargetRayMode;
  readonly targetRaySpace: XRSpace;
  readonly gripSpace?: XRSpace | null;
  /** `xr-standard` mapping: `buttons[0]` is the trigger, `buttons[1]` the squeeze. */
  readonly gamepad?: Gamepad | null;
  readonly hand?: XRHand | null;
  readonly profiles: readonly string[];
}

export interface XRInputSourceArray {
  readonly length: number;
  [index: number]: XRInputSource;
  [Symbol.iterator](): IterableIterator<XRInputSource>;
}

export interface XRFrame {
  readonly session: XRSession;
  readonly predictedDisplayTime: number;
  getViewerPose(referenceSpace: XRReferenceSpace): XRViewerPose | undefined;
  getPose(space: XRSpace, baseSpace: XRSpace): XRPose | undefined;
  /** Hand Input module; missing where hands are not supported. */
  getJointPose?(joint: XRJointSpace, baseSpace: XRSpace): XRJointPose | undefined;
}

export type XRFrameRequestCallback = (time: DOMHighResTimeStamp, frame: XRFrame) => void;

export interface XRRenderStateInit {
  depthNear?: number;
  depthFar?: number;
  layers?: XRLayer[];
}

export interface XRRenderState {
  readonly depthNear: number;
  readonly depthFar: number;
  readonly layers?: readonly XRLayer[];
}

export interface XRSessionEvent extends Event {
  readonly session: XRSession;
}

export interface XRInputSourceEvent extends Event {
  readonly frame: XRFrame;
  readonly inputSource: XRInputSource;
}

export interface XRInputSourcesChangeEvent extends Event {
  readonly session: XRSession;
  readonly added: readonly XRInputSource[];
  readonly removed: readonly XRInputSource[];
}

export interface XRSessionEventMap {
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

export interface XRSession extends EventTarget {
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
export interface XRLayer {}

export interface XRCompositionLayer extends XRLayer {
  readonly layout: 'default' | 'mono' | 'stereo' | 'stereo-left-right' | 'stereo-top-bottom';
  readonly mipLevels: number;
  needsRedraw: boolean;
  destroy(): void;
}

export interface XRProjectionLayer extends XRCompositionLayer {
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly textureArrayLength: number;
  readonly ignoreDepthValues: boolean;
  fixedFoveation?: number | null;
}

export interface XRGPUProjectionLayerInit {
  colorFormat?: GPUTextureFormat;
  depthStencilFormat?: GPUTextureFormat;
  /** `texture` (default): one texture, eyes side by side; `texture-array`: one layer per eye. */
  textureType?: 'texture' | 'texture-array';
  textureUsage?: GPUTextureUsageFlags;
  scaleFactor?: number;
}

export interface XRGPUSubImage {
  readonly colorTexture: GPUTexture;
  readonly depthStencilTexture?: GPUTexture | null;
  /** The part of `colorTexture` this view draws into, in texture pixels, origin top-left. */
  readonly viewport: XRViewport;
  /** The texture view to make (array layer, mip) for this view. */
  getViewDescriptor(): GPUTextureViewDescriptor;
}

export interface XRGPUBinding {
  readonly nativeProjectionScaleFactor: number;
  createProjectionLayer(init?: XRGPUProjectionLayerInit): XRProjectionLayer;
  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRGPUSubImage;
  getPreferredColorFormat(): GPUTextureFormat;
}

export interface XRGPUBindingConstructor {
  readonly prototype: XRGPUBinding;
  new (session: XRSession, device: GPUDevice): XRGPUBinding;
}

/** `globalThis`, read through a cast (`globalThis as XrGlobals`): never a `var` declaration. */
export interface XrGlobals {
  /** The WebXR/WebGPU binding; undefined where the browser does not have it. */
  readonly XRGPUBinding?: XRGPUBindingConstructor;
}
