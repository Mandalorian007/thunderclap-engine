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

/** A rect in texture pixels, origin top-left. */
export interface SceneTargetViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Textures a `SceneTarget.external` target adopts instead of allocating (ws/xr): the colour
 * texture an `XRProjectionLayer` hands out per eye per frame and, when the layer has one, its
 * depth texture. The target never destroys them. `color` must be `SCENE_FORMAT`, since every
 * material's pipeline writes it, and `depth` `DEPTH_FORMAT`; `view` is the view descriptor
 * (array layer, mip) both are read through, for a texture-array layer. `viewport` is the part
 * of the texture these views draw into, recorded on the target for its caller (the renderer
 * takes the viewport from `camera.screen`).
 */
export interface SceneTargetExternal {
  device: GPUDevice;
  color: GPUTexture;
  depth?: GPUTexture | null;
  view?: GPUTextureViewDescriptor;
  viewport?: SceneTargetViewport;
  /** Prefix of the labels of what the target still allocates (emissive, depth). Default `external`. */
  label?: string;
}

/** A texture owned by someone else, in the shape of `Texture` (its `destroy` does nothing). */
class AdoptedTexture {
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  /** One layer, one mip, a `'2d'` view: the adopted view is a single eye's layer. */
  readonly layers = 1;
  readonly mipLevels = 1;
  readonly viewDimension = '2d' as const;
  constructor(
    readonly texture: GPUTexture,
    view?: GPUTextureViewDescriptor,
  ) {
    this.view = texture.createView(view);
    this.width = texture.width;
    this.height = texture.height;
    this.format = texture.format;
  }
  destroy(): void {}
}

/**
 * What `Renderer.render` draws into: the two HDR colour targets the scene pass writes
 * (`color`, `emissive`, both `SCENE_FORMAT`) and, when a camera asks for depth, a
 * `depth24plus` attachment made at the same size on first use. The renderer owns one at the
 * scene resolution (`renderer.target`, what the post stack reads and the surface shows);
 * `renderer.createSceneTarget(desc)` makes more for offscreen views (a portal, a minimap),
 * whose `color` and `emissive` are sampleable like any `Texture`.
 *
 * `SceneTarget.external(desc)` adopts a colour (and depth) texture owned by someone else, an
 * XR layer's eye textures; `adopt(desc)` re-points it at the next frame's. It still allocates
 * its own emissive target at that size (the post stack does not run on an external target; its
 * emissive is written and dropped).
 */
export class SceneTarget {
  color!: Texture;
  emissive!: Texture;
  width = 0;
  height = 0;
  /**
   * For an external target, the part of `color` its views draw into (texture px), or null
   * when the whole texture is the view; always null for an allocated target.
   */
  viewport: SceneTargetViewport | null = null;
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
  /** The adopted colour texture of an external target; null for an allocated one. */
  private externalColor: GPUTexture | null = null;
  /** The adopted depth texture of an external target, when its layer has one. */
  private externalDepth: GPUTexture | null = null;
  private adoptedLayer = 0;

  /** `external`: internal, set by `SceneTarget.external`; the textures then come from `adopt`. */
  constructor(
    private readonly device: GPUDevice,
    desc: SceneTargetDesc,
    external = false,
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
    if (!external) this.resize(desc.width, desc.height);
  }

  /** A target over textures owned by someone else (an XR layer's); see `SceneTargetExternal`. */
  static external(desc: SceneTargetExternal): SceneTarget {
    const t = new SceneTarget(
      desc.device,
      { width: 0, height: 0, label: desc.label ?? 'external' },
      true,
    );
    t.adopt(desc);
    return t;
  }

  /** True for a target made by `SceneTarget.external`. */
  get isExternal(): boolean {
    return this.externalColor !== null;
  }

  /** The adopted colour texture of an external target; null for an allocated one. */
  get adoptedColor(): GPUTexture | null {
    return this.externalColor;
  }

  /**
   * The depth texture, once a depth camera has rendered here; null before. Sampleable
   * (`texture_depth_2d`) outside the scene pass that writes it.
   */
  get depth(): Texture | null {
    return this.depthTex;
  }

  /**
   * Point an external target at this frame's textures (an XR layer rotates them). A no-op
   * when `color`, `depth` and the view's array layer are the ones already adopted; otherwise
   * new views are made and, if the size changed, the emissive and own depth textures too.
   */
  adopt(desc: Omit<SceneTargetExternal, 'device' | 'label'>): void {
    const depth = desc.depth ?? null;
    const layer = desc.view?.baseArrayLayer ?? 0;
    const same =
      desc.color === this.externalColor &&
      depth === this.externalDepth &&
      layer === this.adoptedLayer;
    this.viewport = desc.viewport ?? null;
    if (same) return;
    this.externalColor = desc.color;
    this.externalDepth = depth;
    this.adoptedLayer = layer;
    const w = desc.color.width;
    const h = desc.color.height;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.emissive?.destroy();
      this.emissive = new Texture(this.device, {
        width: w,
        height: h,
        format: SCENE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        label: `${this.label}-emissive`,
      });
      this.emissiveAtt.view = this.emissive.view;
      this.depthTex?.destroy();
      this.depthTex = null;
    }
    this.color = new AdoptedTexture(desc.color, desc.view);
    this.colorAtt.view = this.color.view;
    if (depth) {
      this.depthTex = new AdoptedTexture(depth, desc.view);
      this.depthAtt.view = this.depthTex.view;
    } else if (this.depthTex && this.depthTex instanceof AdoptedTexture) {
      this.depthTex = null;
    }
  }

  /** Recreate the textures at a new size (no-op when unchanged). Returns whether they changed. */
  resize(width: number, height: number): boolean {
    if (this.externalColor)
      throw new Error('SceneTarget.resize: an external target is sized by its textures');
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

  /**
   * The depth attachment, allocating the `depth24plus` texture at this size on first use (an
   * external target with an adopted depth texture uses that instead).
   */
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
