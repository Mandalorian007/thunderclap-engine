import type { ShadowUniforms } from './lights';

/**
 * What `CoreSunShadow` reads of a sun shadow map (ws/warm-voxel-fit): the renderer's
 * `ShadowMap`, or a `CoreShadowMap` for a game that draws its own shadow pass on the core and
 * should not pull in the forward renderer's shadow code.
 */
export interface CoreShadowSource {
  /** Bumped when the map texture is remade (the bind group follows it). */
  readonly generation: number;
  /** The map's depth view (a placeholder before the first map). */
  readonly view: GPUTextureView;
  /** A comparison sampler (`less-equal`). */
  readonly sampler: GPUSampler;
  /** The sun's view-projection, the depth bias and one texel in UV. */
  readonly uniforms: ShadowUniforms;
}

/**
 * A lean sun shadow map for a core-only game (ws/warm-voxel-fit): a square `depth32float` map,
 * its comparison sampler and uniforms, with none of `ShadowMap`'s forward-renderer pipelines.
 * Draw into `target` with `RenderCore.drawShadow` (set `uniforms.viewProj` to the sun's matrix
 * and the core view to it), and bind it with `CoreSunShadow`.
 */
export class CoreShadowMap implements CoreShadowSource {
  readonly sampler: GPUSampler;
  readonly uniforms: { viewProj: Float32Array; bias: number; texelSize: number };
  /** Side of the map in texels (0: the 1×1 placeholder). */
  size = 0;
  generation = 0;
  private texture: GPUTexture;
  private viewNow: GPUTextureView;
  private readonly device: GPUDevice;
  /** The core's shadow target over the map (`RenderCore.drawShadow`). */
  readonly target: { view: GPUTextureView; format: GPUTextureFormat };

  constructor(device: GPUDevice, size = 0, bias = 0.0015) {
    this.device = device;
    this.sampler = device.createSampler({
      label: 'core-shadow-sampler',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const viewProj = new Float32Array(16);
    viewProj[0] = viewProj[5] = viewProj[10] = viewProj[15] = 1;
    this.uniforms = { viewProj, bias, texelSize: 1 };
    this.texture = this.make(1);
    this.viewNow = this.texture.createView();
    this.target = { view: this.viewNow, format: 'depth32float' };
    if (size > 0) this.resize(size);
  }

  get view(): GPUTextureView {
    return this.viewNow;
  }

  /** Remake the map at `size`² texels (a no-op at the same size); bumps `generation`. */
  resize(size: number): void {
    if (size === this.size) return;
    this.texture.destroy();
    this.size = size;
    this.texture = this.make(Math.max(1, size));
    this.viewNow = this.texture.createView();
    this.target.view = this.viewNow;
    this.uniforms.texelSize = 1 / Math.max(1, size);
    this.generation++;
  }

  destroy(): void {
    this.texture.destroy();
  }

  private make(size: number): GPUTexture {
    return this.device.createTexture({
      label: 'core-shadow-map',
      size: [size, size],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
}

/**
 * The WGSL a retained-core draw set (`RenderCore`) includes to receive the sun's shadow
 * (ws/core-passes), its bind group at `@group(group)`: `core_sun_shadow(world)` is the sun's
 * visibility at `world` (the position the set's vertex stage computed, frame-origin relative
 * under `originGrid`), 0..1 with the same 3×3 PCF as `engine_shadow`, 1 outside the map or
 * when no shadow pass ran this frame. Bind `renderer.coreShadow` there.
 */
export function coreSunShadowWgsl(group: number): string {
  return /* wgsl */ `struct CoreSunShadow {
  view_proj: mat4x4f,
  // x: bias, y: texel size, z: on
  params: vec4f,
};
@group(${group}) @binding(0) var<uniform> core_sun: CoreSunShadow;
@group(${group}) @binding(1) var core_sun_map: texture_depth_2d;
@group(${group}) @binding(2) var core_sun_sampler: sampler_comparison;
fn core_sun_shadow(world: vec3f) -> f32 {
  // Off: lit, before the divide (an off matrix may be all zeros: w 0, NaN on Metal).
  if (core_sun.params.z == 0.0) {
    return 1.0;
  }
  let clip = core_sun.view_proj * vec4f(world, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let depth = ndc.z - core_sun.params.x;
  let texel = core_sun.params.y;
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y)) * texel;
      lit += textureSampleCompareLevel(core_sun_map, core_sun_sampler, uv + o, depth);
    }
  }
  let outside = any(abs(ndc.xy) > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0;
  return select(lit / 9.0, 1.0, outside);
}
`;
}

/**
 * The sun's shadow as a retained-core draw set binds it (`renderer.coreShadow`, ws/core-passes):
 * `layout` for the set's shader (`coreSunShadowWgsl`), `group` over the current map, rebuilt
 * when the map is replaced (`version` bumps; re-bind with `DrawSet.setBindGroups`). The renderer
 * writes the uniform each frame its core draws: the sun's matrix (moved to the core's frame
 * origin) and `on` when the shadow pass ran, else `on` 0.
 */
export class CoreSunShadow {
  readonly layout: GPUBindGroupLayout;
  /** Changes when the map is remade (`group` then binds the new one). */
  get version(): number {
    return this.shadow.generation;
  }
  private readonly buffer: GPUBuffer;
  private readonly data = new Float32Array(20);
  private groupNow: GPUBindGroup | null = null;
  private generation = -1;
  private readonly device: GPUDevice;
  private readonly shadow: CoreShadowSource;

  constructor(device: GPUDevice, shadow: CoreShadowSource) {
    this.device = device;
    this.shadow = shadow;
    this.layout = device.createBindGroupLayout({
      label: 'core-sun-shadow',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    this.buffer = device.createBuffer({
      label: 'core-sun-shadow',
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** The bind group over the current map (the placeholder before the first shadow pass). */
  get group(): GPUBindGroup {
    const s = this.shadow;
    if (!this.groupNow || this.generation !== s.generation) {
      this.generation = s.generation;
      this.groupNow = this.device.createBindGroup({
        label: 'core-sun-shadow',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer } },
          { binding: 1, resource: s.view },
          { binding: 2, resource: s.sampler },
        ],
      });
    }
    return this.groupNow;
  }

  /**
   * Write the uniform: `on` with the map's matrix moved to `origin` (the core's frame origin:
   * `world` in the shader is relative to it), else off. No allocation.
   */
  write(on: boolean, origin: ArrayLike<number>): void {
    const d = this.data;
    const u = this.shadow.uniforms;
    const m = u.viewProj;
    for (let i = 0; i < 12; i++) d[i] = m[i]!;
    const ox = origin[0]!;
    const oy = origin[1]!;
    const oz = origin[2]!;
    for (let r = 0; r < 4; r++)
      d[12 + r] = m[r]! * ox + m[4 + r]! * oy + m[8 + r]! * oz + m[12 + r]!;
    d[16] = u.bias;
    d[17] = u.texelSize;
    d[18] = on ? 1 : 0;
    d[19] = 0;
    this.device.queue.writeBuffer(this.buffer, 0, d);
  }
}
