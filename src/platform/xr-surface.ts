/// <reference path="./xr-types.d.ts" />
/**
 * The XR surface (ws/xr; ARCHITECTURE "Surface"): a `SceneTarget` per eye per frame. Built on
 * the WebXR/WebGPU binding, it makes one `XRProjectionLayer` for the session (colour in
 * `SCENE_FORMAT`, since every material's pipeline writes that format, plus a `DEPTH_FORMAT`
 * depth texture) and each frame turns the viewer pose into `XrEyeView`s: a `Camera` whose
 * projection and view matrices are the `XRView`'s (`viewIndex` = eye index, depth on) and a
 * `SceneTarget` adopting the eye's part of the layer (`SceneTarget.external`). Eyes that share
 * one layer texture (the default `texture` layout, side by side) share one target and differ by
 * `camera.screen`, so the renderer clears it once and scissors each eye to its viewport; a
 * `texture-array` layer gives each eye its own target over its array layer.
 *
 * Two ways to draw the eyes. Direct (the default): each eye is a scene pass into its layer
 * target; the colour goes to the layer as linear HDR, the emissive target is written and
 * dropped and no post stack runs. Through the post stack (`scene: true`, ws/xr-post, what
 * `createGame` uses): the surface keeps `scene`, one HDR `SceneTarget` the size of an eye
 * (allocated on the first frame, resized when the layer's eye size changes), every eye camera
 * covers it whole and the caller renders each eye into it and resolves it into the eye's layer
 * target at `eye.viewport` (`renderer.render(frame, eye.camera, surface.scene)` then
 * `renderer.resolve(surface.scene, eye.target.color.view, eye.viewport)`), so the headset sees
 * the same bloom, tone map and grade as the screen; the layer then takes `colorFormat`, the
 * format the post stack writes (`renderer.format`), and no depth by default.
 *
 * `head` is a camera at the viewer pose with the first eye's projection, for the scenes' one
 * `render(frame, camera, alpha)` call per frame.
 */
import { Camera } from '../render/camera';
import { DEPTH_FORMAT } from '../render/material';
import { SCENE_FORMAT, SceneTarget, type SceneTargetViewport } from '../render/scene-target';

export interface XrSurfaceOptions {
  /** The space poses are expressed in (the game's `local-floor`, `local` or `viewer` space). */
  referenceSpace: XRReferenceSpace;
  /**
   * Colour format of the layer. Default `SCENE_FORMAT`, what the engine's materials write;
   * with `scene` pass the format the post stack writes (`renderer.format`).
   */
  colorFormat?: GPUTextureFormat;
  /**
   * Depth format of the layer, or null for a layer without depth. Default `DEPTH_FORMAT`, or
   * null with `scene` (depth then lives in the scene target; the layer never receives it).
   */
  depthStencilFormat?: GPUTextureFormat | null;
  /**
   * Draw the eyes through the post stack (ws/xr-post): keep `scene`, an eye-sized HDR target,
   * give every eye camera the whole of it (`screen` 0,0,1,1) and leave the layer target for
   * `renderer.resolve`. Default false: eyes draw into the layer directly.
   */
  scene?: boolean;
  /** `texture` (default, eyes side by side in one texture) or `texture-array` (a layer per eye). */
  textureType?: 'texture' | 'texture-array';
  /** The session's near and far planes, metres. Defaults 0.1 and 1000. */
  depthNear?: number;
  depthFar?: number;
}

/** One eye of one frame: where it looks and what it draws into. */
export interface XrEyeView {
  /** The eye's index in the viewer pose (0 left, 1 right on a headset); `camera.viewIndex`. */
  readonly index: number;
  readonly eye: XREye;
  /**
   * Projection and view from the `XRView`; `screen` is the viewport as a fraction of the target,
   * or the whole unit square when the surface has a `scene` target.
   */
  readonly camera: Camera;
  /**
   * The target adopting the layer's texture for this eye; shared when the eyes share a texture.
   * With `scene`, what the eye is resolved into, not what it is rendered into.
   */
  readonly target: SceneTarget;
  /** The eye's part of `target`, in texture pixels (`renderer.resolve`'s viewport). */
  readonly viewport: SceneTargetViewport;
}

class EyeView implements XrEyeView {
  eye: XREye = 'none';
  readonly camera: Camera;
  target: SceneTarget;
  readonly viewport: SceneTargetViewport = { x: 0, y: 0, width: 0, height: 0 };
  /** The array layer this eye reads through (0 for a plain texture). */
  layer = 0;
  /** This eye's own target, used unless an earlier eye already adopted the same texture. */
  readonly own: SceneTarget;

  constructor(
    readonly index: number,
    device: GPUDevice,
    first: XRGPUSubImage,
  ) {
    this.camera = new Camera();
    this.camera.depthTest = true;
    this.camera.depthWrite = true;
    this.camera.viewIndex = index;
    this.own = SceneTarget.external({
      device,
      color: first.colorTexture,
      depth: first.depthStencilTexture,
      view: first.getViewDescriptor(),
      label: `xr-eye-${index}`,
    });
    this.target = this.own;
  }
}

export class XrSurface {
  readonly binding: XRGPUBinding;
  readonly layer: XRProjectionLayer;
  readonly referenceSpace: XRReferenceSpace;
  /**
   * A camera at the viewer pose (between the eyes) with the first eye's projection, depth on,
   * updated by `views`: what the scenes record through once per frame.
   */
  readonly head: Camera = new Camera();
  /**
   * With `scene: true`, the eye-sized HDR target every eye renders into before `resolve`;
   * made by the first `views` with a pose and resized when the eye size changes. Null before
   * then, and always null for a direct surface.
   */
  scene: SceneTarget | null = null;
  private readonly eyes: EyeView[] = [];
  private readonly out: EyeView[] = [];
  private readonly viaScene: boolean;
  private destroyed = false;

  /**
   * Makes the session's projection layer and installs it (`session.updateRenderState`).
   * Throws where the browser has no `XRGPUBinding`; check `XrSurface.supported()` first.
   */
  constructor(
    readonly session: XRSession,
    readonly device: GPUDevice,
    opts: XrSurfaceOptions,
  ) {
    const Binding = globalThis.XRGPUBinding;
    if (!Binding) throw new Error('XrSurface: this browser has no WebXR/WebGPU binding');
    this.referenceSpace = opts.referenceSpace;
    this.viaScene = opts.scene === true;
    this.binding = new Binding(session, device);
    const depth =
      opts.depthStencilFormat === undefined
        ? this.viaScene
          ? null
          : DEPTH_FORMAT
        : opts.depthStencilFormat;
    this.layer = this.binding.createProjectionLayer({
      colorFormat: opts.colorFormat ?? SCENE_FORMAT,
      ...(depth ? { depthStencilFormat: depth } : {}),
      textureType: opts.textureType ?? 'texture',
    });
    session.updateRenderState({
      layers: [this.layer],
      depthNear: opts.depthNear ?? 0.1,
      depthFar: opts.depthFar ?? 1000,
    });
    this.head.depthTest = true;
    this.head.depthWrite = true;
  }

  /** True where `XRGPUBinding` exists (the WebXR/WebGPU binding). */
  static supported(): boolean {
    return typeof globalThis.XRGPUBinding !== 'undefined';
  }

  /**
   * The eyes of this frame, in viewer-pose order, each with its camera aimed and its target
   * adopting the layer's texture for the frame. Empty when the pose is unavailable (tracking
   * lost). The array and the views are reused; read them within the frame.
   */
  views(frame: XRFrame): readonly XrEyeView[] {
    const out = this.out;
    out.length = 0;
    if (this.destroyed) return out;
    const pose = frame.getViewerPose(this.referenceSpace);
    if (!pose) return out;
    const views = pose.views;
    for (let i = 0; i < views.length; i++) {
      const v = views[i]!;
      const sub = this.binding.getViewSubImage(this.layer, v);
      let eye = this.eyes[i];
      if (!eye) {
        eye = new EyeView(i, this.device, sub);
        this.eyes[i] = eye;
      }
      eye.eye = v.eye;
      const cam = eye.camera;
      cam.setProjection(v.projectionMatrix);
      cam.setViewMatrix(v.transform.inverse.matrix);
      const vd = sub.getViewDescriptor();
      const layer = vd.baseArrayLayer ?? 0;
      const vp = eye.viewport;
      vp.x = sub.viewport.x;
      vp.y = sub.viewport.y;
      vp.width = sub.viewport.width;
      vp.height = sub.viewport.height;
      // An earlier eye on the same texture and array layer: share its target (one clear).
      let target: SceneTarget | null = null;
      for (let j = 0; j < i; j++) {
        const o = out[j]!;
        if (o.target.adoptedColor === sub.colorTexture && o.layer === layer) {
          target = o.target;
          break;
        }
      }
      if (!target) {
        target = eye.own;
        target.adopt({
          color: sub.colorTexture,
          depth: sub.depthStencilTexture,
          view: vd,
          viewport: vp,
        });
      }
      eye.target = target;
      eye.layer = layer;
      const s = cam.screen;
      if (this.viaScene) {
        // The eye renders into the whole scene target; `viewport` places the resolve.
        s.x = 0;
        s.y = 0;
        s.width = 1;
        s.height = 1;
        const sc = this.scene ?? this.makeScene();
        sc.resize(vp.width, vp.height);
      } else {
        s.x = vp.x / target.width;
        s.y = vp.y / target.height;
        s.width = vp.width / target.width;
        s.height = vp.height / target.height;
      }
      out.push(eye);
    }
    if (views.length > 0) {
      this.head.setProjection(views[0]!.projectionMatrix);
      this.head.setViewMatrix(pose.transform.inverse.matrix);
    }
    return out;
  }

  private makeScene(): SceneTarget {
    this.scene = new SceneTarget(this.device, { width: 1, height: 1, label: 'xr-scene' });
    return this.scene;
  }

  /** Frees the eye targets' own textures, the scene target and the layer. The session is left to its owner. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const e of this.eyes) e.own.destroy();
    this.eyes.length = 0;
    this.scene?.destroy();
    this.scene = null;
    this.layer.destroy();
  }
}
