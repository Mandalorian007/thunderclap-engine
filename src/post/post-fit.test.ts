/** Post fit for a large 3D game (ws/post-fit): cached groups, hook, host, jitter, reversed-Z. */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { Arena } from '../render/core/arena';
import { type CoreTarget, createRenderCore, type RenderCoreOptions } from '../render/core/core';
import { createVertexLayout } from '../render/core/layout';
import { createRenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeView } from '../render/fake-gpu';
import type { PostInputs, PostProcessor, PostView } from '../render/renderer';
import { createCorePost } from './core-post';
import { createPostHost } from './host';
import { createLutTexture, identityLut, lutTexelsHalf, toHalf, writeLutTexture } from './lut';
import { PostStack } from './post-stack';
import {
  applyPostPatch,
  cinematicPostSettings,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';
import { COMPOSITE_WGSL, compositeWgsl } from './shaders';

/** Float offsets in the uniform block (`WGSL_POST_UNIFORMS`). */
const BLOOM2 = 16;
const QUALITY = 68;
const SHARPEN = 120;

const W = 64;
const H = 32;

function texture(device: GPUDevice, format: GPUTextureFormat, label: string) {
  const t = device.createTexture({
    label,
    size: [W, H],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  return { view: t.createView(), width: W, height: H };
}

function view(): PostView {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return {
    viewProj: m,
    invViewProj: m.slice(),
    previousViewProj: m.slice(),
    previousView: m.slice(),
    jitter: [0, 0],
  };
}

/** A post-only stack over `createPostHost` and the inputs of a 3D frame. */
function stackSetup(patch: ConstructorParameters<typeof PostStack>[1] = {}) {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const host = createPostHost(device, 'bgra8unorm', { width: W, height: H });
  const stack = new PostStack(host, patch);
  const proj = Camera.perspective(1, 2, 0.1, 100).projection;
  const inputs: PostInputs = {
    color: texture(device, 'rgba16float', 'color'),
    emissive: texture(device, 'rgba16float', 'emissive'),
    time: 0,
    dt: 1 / 60,
    depth: texture(device, 'depth24plus', 'depth'),
    projection: { near: 0.1, far: 100, proj: new Float32Array(proj) },
    view: view(),
    roughMetal: null,
    velocity: texture(device, 'rg16float', 'velocity'),
  };
  const out = texture(device, 'bgra8unorm', 'out').view;
  const frame = (): number => {
    const before = fake.bindGroups.length;
    const enc = device.createCommandEncoder();
    inputs.time += 1 / 60;
    stack.encode(enc, inputs, out);
    device.queue.submit([enc.finish()]);
    return fake.bindGroups.length - before;
  };
  return { fake, device, host, stack, inputs, frame };
}

const uniforms = (s: PostStack): Float32Array =>
  (s as unknown as { uniforms: Float32Array }).uniforms;

describe('cached bind groups (ws/post-fit item 1)', () => {
  it('TAA + bloom + LUT: no bind group after the warm-up, nor when the inputs alternate', () => {
    const { device, stack, inputs, frame } = stackSetup({
      taa: { enabled: true, reprojection: 'velocity' },
      bloom: { enabled: true },
    });
    stack.set({ lut: { texture: identityLut(device, 16) } });
    for (let i = 0; i < 3; i++) frame();
    expect(frame()).toBe(0);
    // A second emissive (another target, an eye) alternating with the first keeps both sets.
    const a = inputs.emissive;
    const b = texture(device, 'rgba16float', 'emissive-b');
    for (let i = 0; i < 6; i++) {
      inputs.emissive = i % 2 ? a : b;
      frame();
    }
    const steady: number[] = [];
    for (let i = 0; i < 6; i++) {
      inputs.emissive = i % 2 ? a : b;
      steady.push(frame());
    }
    expect(steady).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('a new LUT rebuilds the composite group only; a LUT rewritten in place rebuilds nothing', () => {
    const { fake, device, stack, frame } = stackSetup({
      taa: { enabled: true },
      bloom: { enabled: true },
    });
    const lut = identityLut(device, 16);
    stack.set({ lut: { texture: lut } });
    for (let i = 0; i < 3; i++) frame();
    const before = fake.bindGroups.length;
    stack.set({ lut: { texture: createLutTexture(device, 16, (r, g, b) => [b, g, r]) } });
    // One composite group per TAA history view (the resolve ping-pongs), nothing else.
    frame();
    frame();
    expect(fake.bindGroups.slice(before).map((g) => g.label)).toEqual([
      'pass:post-composite-group',
      'pass:post-composite-group',
    ]);
    expect(frame()).toBe(0);
    const writes = fake.textureWrites.length;
    writeLutTexture(device, lut, (r, g, b) => [g, r, b]);
    stack.set({ lut: { texture: lut } });
    frame();
    frame();
    expect(frame()).toBe(0);
    expect(fake.textureWrites.length).toBe(writes + 1);
  });
});

describe('composite hook and emissive add (ws/post-fit item 2)', () => {
  it('compiles the hook in only when given; the default WGSL is unchanged', () => {
    expect(COMPOSITE_WGSL).toBe(compositeWgsl());
    expect(COMPOSITE_WGSL).not.toContain('post_hook');
    const hooked = compositeWgsl('fn post_hook(uv: vec2f, c: vec3f) -> vec3f { return c; }');
    expect(hooked).toContain('c = post_hook(uv, c);');
    // After sharpen, before the outline.
    const call = hooked.indexOf('c = post_hook(uv, c);');
    expect(hooked.indexOf('P.sharpen.x > 0.0')).toBeLessThan(call);
    expect(hooked.indexOf('P.outline.x > 0.5')).toBeGreaterThan(call);
  });

  it('binds the hook textures at 12+ and its buffers at 16+; setHookTextures rebuilds the composite only', () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const host = createPostHost(device, 'bgra8unorm', { width: W, height: H });
    const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    const stack = new PostStack(
      host,
      {},
      {
        hook: {
          wgsl: 'fn post_hook(uv: vec2f, c: vec3f) -> vec3f { return c + textureSampleLevel(hookTex0, samp, uv, 0.0).rgb; }',
          textures: 1,
          buffers: [buf],
        },
      },
    );
    const heat = texture(device, 'rgba16float', 'heat');
    stack.setHookTextures([heat.view]);
    const inputs: PostInputs = {
      color: texture(device, 'rgba16float', 'c'),
      emissive: texture(device, 'rgba16float', 'e'),
      time: 0,
      dt: 0,
      depth: null,
      projection: null,
      view: null,
      roughMetal: null,
      velocity: null,
    };
    const out = texture(device, 'bgra8unorm', 'o').view;
    const enc = device.createCommandEncoder();
    stack.encode(enc, inputs, out);
    const g = fake.bindGroups.filter((x) => x.label === 'pass:post-composite-group').at(-1)!;
    expect(g.entries.find((e) => e.binding === 12)!.resource).toBe(heat.view);
    expect((g.entries.find((e) => e.binding === 16)!.resource as GPUBufferBinding).buffer).toBe(
      buf,
    );
    const before = fake.bindGroups.length;
    stack.setHookTextures([heat.view]);
    stack.encode(enc, inputs, out);
    expect(fake.bindGroups.length).toBe(before);
    stack.setHookTextures([texture(device, 'rgba16float', 'heat2').view]);
    stack.encode(enc, inputs, out);
    expect(fake.bindGroups.slice(before).map((x) => x.label)).toEqual([
      'pass:post-composite-group',
    ]);
  });

  it('packs the emissive add weight (default 1; 0 skips the add) and linear output', () => {
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const s = cinematicPostSettings();
    packPostUniforms(out, s, 0, W, H, W, H);
    expect(out[BLOOM2 + 1]).toBe(1);
    expect(out[BLOOM2 + 2]).toBe(0);
    applyPostPatch(s, { bloom: { emissiveAdd: 0 } });
    packPostUniforms(out, s, 0, W, H, W, H, undefined, null, 0, {
      jitterX: 0,
      jitterY: 0,
      reset: 0,
      reproj: new Float32Array(16),
      autoExposure: 1,
      linearOutput: 1,
    });
    expect(out[BLOOM2 + 1]).toBe(0);
    expect(out[BLOOM2 + 2]).toBe(1);
    expect(COMPOSITE_WGSL).toContain('if (P.bloom2.y != 0.0)');
  });
});

describe('PostHost (ws/post-fit item 3)', () => {
  it('runs the whole stack without a Renderer; the jitter hook lands on the host', () => {
    const { host, stack, frame } = stackSetup({ taa: { enabled: true }, bloom: { enabled: true } });
    frame();
    expect(stack.taaActive).toBe(true);
    expect(host.jitter).not.toBeNull();
    host.resize(128, 64);
    expect(host.outputWidth).toBe(128);
    stack.destroy();
    expect(host.jitter).toBeNull();
  });

  it('writes the output format of its options and linear colour when toSrgb is false', () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const host = createPostHost(device, 'bgra8unorm');
    const stack = new PostStack(host, {}, { format: 'rgba16float', toSrgb: false });
    const inputs: PostInputs = {
      color: texture(device, 'rgba16float', 'c'),
      emissive: texture(device, 'rgba16float', 'e'),
      time: 0,
      dt: 0,
      depth: null,
      projection: null,
      view: null,
      roughMetal: null,
      velocity: null,
    };
    const enc = device.createCommandEncoder();
    stack.encode(enc, inputs, texture(device, 'rgba16float', 'o').view);
    expect(uniforms(stack)[BLOOM2 + 2]).toBe(1);
    const composite = (
      stack as unknown as { composite: { pipeline: { desc: GPURenderPipelineDescriptor } } }
    ).composite.pipeline.desc;
    expect([...composite.fragment!.targets][0]!.format).toBe('rgba16float');
  });
});

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const SHADER = {
  code: '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
};

function coreSetup(opts: Partial<RenderCoreOptions> = {}) {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device, { depthFormat: 'depth24plus', ...opts });
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 4096 });
  const set = core.createDrawSet({
    label: 'boxes',
    shader: SHADER,
    vertexLayout: PACKED,
    vertices,
    capacity: 8,
    cull: 'cpu',
  });
  set.add({ vertices: vertices.alloc(24 * 8, 8), indexCount: 36, bounds: [0, 0, -5, 1] });
  const calls: { view: PostView; proj: { near: number; far: number; rz: boolean } | null }[] = [];
  const proc: PostProcessor = {
    resize: () => {},
    encode: (_e, inputs) => {
      const v = inputs.view!;
      calls.push({
        view: {
          viewProj: v.viewProj.slice(),
          invViewProj: v.invViewProj.slice(),
          previousViewProj: v.previousViewProj.slice(),
          previousView: v.previousView.slice(),
          jitter: [v.jitter[0], v.jitter[1]],
          velocityJitter: v.velocityJitter ? [v.velocityJitter[0], v.velocityJitter[1]] : undefined,
        },
        proj: inputs.projection
          ? {
              near: inputs.projection.near,
              far: inputs.projection.far,
              rz: inputs.projection.reversedZ === true,
            }
          : null,
      });
      inputs.timestamps?.('taa');
    },
  };
  const scene = device.createTexture({
    size: [W, H],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const out = device.createTexture({
    size: [W, H],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target: CoreTarget = {
    view: scene.createView(),
    format: 'rgba16float',
    width: W,
    height: H,
    clear: { r: 0, g: 0, b: 0, a: 1 },
    output: out.createView(),
    outputFormat: 'bgra8unorm',
  };
  const draw = (rv: ReturnType<typeof createRenderView>, t: CoreTarget = target) => {
    const enc = device.createCommandEncoder();
    core.prepare(enc, [rv]);
    core.draw(enc, 0, t);
    device.queue.submit([enc.finish()]);
  };
  return { fake, device, core, proc, calls, target, draw };
}

function camView(x = 0) {
  const c = Camera.perspective(Math.PI / 2, 2, 0.1, 100);
  c.lookAt([x, 0, 0], [x, 0, -1]);
  return setViewFromCamera(createRenderView(), c);
}

/** Add a clip offset (px) to a view's matrix, as a game jitters its projection. */
function jitter(rv: ReturnType<typeof createRenderView>, base: Float32Array, x: number, y: number) {
  const m = rv.viewProj;
  m.set(base);
  const dx = (2 * x) / W;
  const dy = (-2 * y) / H;
  for (let c = 0; c < 16; c += 4) {
    m[c] = m[c]! + dx * m[c + 3]!;
    m[c + 1] = m[c + 1]! + dy * m[c + 3]!;
  }
}

describe('CorePost jitter (ws/post-fit item 4)', () => {
  it('hands the jittered matrix and jitter, and an unjittered previous; removes the velocity jitter on ask', () => {
    const { core, proc, calls, draw } = coreSetup();
    const post = createCorePost(core, proc, { velocityJitter: 'remove' });
    const rv = camView();
    const base = rv.viewProj.slice();
    post.setJitter(0.25, -0.5);
    jitter(rv, base, 0.25, -0.5);
    draw(rv);
    post.setJitter(-0.5, 0.25, 0);
    jitter(rv, base, -0.5, 0.25);
    draw(rv);
    const f = calls[1]!.view;
    expect(f.jitter).toEqual([-0.5, 0.25]);
    expect([...f.viewProj]).toEqual([...rv.viewProj]);
    for (let k = 0; k < 16; k++) expect(f.previousViewProj[k]).toBeCloseTo(base[k]!, 5);
    expect(f.velocityJitter![0]).toBeCloseTo(-0.75, 6);
    expect(f.velocityJitter![1]).toBeCloseTo(0.75, 6);
  });

  it('keeps today’s behaviour without setJitter: jitter 0, previous = last frame', () => {
    const { core, proc, calls, draw } = coreSetup();
    createCorePost(core, proc);
    const rv = camView();
    draw(rv);
    draw(rv);
    expect(calls[1]!.view.jitter).toEqual([0, 0]);
    expect(calls[1]!.view.velocityJitter).toEqual([0, 0]);
    expect([...calls[1]!.view.previousViewProj]).toEqual([...calls[0]!.view.viewProj]);
  });

  it('packs the velocity jitter in uv for a TAA velocity resolve only', () => {
    const { stack, inputs, frame } = stackSetup({
      taa: { enabled: true, reprojection: 'velocity' },
    });
    inputs.view!.velocityJitter = [0.5, -0.25];
    frame();
    expect(uniforms(stack)[SHARPEN + 1]).toBeCloseTo(0.5 / W, 7);
    expect(uniforms(stack)[SHARPEN + 2]).toBeCloseTo(-0.25 / H, 7);
    stack.set({ taa: { reprojection: 'camera' } });
    frame();
    expect(uniforms(stack)[SHARPEN + 1]).toBe(0);
  });
});

describe('reversed-Z (ws/post-fit item 5)', () => {
  it('CorePost reads near/far of a reversed projection and flags it', () => {
    const { core, proc, calls, draw } = coreSetup({ reversedZ: true });
    createCorePost(core, proc);
    const rv = camView();
    const p = rv.proj!;
    const n = 0.5;
    const f = 200;
    p[10] = n / (f - n);
    p[14] = (n * f) / (f - n);
    draw(rv);
    expect(calls[0]!.proj!.rz).toBe(true);
    expect(calls[0]!.proj!.near).toBeCloseTo(n, 5);
    expect(calls[0]!.proj!.far).toBeCloseTo(f, 3);
    // Infinite far: p10 = 0, p14 = near.
    p[10] = 0;
    p[14] = n;
    draw(rv);
    expect(calls[1]!.proj!.near).toBeCloseTo(n, 6);
    expect(calls[1]!.proj!.far).toBe(Number.POSITIVE_INFINITY);
  });

  it('the stack packs the convention into quality.w; standard Z stays 0', () => {
    const { stack, inputs, frame } = stackSetup({ ao: { enabled: true } });
    frame();
    expect(uniforms(stack)[QUALITY + 3]).toBe(0);
    inputs.projection!.reversedZ = true;
    frame();
    expect(uniforms(stack)[QUALITY + 3]).toBe(1);
  });
});

describe('smaller items (ws/post-fit item 6)', () => {
  it('a pass with coreTargets false draws without the extra targets', () => {
    const { core, proc, draw } = coreSetup({ targets: ['emissive', 'velocity'] });
    createCorePost(core, proc);
    const aux: number[] = [];
    core.definePass({
      id: 'sky',
      after: 'opaque',
      coreTargets: false,
      encode: (_p, ctx) => aux.push(ctx.aux),
    });
    core.definePass({ id: 'fx', after: 'sky', encode: (_p, ctx) => aux.push(ctx.aux) });
    draw(camView());
    expect(aux).toEqual([0, core.targetMask]);
  });

  it('times the post passes through the core target’s timestamps', () => {
    const { core, proc, target, draw } = coreSetup();
    createCorePost(core, proc);
    const seen: string[] = [];
    draw(camView(), {
      ...target,
      timestamps: (label, pass) => {
        seen.push(`${label}/${pass}`);
        return undefined;
      },
    });
    expect(seen).toContain('taa/post');
  });

  it('builds an rgba16float LUT and rewrites one in place', () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const t = createLutTexture(device, 16, (r, g, b) => [r, g, b], 'rgba16float');
    expect(t.format).toBe('rgba16float');
    const w = fake.textureWrites.at(-1)!;
    expect(w.bytesPerRow).toBe(16 * 8);
    expect((w.data as Uint16Array).length).toBe(16 * 16 * 16 * 4);
    const half = lutTexelsHalf(16, (r, g, b) => [r, g, b]);
    expect(half[4 * 15]).toBe(toHalf(1));
    expect(half[3]).toBe(0x3c00);
    writeLutTexture(device, t, () => [0.5, 0.25, 2]);
    expect(fake.textureWrites.at(-1)!.texture).toBe(t as unknown as FakeView['texture']);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(2 ** -24)).toBe(1);
  });

  it('origin-relative matrices keep the frame, moved to the core’s origin', () => {
    const { core, proc, calls, draw } = coreSetup({ originGrid: 64 });
    createCorePost(core, proc, { relativeToOrigin: true });
    const rv = camView(1000);
    draw(rv);
    const rv2 = camView(1100);
    draw(rv2);
    const o = core.origin;
    expect(o[0]).toBe(1088);
    // A world point through the absolute matrix = the point minus the origin through the relative one.
    const pt = [1100, 0.5, -5];
    const clip = (m: Float32Array, x: number, y: number, z: number) => [
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
    ];
    const abs = clip(rv2.viewProj, pt[0]!, pt[1]!, pt[2]!);
    const rel = clip(calls[1]!.view.viewProj, pt[0]! - o[0]!, pt[1]!, pt[2]!);
    for (let k = 0; k < 3; k++) expect(rel[k]).toBeCloseTo(abs[k]!, 3);
    // Last frame's matrix, moved to this frame's origin.
    const prevAbs = clip(rv.viewProj, pt[0]!, pt[1]!, pt[2]!);
    const prevRel = clip(calls[1]!.view.previousViewProj, pt[0]! - o[0]!, pt[1]!, pt[2]!);
    for (let k = 0; k < 3; k++) expect(prevRel[k]).toBeCloseTo(prevAbs[k]!, 3);
  });
});
