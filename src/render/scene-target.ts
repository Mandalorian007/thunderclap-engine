import { DEPTH_FORMAT } from './material';
import { Texture } from './texture';

/** HDR scene targets: [0] colour, [1] emissive (feeds bloom). */
export const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * The emissive attachment external targets share (ws/ergo-3d, xr-post wish): every material's
 * pipeline writes two colour targets, so a scene pass over an adopted XR texture still needs an
 * emissive attachment of the same size, but nothing reads it (the post stack runs from the
 * renderer's own target). One texture per device and size serves every external target at that
 * size, refcounted, with `storeOp: 'discard'` so tile GPUs never write it back. Two eyes share
 * one; a target released on `destroy` or a size change frees it when the count reaches zero.
 */
interface SharedEmissive {
  tex: Texture;
  refs: number;
}
const sharedEmissive = new WeakMap<GPUDevice, Map<string, SharedEmissive>>();

function acquireSharedEmissive(device: GPUDevice, w: number, h: number, label: string): Texture {
  let bySize = sharedEmissive.get(device);
  if (!bySize) {
    bySize = new Map();
    sharedEmissive.set(device, bySize);
  }
  const key = `${w}x${h}`;
  let e = bySize.get(key);
  if (!e) {
    e = {
      tex: new Texture(device, {
        width: w,
        height: h,
        format: SCENE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        label: `${label}-emissive`,
      }),
      refs: 0,
    };
    bySize.set(key, e);
  }
  e.refs++;
  return e.tex;
}

function releaseSharedEmissive(device: GPUDevice, tex: Texture): void {
  const bySize = sharedEmissive.get(device);
  if (!bySize) return;
  const key = `${tex.width}x${tex.height}`;
  const e = bySize.get(key);
  if (!e || e.tex !== tex) return;
  if (--e.refs > 0) return;
  bySize.delete(key);
  tex.destroy();
}

/** Shared external emissive textures alive on `device` (tests). */
export function sharedEmissiveCount(device: GPUDevice): number {
  return sharedEmissive.get(device)?.size ?? 0;
}

/**
 * Extra attachments a scene target carries beside colour and emissive (ws/render-4), what a
 * screen-space post pass (SSR, TAA, motion blur) reads through `PostInputs.roughMetal` /
 * `PostInputs.velocity`: `roughMetal` an `rg8unorm` (roughness, metalness) target,
 * `velocity` an `rg16float` screen-space motion target (uv units since last frame). Materials
 * declaring `aux` (the standard material) write them; others leave them cleared.
 */
export interface SceneTargetAux {
  roughMetal?: boolean;
  velocity?: boolean;
}

/** Format of the `roughMetal` aux attachment. */
export const ROUGH_METAL_FORMAT: GPUTextureFormat = 'rg8unorm';
/** Format of the `velocity` aux attachment. */
export const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float';

export interface SceneTargetDesc {
  width: number;
  height: number;
  /** Prefix of the texture labels. Default `scene`. */
  label?: string;
  /** Aux attachments; none by default (the target writes identical bytes to before). */
  aux?: SceneTargetAux;
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
  /** Aux attachments, allocated at the adopted size (`SceneTargetDesc.aux`). */
  aux?: SceneTargetAux;
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
 * XR layer's eye textures; `adopt(desc)` re-points it at the next frame's. Its emissive
 * attachment (every pipeline writes two targets) is one texture per device and size shared by
 * all external targets, stored with `'discard'`: the post stack does not run on an external
 * target, so its emissive is written and dropped, and two eyes allocate one, not two.
 *
 * Depth hooks (ws/render-hooks): when a view splits its scene pass for a `readsDepth` drawable
 * the renderer copies `depth` into `depthCopy` (same format and size, `COPY_DST` +
 * `TEXTURE_BINDING`, made on first use, recreated with `depth`) between the opaque pass
 * (`passDesc`, label `scene`) and the blended pass (`blendPassDesc`, label `scene-blend`,
 * which loads every attachment). An allocated depth texture carries `COPY_SRC`; an adopted one
 * (an XR layer's) can be copied only if its owner gave it `COPY_SRC` (`canCopyDepth`).
 */
export class SceneTarget {
  color!: Texture;
  emissive!: Texture;
  /** The `rg8unorm` roughness/metalness attachment (`aux.roughMetal`), else null. */
  roughMetal: Texture | null = null;
  /** The `rg16float` screen-space velocity attachment (`aux.velocity`), else null. */
  velocity: Texture | null = null;
  /** Bit 0: has `roughMetal`; bit 1: has `velocity`. Keys material pipeline variants. */
  readonly auxKey: number;
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
  /** The blended half of a split view: the same attachments, every load op `load`. */
  readonly blendPassDesc: GPURenderPassDescriptor;
  private readonly blendColorAtt: GPURenderPassColorAttachment;
  private readonly blendEmissiveAtt: GPURenderPassColorAttachment;
  /** Aux attachments in order (rough-metal, velocity), for the clear and the blend pass. */
  private readonly auxAtts: GPURenderPassColorAttachment[] = [];
  private readonly blendAuxAtts: GPURenderPassColorAttachment[] = [];
  private readonly blendDepthAtt: GPURenderPassDepthStencilAttachment = {
    view: undefined as unknown as GPUTextureView,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  private depthTex: Texture | null = null;
  private depthCopyTex: Texture | null = null;
  /** `copyDepth`'s reused copy descriptors (no allocation per frame). */
  private readonly copySrc: GPUTexelCopyTextureInfo = {
    texture: undefined as unknown as GPUTexture,
    origin: { x: 0, y: 0, z: 0 },
  };
  private readonly copyDst: GPUTexelCopyTextureInfo = {
    texture: undefined as unknown as GPUTexture,
  };
  private readonly copySize: GPUExtent3DDict = { width: 0, height: 0, depthOrArrayLayers: 1 };
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
    this.auxKey = (desc.aux?.roughMetal ? 1 : 0) | (desc.aux?.velocity ? 2 : 0);
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
    const colorAttachments: GPURenderPassColorAttachment[] = [this.colorAtt, this.emissiveAtt];
    const blendAttachments: GPURenderPassColorAttachment[] = [];
    for (let k = 0; k < 2; k++) {
      if (!(this.auxKey & (1 << k))) continue;
      const att: GPURenderPassColorAttachment = {
        view: undefined as unknown as GPUTextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      };
      const blendAtt: GPURenderPassColorAttachment = {
        view: undefined as unknown as GPUTextureView,
        loadOp: 'load',
        storeOp: 'store',
      };
      this.auxAtts.push(att);
      this.blendAuxAtts.push(blendAtt);
      colorAttachments.push(att);
      blendAttachments.push(blendAtt);
    }
    this.passDesc = { label: 'scene', colorAttachments };
    this.blendColorAtt = {
      view: undefined as unknown as GPUTextureView,
      loadOp: 'load',
      storeOp: 'store',
    };
    this.blendEmissiveAtt = {
      view: undefined as unknown as GPUTextureView,
      loadOp: 'load',
      storeOp: 'store',
    };
    this.blendPassDesc = {
      label: 'scene-blend',
      colorAttachments: [this.blendColorAtt, this.blendEmissiveAtt, ...blendAttachments],
      depthStencilAttachment: this.blendDepthAtt,
    };
    if (external) {
      // Written and dropped: see the shared emissive note above (ws/ergo-3d).
      this.emissiveAtt.storeOp = 'discard';
      this.blendEmissiveAtt.storeOp = 'discard';
    } else this.resize(desc.width, desc.height);
  }

  /** A target over textures owned by someone else (an XR layer's); see `SceneTargetExternal`. */
  static external(desc: SceneTargetExternal): SceneTarget {
    const t = new SceneTarget(
      desc.device,
      { width: 0, height: 0, label: desc.label ?? 'external', aux: desc.aux },
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
   * The sampleable copy of `depth` a split view fills before its blended pass
   * (`Drawable.afterOpaque`); null until the first view that split here. Same format and
   * size as `depth`, recreated with it.
   */
  get depthCopy(): Texture | null {
    return this.depthCopyTex;
  }

  /** Whether `depth` can be the source of a copy (an adopted texture may lack `COPY_SRC`). */
  get canCopyDepth(): boolean {
    return this.depthTex !== null && (this.depthTex.texture.usage & GPUTextureUsage.COPY_SRC) !== 0;
  }

  /**
   * Point an external target at this frame's textures (an XR layer rotates them). A no-op
   * when `color`, `depth` and the view's array layer are the ones already adopted; otherwise
   * new views are made and, if the size changed, the shared emissive is swapped for one of the
   * new size and the own depth texture dropped.
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
      if (this.emissive) releaseSharedEmissive(this.device, this.emissive);
      this.emissive = acquireSharedEmissive(this.device, w, h, this.label);
      this.emissiveAtt.view = this.emissive.view;
      this.blendEmissiveAtt.view = this.emissive.view;
      this.depthTex?.destroy();
      this.depthTex = null;
      this.depthCopyTex?.destroy();
      this.depthCopyTex = null;
      this.resizeAux(w, h);
    }
    this.color = new AdoptedTexture(desc.color, desc.view);
    this.colorAtt.view = this.color.view;
    this.blendColorAtt.view = this.color.view;
    if (depth) {
      this.depthTex = new AdoptedTexture(depth, desc.view);
      this.depthAtt.view = this.depthTex.view;
      this.blendDepthAtt.view = this.depthTex.view;
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
    this.depthCopyTex?.destroy();
    this.depthCopyTex = null;
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
    this.blendColorAtt.view = this.color.view;
    this.blendEmissiveAtt.view = this.emissive.view;
    this.resizeAux(w, h);
    return true;
  }

  /** Load op of the aux attachments for the next scene pass (the renderer: clear on first view). */
  setAuxLoadOp(op: GPULoadOp): void {
    for (const a of this.auxAtts) a.loadOp = op;
  }

  /** (Re)create the aux attachments at `w × h`. */
  private resizeAux(w: number, h: number): void {
    if (this.auxKey === 0) return;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.roughMetal?.destroy();
    this.velocity?.destroy();
    this.roughMetal = null;
    this.velocity = null;
    let i = 0;
    if (this.auxKey & 1) {
      this.roughMetal = new Texture(this.device, {
        width: w,
        height: h,
        format: ROUGH_METAL_FORMAT,
        usage,
        label: `${this.label}-rough-metal`,
      });
      this.auxAtts[i]!.view = this.roughMetal.view;
      this.blendAuxAtts[i]!.view = this.roughMetal.view;
      i++;
    }
    if (this.auxKey & 2) {
      this.velocity = new Texture(this.device, {
        width: w,
        height: h,
        format: VELOCITY_FORMAT,
        usage,
        label: `${this.label}-velocity`,
      });
      this.auxAtts[i]!.view = this.velocity.view;
      this.blendAuxAtts[i]!.view = this.velocity.view;
    }
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
        // COPY_SRC: a split view copies it into `depthCopy` (ws/render-hooks).
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
        label: `${this.label}-depth`,
      });
      this.depthAtt.view = this.depthTex.view;
      this.blendDepthAtt.view = this.depthTex.view;
    }
    return this.depthAtt;
  }

  /**
   * `depthCopy`, allocated at `depth`'s size and format on first use (the renderer calls this
   * when a view splits; `depth` exists by then). Null when `depth` is not copyable.
   */
  depthCopyTexture(): Texture | null {
    if (!this.depthTex || !this.canCopyDepth) return null;
    const d = this.depthTex;
    if (
      this.depthCopyTex &&
      (this.depthCopyTex.width !== d.width ||
        this.depthCopyTex.height !== d.height ||
        this.depthCopyTex.format !== d.format)
    ) {
      this.depthCopyTex.destroy();
      this.depthCopyTex = null;
    }
    if (!this.depthCopyTex) {
      this.depthCopyTex = new Texture(this.device, {
        width: d.width,
        height: d.height,
        format: d.format,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        label: `${this.label}-depth-copy`,
      });
    }
    return this.depthCopyTex;
  }

  /**
   * Encode a copy of `depth` (the adopted layer of an external one) into `depthCopy`, making
   * the copy texture first; returns it, or null when `depth` is missing or not copyable.
   * Nothing is allocated per call once the copy texture exists.
   */
  copyDepth(encoder: GPUCommandEncoder): Texture | null {
    const copy = this.depthCopyTexture();
    const d = this.depthTex;
    if (!copy || !d) return null;
    this.copySrc.texture = d.texture;
    (this.copySrc.origin as GPUOrigin3DDict).z = this.externalDepth ? this.adoptedLayer : 0;
    this.copyDst.texture = copy.texture;
    this.copySize.width = d.width;
    this.copySize.height = d.height;
    encoder.copyTextureToTexture(this.copySrc, this.copyDst, this.copySize);
    return copy;
  }

  destroy(): void {
    this.color?.destroy();
    this.roughMetal?.destroy();
    this.velocity?.destroy();
    this.roughMetal = null;
    this.velocity = null;
    if (this.externalColor) {
      if (this.emissive) releaseSharedEmissive(this.device, this.emissive);
    } else this.emissive?.destroy();
    this.depthTex?.destroy();
    this.depthTex = null;
    this.depthCopyTex?.destroy();
    this.depthCopyTex = null;
  }
}
