import type { RenderCore } from '../render/core/core';
import type { CoreDrawable, CoreDrawableEncoder, CoreDrawContext } from '../render/core/drawable';
import type { CorePass, CorePassContext } from '../render/core/pass-list';
import { coreDepthCompare } from '../render/core/pass-list';
import { CORE_TARGET, coreColorTargets } from '../render/core/targets';
import { CORE_VIEW_WGSL } from '../render/core/view';
import { createShaderModule, WGSL_NOISE } from '../render/wgsl';
import { FX_DEPTH_WGSL, fxDepthCode } from './depth';
import { packSkyParams, SKY_PARAMS_FLOATS, type SkyLook } from './sky';
import { SKY_PARAMS_WGSL, SKY_SHADE_WGSL } from './sky-wgsl';

/** Floats of the sky pass's light block: sun direction, sun colour, fog (rgb, density). */
export const SKY_PASS_LIGHT_FLOATS = 12;

/**
 * The core's sky (ws/core-passes): the same dome as `Sky`, drawn per view from the core's
 * `CoreView` (the view ray from the inverse of `viewProj`, so an off-centre stereo eye, a
 * cube face or an origin-relative view all work). One full-screen triangle at the far plane,
 * tested `less-equal` against depth and never writing it, so the opaque sets drawn before it
 * win. When the core has extra targets (ws/core-targets) the sun disc and stars go to emissive
 * (bloom) and the dome's motion, a direction at infinity so camera turns only, to velocity.
 */
const SKY_PASS_HEAD = /* wgsl */ `${CORE_VIEW_WGSL}
@group(0) @binding(0) var<uniform> view: CoreView;
${WGSL_NOISE}
${FX_DEPTH_WGSL}
${SKY_PARAMS_WGSL}
struct SkyLight {
  sun_dir: vec4f,   // xyz: the way the light travels
  sun_color: vec4f, // rgb, all zero for no sun
  fog: vec4f,       // rgb, density
};
@group(1) @binding(1) var<uniform> light: SkyLight;
${SKY_SHADE_WGSL}
`;

const SKY_PASS_BODY = /* wgsl */ `
fn sky_inverse(m: mat4x4f) -> mat4x4f {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];
  let b00 = a00 * a11 - a01 * a10; let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10; let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11; let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30; let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30; let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31; let b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  let r = 1.0 / det;
  return mat4x4f(
    vec4f(a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09,
          a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03) * r,
    vec4f(a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07,
          a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01) * r,
    vec4f(a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06,
          a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00) * r,
    vec4f(a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06,
          a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00) * r,
  );
}

struct SkyPassOut {
  @builtin(position) clip: vec4f,
  // A point on the pixel's view ray, homogeneous: linear in screen space, divided per pixel.
  @location(0) @interpolate(linear) ray: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> SkyPassOut {
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  var o: SkyPassOut;
  o.clip = vec4f(x, y, fx_depth_far(), 1.0);
  o.ray = sky_inverse(view.viewProj) * vec4f(x, y, 0.5, 1.0);
  return o;
}

struct SkyPassFrag {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
  @location(3) velocity: vec4f,
};

@fragment fn fs(in: SkyPassOut) -> SkyPassFrag {
  let d = normalize(in.ray.xyz / in.ray.w - view.position.xyz);
  let s = SKY_PASS_SHADE;
  var o: SkyPassFrag;
  o.color = vec4f(s.color, 1.0);
  o.emissive = vec4f(s.emissive, 1.0);
  // A point at infinity (w = 0): only turning the view moves the sky.
  let q = vec4f(d, 0.0);
  let c = view.viewProj * q;
  let pw = dot(view.prevRows[2], q);
  var vel = vec2f(0.0);
  if (pw > 0.0 && c.w > 0.0) {
    vel = (c.xy / c.w - vec2f(dot(view.prevRows[0], q), dot(view.prevRows[1], q)) / pw) * vec2f(0.5, -0.5);
  }
  o.velocity = vec4f(vel, 0.0, 1.0);
  return o;
}
`;

/** The default fragment's shade call; a hook's pass calls `sky_look` instead. */
const SHADE_DEFAULT = 'sky_shade(d, light.sun_dir.xyz, light.sun_color.rgb, light.fog)';
const SHADE_HOOK = `sky_look(sky_input(d))`;

/**
 * The core sky pass's shader (the default look): the view block at group 0, the dome's params
 * and light at group 1, and `FX_DEPTH_WGSL` (the far plane by the pass's depth convention).
 */
export const SKY_PASS_WGSL = `${SKY_PASS_HEAD}${SKY_PASS_BODY.replace('SKY_PASS_SHADE', SHADE_DEFAULT)}`;

/**
 * What a `SkyPassOptions.shade` hook's \`sky_look\` gets (ws/fx-fit), per pixel: the world
 * direction, the light, the hook block's time and user params, and the eye in world space.
 */
export const SKY_INPUT_WGSL = /* wgsl */ `
struct SkyInput {
  dir: vec3f,       // the pixel's world direction, normalised
  sun_dir: vec3f,   // the light's travel direction
  sun_color: vec3f, // linear, all zero for no sun
  fog: vec4f,       // rgb, density
  time: f32,        // SkyPass.time, seconds
  eye: vec3f,       // the view's eye, world space (origin added back)
};
`;

/** The most `vec4f` user params a hook's block carries (`SkyPassOptions.params`). */
export const SKY_PASS_MAX_PARAMS = 16;

function hookWgsl(shade: string, params: number): string {
  const n = Math.max(1, params);
  return `${SKY_PASS_HEAD}${SKY_INPUT_WGSL}
struct SkyHook {
  time: vec4f, // seconds, unused, unused, unused
  user: array<vec4f, ${n}>,
};
@group(1) @binding(2) var<uniform> sky_hook: SkyHook;
fn sky_input(d: vec3f) -> SkyInput {
  var i: SkyInput;
  i.dir = d;
  i.sun_dir = light.sun_dir.xyz;
  i.sun_color = light.sun_color.rgb;
  i.fog = light.fog;
  i.time = sky_hook.time.x;
  i.eye = view.position.xyz + view.origin.xyz;
  return i;
}
// The user param at index k (SkyPass.params, vec4 k).
fn sky_param(k: u32) -> vec4f { return sky_hook.user[k]; }
${shade}
${SKY_PASS_BODY.replace('SKY_PASS_SHADE', SHADE_HOOK)}`;
}

/**
 * The CPU mirror of the dome's horizon colour (\`sky_dome\` at elevation 0, times the exposure):
 * what a game's fog uses so fogged ground meets the sky. `sunDir` is the light's travel
 * direction, `sunColor` all zero for no sun, `fog` rgb + density. Into `out` (rgb); no allocation.
 */
export function skyHorizonColor(
  sky: SkyLook,
  sunDir: ArrayLike<number>,
  sunColor: ArrayLike<number>,
  fog: ArrayLike<number>,
  out: Float32Array,
): Float32Array {
  const hasSun = sunColor[0]! + sunColor[1]! + sunColor[2]! > 0;
  const t = Math.min(Math.max((-sunDir[1]! + 0.12) / 0.2, 0), 1);
  const day = hasSun ? t * t * (3 - 2 * t) : 1;
  const dim = sky.ambientFloor + (1 - sky.ambientFloor) * day;
  const haze = Math.min(Math.max(fog[3]!, 0), 1);
  for (let k = 0; k < 3; k++) {
    const h = sky.horizon[k]!;
    out[k] = (h + (fog[k]! - h) * haze) * dim * sky.exposure;
  }
  return out;
}

export interface SkyPassOptions {
  /** The pass id. Default `'sky'`. */
  id?: string;
  /** The pass to follow. Default `'cutout'`: after the opaque sets, before `transparent`. */
  after?: string;
  /** Debug label. Default `'sky pass'`. */
  label?: string;
  /**
   * ws/fx-fit: the game's own sky, as WGSL defining `fn sky_look(i: SkyInput) -> SkyShade`
   * (`SKY_INPUT_WGSL`; `SkyShade` is colour and emissive, linear, exposure applied). It can
   * call the engine's built-ins (`sky_shade`, `sky_dome`, `sky_sun`, `sky_day`, `sky_stars`,
   * `sky_night_stars`, `engine_hash*`/noise), read `sky` (the `SkyLook`'s params), `light`,
   * `view`, `sky_param(k)` and, with `groupLayout`, its own bindings at `@group(2)`. The pass
   * keeps the ray, the far-plane depth and the colour/emissive/velocity writes. Omitted: the
   * default dome, the default shader and bind group, unchanged.
   */
  shade?: string;
  /** With `shade`: `vec4f` user params (`SkyPass.params`, read by `sky_param(k)`). Default 0, at most 16. */
  params?: number;
  /**
   * With `shade`: the layout of the game's `@group(2)` (its textures and buffers), made on the
   * pass's device (again after a restore). Bind with `SkyPass.gameGroup`; no draw until set.
   */
  groupLayout?: (device: GPUDevice) => GPUBindGroupLayout;
  /**
   * ws/fx-fit: join this existing core pass as a member (`SkyPass.member`, a core drawable at
   * `order`) instead of defining a render pass of its own: no extra pass (one tile load and
   * store fewer on a tiled GPU). The pass must test depth (`'write'` or `'read'`); the sky draws
   * after the members ordered before it, so give it an order after the opaque ones.
   * `id` and `after` are then unused.
   */
  member?: string;
  /** With `member`: its order in that pass. Default 1000 (after the pass's own sets). */
  order?: number;
}

/** The look a hook-only sky packs (`createSkyPass(core, null, { shade })`): all zero, exposure 1. */
function skyLookNone(): SkyLook {
  return {
    zenith: new Float32Array(3),
    horizon: new Float32Array(3),
    ground: new Float32Array(3),
    sunSize: 0,
    sunGlow: 0,
    stars: null,
    exposure: 1,
    ambientFloor: 1,
  };
}

/**
 * The sky as a core pass (ws/core-passes): `createSkyPass(core, sky)` defines a pass that
 * draws `sky`'s dome in every view the core draws. `sky` (a `Sky`, or any `SkyLook`) stays the source of the dome's
 * colours (its live fields are read each `prepare`); the sun and fog come from this pass's
 * `sunDir`, `sunColor` and `fog`, which the game sets as it sets its lights. Call `prepare()`
 * once a frame before the core draws. Survives a device restore.
 */
export class SkyPass {
  /** The light's travel direction (from the sun towards the world). Live. */
  readonly sunDir = new Float32Array([0, -1, 0]);
  /** The sun's linear colour; all zero for no sun. Live. */
  readonly sunColor = new Float32Array([1, 1, 1]);
  /** The fog colour (rgb) and density (w) the horizon hazes towards. Live. */
  readonly fog = new Float32Array(4);
  /** The pass in the core's list (with `member`, the pass it joined). */
  readonly pass: CorePass;
  /**
   * With `SkyPassOptions.member` (ws/fx-fit): the core drawable that draws the sky in that pass
   * (null for a pass of its own). Its pipeline is warmed by the core while inactive.
   */
  readonly member: CoreDrawable | null = null;
  /**
   * The dome's colours (`sky`, or with a hook and no look, an all-zero stand-in whose fields
   * the hook's `sky` still reads). Live.
   */
  readonly sky: SkyLook;
  /** With a shade hook: seconds the hook reads as `SkyInput.time`. Live. */
  time = 0;
  /** With a shade hook: the user params (`SkyPassOptions.params` vec4s). Live. */
  readonly params: Float32Array;
  /**
   * With `SkyPassOptions.groupLayout`: the game's `@group(2)` bind group, made from
   * `gameLayout`. Remade by the game after a device restore (null until then: no draw).
   */
  gameGroup: GPUBindGroup | null = null;
  /** The `@group(2)` layout the game binds against (null without `groupLayout`). */
  gameLayout: GPUBindGroupLayout | null = null;
  /** The horizon colour the dome shows (rgb), as of `prepare()`: share it with fog. */
  readonly horizon = new Float32Array(3);
  /** Draws encoded so far (one per view). */
  draws = 0;

  private readonly label: string;
  private readonly data = new Float32Array(SKY_PARAMS_FLOATS + 4 + SKY_PASS_LIGHT_FLOATS);
  private device!: GPUDevice;
  private paramsBuffer!: GPUBuffer;
  private lightBuffer!: GPUBuffer;
  private layout!: GPUBindGroupLayout;
  private group!: GPUBindGroup;
  private module!: GPUShaderModule;
  private pipelineLayout: GPUPipelineLayout | null = null;
  /** Pipelines by colour format, then depth format (`'none'` without depth). */
  /** By colour format, depth format ('none'), then the pass's extra-target mask (0..7). */
  private readonly pipelines = new Map<
    GPUTextureFormat,
    Map<string, (GPURenderPipeline | undefined)[]>
  >();
  private readonly offRestored: () => void;
  private destroyed = false;
  private readonly code: string;
  private reversedModule: GPUShaderModule | null = null;
  private readonly hook: boolean;
  private readonly hookData: Float32Array | null;
  private hookBuffer: GPUBuffer | null = null;
  private readonly groupLayoutOf: ((device: GPUDevice) => GPUBindGroupLayout) | null;

  constructor(
    private readonly core: RenderCore,
    sky: SkyLook | null,
    opts: SkyPassOptions = {},
  ) {
    this.label = opts.label ?? 'sky pass';
    this.hook = opts.shade !== undefined;
    if (!sky && !this.hook) throw new Error('SkyPass: no SkyLook needs a shade hook');
    this.sky = sky ?? skyLookNone();
    const n = Math.min(Math.max(0, Math.floor(opts.params ?? 0)), SKY_PASS_MAX_PARAMS);
    if (opts.params !== undefined && opts.params > SKY_PASS_MAX_PARAMS) {
      throw new Error(`SkyPass: params ${opts.params} > ${SKY_PASS_MAX_PARAMS}`);
    }
    this.code = opts.shade !== undefined ? hookWgsl(opts.shade, n) : SKY_PASS_WGSL;
    this.hookData = this.hook ? new Float32Array(4 + 4 * Math.max(1, n)) : null;
    this.params = this.hookData ? this.hookData.subarray(4, 4 + 4 * n) : new Float32Array(0);
    this.groupLayoutOf = this.hook ? (opts.groupLayout ?? null) : null;
    this.build(core.device);
    if (opts.member !== undefined) {
      const joined = core.passes.get(opts.member);
      if (!joined) throw new Error(`SkyPass: no pass ${opts.member} to join`);
      if (joined.depth === 'none') {
        throw new Error(`SkyPass: pass ${opts.member} has no depth to test the sky against`);
      }
      this.pass = joined;
      this.member = new SkyMember(this, opts.member, opts.order ?? 1000);
      core.addDrawable(this.member);
    } else {
      this.pass = core.definePass({
        id: opts.id ?? 'sky',
        after: opts.after ?? 'cutout',
        depth: 'read',
        // ws/pass-cost: the dome writes these two; rough-metal stays out of the pass.
        writes: ['emissive', 'velocity'],
        encodeWhen: () => this.ready,
        encode: (pass, ctx) => this.encode(pass, ctx),
      });
    }
    this.offRestored = core.onDeviceRestored((d) => this.build(d));
  }

  /** Whether a draw has what it needs (not destroyed; the game's group, when it has one). */
  get ready(): boolean {
    return !this.destroyed && !(this.gameLayout && !this.gameGroup);
  }

  /**
   * @internal As a pass member (`SkyPassOptions.member`): bind and draw the full-screen
   * triangle into `enc` (`vertices` 0: the warm draw). The core calls it through `member`.
   */
  recordMember(enc: CoreDrawableEncoder, ctx: CoreDrawContext, vertices: number): void {
    enc.setPipeline(
      this.pipelineOf(
        ctx.color,
        ctx.depth,
        ctx.aux ?? 0,
        ctx.reversedZ === true,
        this.core.viewLayout,
      ),
    );
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.group);
    if (this.gameGroup && this.gameLayout) enc.setBindGroup(2, this.gameGroup);
    enc.draw(vertices);
    if (vertices > 0) this.draws++;
  }

  /** Pack the sky's and this pass's live fields and upload them. Once a frame; no allocation. */
  prepare(): void {
    if (this.destroyed) return;
    const d = this.data;
    packSkyParams(this.sky, d, 0);
    const o = SKY_PARAMS_FLOATS + 4;
    d[o] = this.sunDir[0]!;
    d[o + 1] = this.sunDir[1]!;
    d[o + 2] = this.sunDir[2]!;
    d[o + 3] = 0;
    d[o + 4] = this.sunColor[0]!;
    d[o + 5] = this.sunColor[1]!;
    d[o + 6] = this.sunColor[2]!;
    d[o + 7] = 0;
    d[o + 8] = this.fog[0]!;
    d[o + 9] = this.fog[1]!;
    d[o + 10] = this.fog[2]!;
    d[o + 11] = this.fog[3]!;
    const q = this.device.queue;
    q.writeBuffer(this.paramsBuffer, 0, d, 0, SKY_PARAMS_FLOATS);
    q.writeBuffer(this.lightBuffer, 0, d, o, SKY_PASS_LIGHT_FLOATS);
    skyHorizonColor(this.sky, this.sunDir, this.sunColor, this.fog, this.horizon);
    const h = this.hookData;
    if (h && this.hookBuffer) {
      h[0] = this.time;
      q.writeBuffer(this.hookBuffer, 0, h);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.member) this.core.removeDrawable(this.member);
    this.offRestored();
    this.paramsBuffer.destroy();
    this.lightBuffer.destroy();
    this.hookBuffer?.destroy();
  }

  private encode(pass: GPURenderPassEncoder, ctx: CorePassContext): void {
    if (this.destroyed) return;
    if (this.gameLayout && !this.gameGroup) return;
    pass.setPipeline(
      this.pipelineOf(ctx.format, ctx.depthFormat, ctx.aux, ctx.reversedZ === true, ctx.viewLayout),
    );
    pass.setBindGroup(0, ctx.view);
    pass.setBindGroup(1, this.group);
    if (this.gameGroup && this.gameLayout) pass.setBindGroup(2, this.gameGroup);
    pass.draw(3);
    this.draws++;
  }

  private pipelineOf(
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat | undefined,
    aux: number,
    reversed: boolean,
    viewLayout: GPUBindGroupLayout,
  ): GPURenderPipeline {
    let byDepth = this.pipelines.get(format);
    if (!byDepth) {
      byDepth = new Map();
      this.pipelines.set(format, byDepth);
    }
    const key = depthFormat ?? 'none';
    let byAux = byDepth.get(key);
    if (!byAux) {
      byAux = [];
      byDepth.set(key, byAux);
    }
    // Slots 0..7 by the extra-target mask; 8..15 the same under reversed-Z.
    const slot = aux + (reversed ? 8 : 0);
    const hit = byAux[slot];
    if (hit) return hit;
    if (!this.pipelineLayout) {
      const layouts = [viewLayout, this.layout];
      if (this.gameLayout) layouts.push(this.gameLayout);
      this.pipelineLayout = this.device.createPipelineLayout({
        label: this.label,
        bindGroupLayouts: layouts,
      });
    }
    const module = reversed ? this.reversedModuleOf() : this.module;
    const p = this.device.createRenderPipeline({
      label: `${this.label}:${format}:${key}:${aux}${reversed ? ':rz' : ''}`,
      layout: this.pipelineLayout,
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: coreColorTargets({ format }, aux, CORE_TARGET.emissive | CORE_TARGET.velocity),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthFormat
        ? {
            format: depthFormat,
            depthWriteEnabled: false,
            depthCompare: coreDepthCompare(reversed, true),
          }
        : undefined,
    });
    byAux[slot] = p;
    return p;
  }

  private reversedModuleOf(): GPUShaderModule {
    this.reversedModule ??= createShaderModule(
      this.device,
      fxDepthCode(this.code, true),
      `${this.label} (reversed-Z)`,
    );
    return this.reversedModule;
  }

  /** Every GPU object, on `device` (the constructor's, or a restored one). */
  private build(device: GPUDevice): void {
    this.device = device;
    this.pipelines.clear();
    this.pipelineLayout = null;
    this.paramsBuffer = device.createBuffer({
      label: `${this.label} params`,
      size: SKY_PARAMS_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.lightBuffer = device.createBuffer({
      label: `${this.label} light`,
      size: SKY_PASS_LIGHT_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layoutEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
    ];
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: this.lightBuffer } },
    ];
    this.hookBuffer = null;
    if (this.hookData) {
      this.hookBuffer = device.createBuffer({
        label: `${this.label} hook`,
        size: this.hookData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      layoutEntries.push({ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} });
      entries.push({ binding: 2, resource: { buffer: this.hookBuffer } });
    }
    this.layout = device.createBindGroupLayout({ label: this.label, entries: layoutEntries });
    this.group = device.createBindGroup({ label: this.label, layout: this.layout, entries });
    this.gameGroup = null;
    this.gameLayout = this.groupLayoutOf ? this.groupLayoutOf(device) : null;
    this.reversedModule = null;
    this.module = createShaderModule(device, this.code, this.label);
  }
}

/**
 * ws/fx-fit: the sky as a member of an existing pass (`SkyPassOptions.member`): drawn directly
 * (the game's group may be replaced any frame), inactive until it can draw, warmed meanwhile.
 */
class SkyMember implements CoreDrawable {
  readonly label: string;
  readonly encoding = 'direct' as const;
  version = 0;

  constructor(
    private readonly sky: SkyPass,
    readonly pass: string,
    readonly order: number,
  ) {
    this.label = 'sky';
  }

  get active(): boolean {
    return this.sky.ready;
  }

  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number {
    this.sky.recordMember(enc, ctx, 3);
    return 1;
  }

  warm(enc: GPURenderPassEncoder, ctx: CoreDrawContext): number {
    if (this.sky.gameLayout && !this.sky.gameGroup) return 0;
    this.sky.recordMember(enc, ctx, 0);
    return 1;
  }
}

/**
 * `new SkyPass(core, sky, opts)`: the sky drawn per view as a core pass, or (`member`) in one.
 * `sky` null (ws/fx-fit) needs a `shade` hook: the game's look, no dome.
 */
export function createSkyPass(
  core: RenderCore,
  sky: SkyLook | null,
  opts?: SkyPassOptions,
): SkyPass {
  return new SkyPass(core, sky, opts);
}
