import { type Mat4, mat4 } from '../core/math';
import { Camera } from './camera';
import { DEFAULT_SHADOW_BIAS, type ShadowUniforms, type SunShadow } from './lights';
import { INSTANCE_BUFFER_LAYOUT } from './material';
import type { VertexLayout } from './mesh';
import { createShaderModule, materialPrelude } from './wgsl';

/** Depth format of the sun's shadow map (and of the 1×1 placeholder bound without one). */
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';

/** Shadow map side in texels when `SunShadow.size` is not given. */
export const DEFAULT_SHADOW_SIZE = 2048;

const UP = new Float32Array([0, 1, 0]);
const UP_Z = new Float32Array([0, 0, 1]);

/**
 * The sun's shadow map: one `depth32float` texture, a comparison sampler, a 1×1 placeholder
 * depth texture (what every view binds at `@group(0) @binding(3)` until a shadow pass has
 * rendered) and a depth-only pipeline per vertex layout. The renderer owns one and, for each
 * `render` whose `frame.lights.sun.shadow` is set, encodes a shadow pass through `sunCamera`
 * (an orthographic `Camera` placed by `place`) over the view's opaque shadow-casting draws.
 * Engine-internal; games set `Lights.sun.shadow`.
 */
export class ShadowMap {
  /** Comparison sampler (`less-equal`: a receiver at or in front of the stored depth is lit). */
  readonly sampler: GPUSampler;
  /** 1×1 depth view bound in place of the map (and in the shadow pass itself). */
  readonly placeholder: GPUTextureView;
  /** The orthographic camera the shadow pass renders through; `place` sets it. */
  readonly sunCamera = new Camera();
  /** What `Lights.writeBlock` needs for the view this map was rendered for. */
  readonly uniforms: ShadowUniforms;
  /** Side of the current map in texels, 0 before the first shadow pass. */
  size = 0;
  /** Bumped every time the map texture is (re)created, so bind groups can follow it. */
  generation = 0;
  private texture: GPUTexture | null = null;
  /** Maps replaced this frame (passes already encoded may still read them); see `flush`. */
  private readonly retired: GPUTexture[] = [];
  private mapView: GPUTextureView;
  private readonly placeholderTex: GPUTexture;
  private readonly device: GPUDevice;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly pipelines = new Map<VertexLayout, GPURenderPipeline>();
  /** Skinned layouts: one pipeline per material bind group layout (the palette is group 1). */
  private readonly skinnedPipelines = new Map<
    VertexLayout,
    Map<GPUBindGroupLayout, GPURenderPipeline>
  >();
  private readonly globalsLayout: GPUBindGroupLayout;
  private readonly viewM: Mat4 = mat4.create();
  private readonly projM: Mat4 = mat4.create();
  private readonly eye = new Float32Array(3);
  private readonly target = new Float32Array(3);
  private readonly depthAtt: GPURenderPassDepthStencilAttachment;
  /** The shadow pass descriptor; its attachment view follows `view`. */
  readonly passDesc: GPURenderPassDescriptor;

  constructor(device: GPUDevice, globalsLayout: GPUBindGroupLayout) {
    this.device = device;
    this.globalsLayout = globalsLayout;
    this.sampler = device.createSampler({
      label: 'engine-shadow-sampler',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.placeholderTex = device.createTexture({
      label: 'engine-shadow-placeholder',
      size: [1, 1],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.placeholder = this.placeholderTex.createView({ label: 'engine-shadow-placeholder' });
    this.mapView = this.placeholder;
    this.pipelineLayout = device.createPipelineLayout({
      label: 'engine-shadow-layout',
      bindGroupLayouts: [globalsLayout],
    });
    this.depthAtt = {
      view: this.placeholder,
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    this.passDesc = {
      label: 'shadow',
      colorAttachments: [],
      depthStencilAttachment: this.depthAtt,
    };
    this.uniforms = { viewProj: this.sunCamera.viewProjection, bias: 0, texelSize: 0 };
    this.sunCamera.depthTest = true;
    this.sunCamera.depthWrite = true;
  }

  /** The map's view when one has been rendered, else `placeholder`. */
  get view(): GPUTextureView {
    return this.mapView;
  }

  /**
   * Make sure the map is `size` texels square (creating or replacing the texture; bumps
   * `generation` when it does). Returns whether the texture changed.
   */
  ensure(size: number): boolean {
    if (this.texture && this.size === size) return false;
    if (this.texture) this.retired.push(this.texture);
    this.texture = this.device.createTexture({
      label: 'engine-shadow-map',
      size: [size, size],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.mapView = this.texture.createView({ label: 'engine-shadow-map' });
    this.depthAtt.view = this.mapView;
    this.size = size;
    this.generation++;
    return true;
  }

  /**
   * Point `sunCamera` along `sunDir` through an orthographic box centred on `center` (the
   * rendering camera's position): half-width `shadow.extent`, depth `near..far` along the
   * light measured from `center` (defaults `-extent..extent`). Fills `uniforms` for a map of
   * `size` texels. No allocation.
   */
  place(
    center: ArrayLike<number>,
    sunDir: ArrayLike<number>,
    shadow: SunShadow,
    size: number,
  ): void {
    const dx = sunDir[0] ?? 0;
    const dy = sunDir[1] ?? 0;
    const dz = sunDir[2] ?? 0;
    const len = Math.hypot(dx, dy, dz) || 1;
    const e = this.eye;
    const t = this.target;
    e[0] = center[0] ?? 0;
    e[1] = center[1] ?? 0;
    e[2] = center[2] ?? 0;
    t[0] = e[0]! + dx / len;
    t[1] = e[1]! + dy / len;
    t[2] = e[2]! + dz / len;
    // A sun straight up or down has no stable +y "up"; use +z then.
    const up = Math.abs(dy / len) > 0.999 ? UP_Z : UP;
    mat4.lookAt(this.viewM, e, t, up);
    const extent = shadow.extent;
    const near = shadow.near ?? -extent;
    const far = shadow.far ?? extent;
    mat4.ortho(this.projM, -extent, extent, -extent, extent, near, far);
    this.sunCamera.setView(this.viewM);
    this.sunCamera.setProjection(this.projM);
    const u = this.uniforms;
    u.viewProj = this.sunCamera.viewProjection;
    u.bias = shadow.bias ?? DEFAULT_SHADOW_BIAS;
    u.texelSize = 1 / size;
  }

  /**
   * The depth-only pipeline for meshes in `layout`: the engine prelude's `vs_main` (so the same
   * `engine_vertex` path as the scene pass), no fragment stage, `SHADOW_FORMAT` depth with
   * writes on. Built on first use and cached. A skinned layout with `bindingsLayout` (the
   * material's group 1, which holds the joint palette) gets a pipeline layout of both groups.
   */
  pipelineFor(layout: VertexLayout, bindingsLayout?: GPUBindGroupLayout): GPURenderPipeline {
    const skinned = layout.skinned === true && bindingsLayout !== undefined;
    let byGroup: Map<GPUBindGroupLayout, GPURenderPipeline> | undefined;
    if (skinned) {
      byGroup = this.skinnedPipelines.get(layout);
      if (!byGroup) {
        byGroup = new Map();
        this.skinnedPipelines.set(layout, byGroup);
      }
      const hit = byGroup.get(bindingsLayout);
      if (hit) return hit;
    } else {
      const hit = this.pipelines.get(layout);
      if (hit) return hit;
    }
    const module = createShaderModule(
      this.device,
      materialPrelude(layout),
      `engine-shadow:${layout.name}`,
    );
    const pipeline = this.device.createRenderPipeline({
      label: `engine-shadow:${layout.name}`,
      layout: skinned
        ? this.device.createPipelineLayout({
            label: `engine-shadow-layout:${layout.name}`,
            bindGroupLayouts: [this.globalsLayout, bindingsLayout],
          })
        : this.pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [layout.buffer, INSTANCE_BUFFER_LAYOUT] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
    if (byGroup) byGroup.set(bindingsLayout!, pipeline);
    else this.pipelines.set(layout, pipeline);
    return pipeline;
  }

  /** Destroy maps replaced since the last call; the renderer calls it after each submit. */
  flush(): void {
    if (this.retired.length === 0) return;
    for (const t of this.retired) t.destroy();
    this.retired.length = 0;
  }

  destroy(): void {
    this.flush();
    this.texture?.destroy();
    this.texture = null;
    this.placeholderTex.destroy();
    this.pipelines.clear();
    this.skinnedPipelines.clear();
  }
}
