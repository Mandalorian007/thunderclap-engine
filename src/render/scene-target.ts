import { DEPTH_FORMAT } from './material';
import { Texture } from './texture';

/** HDR scene targets: [0] colour, [1] emissive (feeds bloom). */
export const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';

export interface SceneTargetDesc {
  width: number;
  height: number;
  /** Prefix of the texture labels. Default `scene`. */
  label?: string;
}

/**
 * What `Renderer.render` draws into: the two HDR colour targets the scene pass writes
 * (`color`, `emissive`, both `SCENE_FORMAT`) and, when a camera asks for depth, a
 * `depth24plus` attachment made at the same size on first use. The renderer owns one at the
 * scene resolution (`renderer.target`, what the post stack reads and the surface shows);
 * `renderer.createSceneTarget(desc)` makes more for offscreen views (a portal, a minimap),
 * whose `color` and `emissive` are sampleable like any `Texture`.
 */
export class SceneTarget {
  color!: Texture;
  emissive!: Texture;
  width = 0;
  height = 0;
  /** The scene pass descriptor for this target; the renderer sets its load ops per view. */
  readonly passDesc: GPURenderPassDescriptor;
  readonly colorAtt: GPURenderPassColorAttachment;
  readonly emissiveAtt: GPURenderPassColorAttachment;
  readonly depthAtt: GPURenderPassDepthStencilAttachment = {
    view: undefined as unknown as GPUTextureView,
    depthClearValue: 1,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
  };
  private depthTex: Texture | null = null;
  private readonly label: string;

  constructor(
    private readonly device: GPUDevice,
    desc: SceneTargetDesc,
  ) {
    this.label = desc.label ?? 'scene';
    this.colorAtt = {
      view: undefined as unknown as GPUTextureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    };
    this.emissiveAtt = {
      view: undefined as unknown as GPUTextureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    this.passDesc = { label: 'scene', colorAttachments: [this.colorAtt, this.emissiveAtt] };
    this.resize(desc.width, desc.height);
  }

  /**
   * The depth texture, once a depth camera has rendered here; null before. Sampleable
   * (`texture_depth_2d`) outside the scene pass that writes it.
   */
  get depth(): Texture | null {
    return this.depthTex;
  }

  /** Recreate the textures at a new size (no-op when unchanged). Returns whether they changed. */
  resize(width: number, height: number): boolean {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.color && w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.color?.destroy();
    this.emissive?.destroy();
    // The depth target (only ever made for a depth camera) is rebuilt at the new size lazily.
    this.depthTex?.destroy();
    this.depthTex = null;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.color = new Texture(this.device, {
      width: w,
      height: h,
      format: SCENE_FORMAT,
      usage,
      label: `${this.label}-color`,
    });
    this.emissive = new Texture(this.device, {
      width: w,
      height: h,
      format: SCENE_FORMAT,
      usage,
      label: `${this.label}-emissive`,
    });
    this.colorAtt.view = this.color.view;
    this.emissiveAtt.view = this.emissive.view;
    return true;
  }

  /** The depth attachment, allocating the `depth24plus` texture at this size on first use. */
  depthAttachment(): GPURenderPassDepthStencilAttachment {
    if (!this.depthTex) {
      this.depthTex = new Texture(this.device, {
        width: this.width,
        height: this.height,
        format: DEPTH_FORMAT,
        // TEXTURE_BINDING: world-space particles copy it for their soft fade (`depth`).
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        label: `${this.label}-depth`,
      });
      this.depthAtt.view = this.depthTex.view;
    }
    return this.depthAtt;
  }

  destroy(): void {
    this.color?.destroy();
    this.emissive?.destroy();
    this.depthTex?.destroy();
    this.depthTex = null;
  }
}
