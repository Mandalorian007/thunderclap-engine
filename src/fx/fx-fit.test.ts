/**
 * ws/fx-fit: the fx drawables fit a 3D game's renderer (fake GPU). They follow the pass's depth
 * convention (reversed-Z from the core, never a per-drawable flag), the sky pass takes the
 * game's own shade function, weather wraps its occlusion map and splashes, lightning strikes,
 * particles can be lit cubes, and a draw set's shadow pipeline can have its own vertex entry.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import {
  type CoreTarget,
  createRenderCore,
  type RenderCore,
  type RenderCoreOptions,
} from '../render/core/core';
import { createVertexLayout } from '../render/core/layout';
import { coreDepthCompare } from '../render/core/pass-list';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { DEPTH_FORMAT } from '../render/material';
import { Renderer } from '../render/renderer';
import { createWorkMeter } from '../testing/budget';
import { Decals } from './decals';
import { FX_DEPTH_WGSL, FxDepthModules, fxDepthCode } from './depth';
import { LIGHTNING_SEGMENTS, LIGHTNING_STRANDS, Lightning, lightningFlash } from './lightning';
import { ParticleSystem } from './particles';
import { PARTICLE_CORE_BOX_WGSL } from './particles-wgsl';
import { Sky } from './sky';
import { createSkyPass, SKY_PASS_WGSL, skyHorizonColor } from './sky-pass';
import { Water } from './water';
import { WEATHER_RAIN, WEATHER_RAIN_SPLASHES, Weather } from './weather';
import { WEATHER_WGSL } from './weather-wgsl';

interface Rig {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  eyes: RenderView[];
  target: CoreTarget;
  modules: { label?: string; code: string }[];
}

function rig(opts: RenderCoreOptions = {}, device?: GPUDevice): Rig {
  const fake = createFakeDevice();
  const dev = device ?? (fake.device as unknown as GPUDevice);
  const modules: { label?: string; code: string }[] = [];
  const make = fake.device.createShaderModule.bind(fake.device);
  (fake.device as unknown as { createShaderModule: unknown }).createShaderModule = (
    d: GPUShaderModuleDescriptor,
  ) => {
    modules.push({ label: d.label, code: d.code });
    return make(d);
  };
  const core = createRenderCore(dev, opts);
  const eye = (x: number) => {
    const c = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
    c.lookAt([x, 2, 10], [x, 0, 0]);
    return setViewFromCamera(createRenderView(), c);
  };
  const texture = dev.createTexture({
    size: [200, 100],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = dev.createTexture({
    size: [200, 100],
    format: 'depth32float',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });
  const target: CoreTarget = {
    view: texture.createView(),
    texture,
    format: 'rgba8unorm',
    width: 200,
    height: 100,
    depth: depth.createView(),
    clearDepth: true,
  };
  return { fake, device: dev, core, eyes: [eye(-0.032), eye(0.032)], target, modules };
}

/** The index of the last write to the buffer labelled `label` (-1 for none). */
function lastWrite(f: FakeDevice, label: string): number {
  for (let i = f.writes.length - 1; i >= 0; i--) if (f.writes[i]!.buffer.label === label) return i;
  return -1;
}

const BURST = {
  x: 0,
  y: 1,
  z: 0,
  speed: [1, 2] as [number, number],
  colorStart: [1, 0.6, 0.2, 1] as [number, number, number, number],
};

function stereo(r: Rig): void {
  const enc = r.device.createCommandEncoder();
  r.core.prepare(enc, [{ views: r.eyes }]);
  r.core.draw(enc, 0, { ...r.target, viewport: { x: 0, y: 0, width: 100, height: 100 } });
  r.core.draw(enc, 1, { ...r.target, viewport: { x: 100, y: 0, width: 100, height: 100 } });
  r.device.queue.submit([enc.finish()]);
}

/** Every render pipeline a frame's passes and bundles set, by label. */
function pipelines(f: FakeDevice): Map<string, GPURenderPipelineDescriptor[]> {
  const out = new Map<string, GPURenderPipelineDescriptor[]>();
  const take = (cmds: { op: string; pipeline?: unknown }[]) => {
    for (const c of cmds) {
      if (c.op !== 'setPipeline') continue;
      const d = (c.pipeline as { desc: GPURenderPipelineDescriptor }).desc;
      const k = String(d.label).split(':')[0]!;
      const list = out.get(k) ?? [];
      if (!list.includes(d)) list.push(d);
      out.set(k, list);
    }
  };
  for (const p of f.passes) if (p.kind === 'render') take(p.commands as never);
  for (const b of f.bundles) take(b.commands as never);
  return out;
}

function compares(f: FakeDevice): Record<string, GPUCompareFunction[]> {
  const o: Record<string, GPUCompareFunction[]> = {};
  for (const [k, list] of pipelines(f)) {
    o[k] = list.map((d) => d.depthStencil?.depthCompare ?? 'always');
  }
  return o;
}

/** Every fx drawable and the sky pass on one core. */
function everything(r: Rig) {
  const renderer = {
    device: r.fake.device,
    globalsLayout: r.fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    sceneTargets: () => [],
    target: { auxKey: 0 },
  } as unknown as Renderer;
  const sky = createSkyPass(r.core, new Sky(renderer, { stars: true }));
  const weather = new Weather(r.core, { ...WEATHER_RAIN_SPLASHES, occlusionHeight: 0 });
  const lightning = new Lightning(r.core);
  lightning.strike(0, 0, 0, 7);
  lightning.update(0.05);
  const ps = new ParticleSystem(r.core, { capacity: 64, softness: 0.5 });
  ps.emit(BURST, 8);
  const water = new Water(r.core, { size: 40 });
  const atlas = {
    view: r.device
      .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
      .createView(),
    width: 4,
    height: 4,
  };
  const decals = new Decals(r.core, { texture: atlas });
  decals.add({ position: [0, 0, 0], size: [2, 2, 2] } as never);
  const quads = new Decals(r.core, { texture: atlas, mode: 'quad' });
  quads.add({ position: [0, 0, 0], size: [2, 2, 2] } as never);
  sky.prepare();
  return { sky, weather, lightning, ps, water, decals, quads };
}

describe('the depth convention (ws/fx-fit)', () => {
  it("fx use the core's one compare: less-equal standard, greater-equal reversed", () => {
    expect(coreDepthCompare(false, true)).toBe('less-equal');
    expect(coreDepthCompare(true, true)).toBe('greater-equal');
  });

  it('fxDepthCode flips the WGSL constant once, and only for a reversed pass', () => {
    const code = `${FX_DEPTH_WGSL}\nfn f() {}`;
    expect(fxDepthCode(code, false)).toBe(code);
    expect(fxDepthCode(code, true)).toContain('const FX_REVERSED_Z = true;');
    expect(fxDepthCode(code, true)).not.toContain('const FX_REVERSED_Z = false;');
    expect(() => fxDepthCode('fn f() {}', true)).toThrow(/FX_DEPTH_WGSL/);
    // `select(a < b, a > b, …)` parses as a template list in Tint: every comparison is wrapped.
    expect(FX_DEPTH_WGSL).not.toMatch(/[(,]\s*\w+\s*<\s*[\w.]+\s*,/);
    const r = rig();
    const m = new FxDepthModules(r.device, code, 'm');
    expect(m.get(false)).toBe(m.get(false));
    expect(r.modules.map((x) => x.label)).toEqual(['m']);
    expect(m.get(true)).toBe(m.get(true));
    expect(r.modules.map((x) => x.label)).toEqual(['m', 'm (reversed-Z)']);
  });

  it('a standard core: every fx drawable and the sky test less-equal (unchanged defaults)', () => {
    const r = rig();
    everything(r);
    stereo(r);
    expect(r.fake.errors.map(String)).toEqual([]);
    expect(compares(r.fake)).toEqual({
      'sky pass': ['less-equal'],
      weather: ['less-equal'],
      lightning: ['less-equal'],
      'particles-core': ['less-equal'],
      'water-core': ['less-equal'],
      'decals-core': ['always', 'less-equal'],
    });
    // No reversed module was made: the defaults compile what they always did.
    expect(r.modules.some((m) => m.label?.includes('reversed-Z'))).toBe(false);
    expect(r.modules.find((m) => m.label === 'sky pass')!.code).toBe(SKY_PASS_WGSL);
  });

  it('a reversed-Z core: every fx drawable and the sky follow it, from the pass alone', () => {
    const r = rig({ reversedZ: true });
    everything(r);
    stereo(r);
    expect(r.fake.errors.map(String)).toEqual([]);
    expect(compares(r.fake)).toEqual({
      'sky pass': ['greater-equal'],
      weather: ['greater-equal'],
      lightning: ['greater-equal'],
      'particles-core': ['greater-equal'],
      'water-core': ['greater-equal'],
      'decals-core': ['always', 'greater-equal'],
    });
    // The depth-reading shaders were compiled reversed: far is 0, nearer is greater.
    const rev = r.modules.filter((m) => m.label?.endsWith('(reversed-Z)')).map((m) => m.label);
    expect(rev.sort()).toEqual([
      'decals-core-box (reversed-Z)',
      'decals-core-quad (reversed-Z)',
      'particles-core (reversed-Z)',
      'sky pass (reversed-Z)',
      'water-core (reversed-Z)',
    ]);
    for (const m of r.modules.filter((x) => x.label?.endsWith('(reversed-Z)'))) {
      expect(m.code).toContain('const FX_REVERSED_Z = true;');
    }
  });

  it('a pass that opts out of the core default draws standard', () => {
    const r = rig({ reversedZ: true });
    r.core.passes.define({ id: 'fx', after: 'transparent', reversedZ: false });
    new Weather(r.core, { ...WEATHER_RAIN, pass: 'fx' });
    stereo(r);
    expect(compares(r.fake).weather).toEqual(['less-equal']);
  });

  it('CoreViewExtras: the forward axis stays finite under an infinite reversed-Z projection', () => {
    const r = rig({ reversedZ: true });
    const p = new Float32Array(16);
    // Infinite reversed-Z: z_clip = near, w_clip = -z_eye.
    const f = 1 / Math.tan(Math.PI / 6);
    p[0] = f;
    p[5] = f;
    p[11] = -1;
    p[14] = 0.1;
    const cam = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
    cam.lookAt([0, 2, 10], [0, 0, 0]);
    cam.setProjection(p);
    r.eyes = [setViewFromCamera(createRenderView(), cam)];
    const ps = new ParticleSystem(r.core, { capacity: 16 });
    // Something alive: an idle system writes nothing (ws/fx-fit, B14).
    ps.emit(BURST, 1);
    const enc = r.device.createCommandEncoder();
    r.core.prepare(enc, [{ views: r.eyes }]);
    r.core.draw(enc, 0, r.target);
    const extras = r.fake.writes.findIndex((w) => w.buffer.label === 'core view extras');
    expect(extras).toBeGreaterThanOrEqual(0);
    const d = r.fake.writeData[extras]!.data as Float32Array;
    const fwd = [d[24]!, d[25]!, d[26]!];
    for (const v of fwd) expect(Number.isFinite(v)).toBe(true);
    // Looking down -z from (0, 2, 10) towards the origin.
    expect(fwd[2]!).toBeLessThan(-0.9);
    ps.destroy();
  });
});

describe('the sky pass shade hook (ws/fx-fit)', () => {
  const renderer = (fake: FakeDevice) =>
    ({
      device: fake.device,
      globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
      sceneFormats: ['rgba16float', 'rgba16float'],
      sceneTargets: () => [],
      target: { auxKey: 0 },
    }) as unknown as Renderer;

  const SHADE = /* wgsl */ `
fn sky_look(i: SkyInput) -> SkyShade {
  var s = sky_shade(i.dir, i.sun_dir, i.sun_color, i.fog);
  s.color += sky_param(0u).rgb * sin(i.time) + textureLoad(clouds, vec2i(0), 0).rgb;
  return s;
}`;

  it('compiles the game function with the built-ins, a hook block and the game group', () => {
    const r = rig();
    let layouts = 0;
    const pass = createSkyPass(r.core, new Sky(renderer(r.fake)), {
      shade: `@group(2) @binding(0) var clouds: texture_2d<f32>;\n${SHADE}`,
      params: 2,
      groupLayout: (device) => {
        layouts++;
        return device.createBindGroupLayout({
          label: 'clouds',
          entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }],
        });
      },
    });
    expect(layouts).toBe(1);
    const code = r.modules.find((m) => m.label === 'sky pass')!.code;
    for (const s of [
      'struct SkyInput',
      'fn sky_look(i: SkyInput)',
      'sky_look(sky_input(d))',
      'fn sky_dome(',
      'fn sky_sun(',
      'fn sky_day(',
      'user: array<vec4f, 2>',
    ]) {
      expect(code).toContain(s);
    }
    expect(code).not.toContain('let s = sky_shade(d,');
    expect(pass.params.length).toBe(8);
    // No game group yet: nothing drawn.
    pass.prepare();
    stereo(r);
    expect(pass.draws).toBe(0);
    pass.gameGroup = r.device.createBindGroup({ layout: pass.gameLayout!, entries: [] });
    pass.time = 2.5;
    pass.params.set([1, 0.5, 0, 0]);
    pass.prepare();
    stereo(r);
    expect(pass.draws).toBe(2);
    const sky = r.fake.passes.filter((p) => p.kind === 'render').flatMap((p) => p.commands);
    const binds = sky.filter((c) => c.op === 'setBindGroup') as { index: number }[];
    expect(new Set(binds.map((b) => b.index))).toEqual(new Set([0, 1, 2]));
    const hook = lastWrite(r.fake, 'sky pass hook');
    const data = r.fake.writeData[hook]!.data as Float32Array;
    expect([...data.slice(0, 8)]).toEqual([2.5, 0, 0, 0, 1, 0.5, 0, 0]);
    expect(r.fake.errors).toEqual([]);
  });

  it('without a hook: the default shader and two-binding group, unchanged', () => {
    const r = rig();
    const pass = createSkyPass(r.core, new Sky(renderer(r.fake)));
    expect(pass.params.length).toBe(0);
    expect(pass.gameLayout).toBeNull();
    expect(r.modules.find((m) => m.label === 'sky pass')!.code).toBe(SKY_PASS_WGSL);
    expect(r.fake.buffers.some((b) => b.label === 'sky pass hook')).toBe(false);
    expect(() =>
      createSkyPass(r.core, new Sky(renderer(r.fake)), { shade: '', params: 17 }),
    ).toThrow(/params/);
  });

  it('the horizon colour mirrors the dome and follows day, night and fog', () => {
    const r = rig();
    const look = new Sky(renderer(r.fake), { horizon: [0.6, 0.7, 0.8], exposure: 1 });
    const pass = createSkyPass(r.core, look);
    pass.sunDir.set([0, -1, 0]);
    pass.prepare();
    expect([...pass.horizon].map((v) => +v.toFixed(4))).toEqual([0.6, 0.7, 0.8]);
    pass.fog.set([1, 0, 0, 1]);
    pass.prepare();
    expect([...pass.horizon].map((v) => +v.toFixed(4))).toEqual([1, 0, 0]);
    // Night: the sun below the horizon dims it to the floor.
    const out = new Float32Array(3);
    skyHorizonColor(look, [0, 1, 0], [1, 1, 1], [0, 0, 0, 0], out);
    expect(out[0]).toBeCloseTo(0.6 * look.ambientFloor, 5);
  });

  it('a hooked sky follows reversed-Z too', () => {
    const r = rig({ reversedZ: true });
    const pass = createSkyPass(r.core, new Sky(renderer(r.fake)), {
      shade:
        'fn sky_look(i: SkyInput) -> SkyShade { return sky_shade(i.dir, i.sun_dir, i.sun_color, i.fog); }',
    });
    pass.prepare();
    stereo(r);
    expect(compares(r.fake)['sky pass']).toEqual(['greater-equal']);
    expect(r.modules.find((m) => m.label === 'sky pass (reversed-Z)')!.code).toContain(
      'fn sky_look(',
    );
  });
});

describe('weather: wrapping map, splashes, lightning (ws/fx-fit)', () => {
  function uniform(f: FakeDevice, label: string): Float32Array {
    for (let i = f.writes.length - 1; i >= 0; i--) {
      if (f.writes[i]!.buffer.label === label) return f.writeData[i]!.data as Float32Array;
    }
    throw new Error(`no ${label} write`);
  }

  it('a wrapping occlusion map is flagged 2 and wraps uv in the shader', () => {
    const r = rig();
    const texture = r.device.createTexture({
      size: [64, 64],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const w = new Weather(r.core, WEATHER_RAIN);
    w.setOcclusionMap({ texture, origin: [-32, -32], size: [64, 64], wrap: true });
    stereo(r);
    expect(uniform(r.fake, 'weather')[9]).toBe(2);
    w.setOcclusionMap({ texture, origin: [-32, -32], size: [64, 64] });
    stereo(r);
    expect(uniform(r.fake, 'weather')[9]).toBe(1);
    expect(WEATHER_WGSL).toContain('uv = fract(uv);');
  });

  it('splashes are a layer: shape 3 in the same instanced draw', () => {
    const r = rig();
    const w = new Weather(r.core, { ...WEATHER_RAIN_SPLASHES, occlusionHeight: 0 });
    stereo(r);
    const d = uniform(r.fake, 'weather');
    expect(d[7]).toBe(2);
    expect(d[16 + 16 + 12]).toBe(3);
    expect(w.instances).toBe(6000 + 400);
    const draws = r.fake.bundles.flatMap((b) => b.commands).filter((c) => c.op === 'drawIndirect');
    expect(draws.length).toBe(1);
    expect(WEATHER_WGSL).toContain('shape == 3u');
  });

  it('lightning: a seeded bolt grows and fades; the flash flickers out; one draw', () => {
    const r = rig();
    const l = new Lightning(r.core);
    expect(l.active).toBe(false);
    l.strike(10, 0, -5, 42);
    expect(l.flash).toBe(1);
    stereo(r);
    const a = uniform(r.fake, 'lightning').slice();
    // The main strand ends at the strike point, on the ground, and starts `height` above it.
    const end = 8 + LIGHTNING_SEGMENTS * 4;
    expect([a[end], a[end + 1], a[end + 2]]).toEqual([10, 0, -5]);
    expect(a[9]).toBeCloseTo(140, 3);
    // The same seed, the same bolt.
    l.strike(10, 0, -5, 42);
    stereo(r);
    expect(uniform(r.fake, 'lightning').slice(8)).toEqual(a.slice(8));
    // Grows over 0.1 s, fades over 0.55 s.
    l.update(0.05);
    stereo(r);
    expect(uniform(r.fake, 'lightning')[4]).toBeCloseTo(0.5, 5);
    l.update(0.7);
    expect(l.active).toBe(false);
    expect(l.flash).toBe(0);
    const draws = r.fake.bundles.flatMap((b) => b.commands).filter((c) => c.op === 'draw') as {
      vertices: number;
      instances: number;
    }[];
    expect(draws[0]).toMatchObject({
      vertices: 6,
      instances: LIGHTNING_STRANDS * LIGHTNING_SEGMENTS,
    });
    expect(lightningFlash(0)).toBe(1);
    expect(lightningFlash(0.45)).toBe(0);
    expect(lightningFlash(-1)).toBe(0);
    expect(r.fake.errors).toEqual([]);
  });

  it('a held strike allocates nothing a frame', () => {
    const fake = createFakeDevice();
    const meter = createWorkMeter(fake.device as unknown as GPUDevice);
    const r = rig({}, meter.device);
    const l = new Lightning(r.core, { fadeTime: 100 });
    l.strike(0, 0, 0, 3);
    const report = meter.run(
      () => {
        l.update(1 / 60);
        stereo(r);
      },
      { frames: 4, warmup: 2 },
    );
    expect(report.allocs.typedArrays + report.allocs.arrayBuffers).toBe(0);
  });
});

describe('lit-box particles (ws/fx-fit)', () => {
  it('draws 36 vertices a particle, culls back faces, binds the box light', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 128, shape: 'box' });
    const d = ps.coreDrawable!;
    expect(d.shape).toBe('box');
    expect(d.readsDepth).toBe(false);
    d.boxLight.sunColor.set([2, 1, 0.5]);
    ps.emit(BURST, 8);
    stereo(r);
    expect(r.fake.errors).toEqual([]);
    // One indirect draw of the live window (B14): 36 vertices, the 8 alive.
    const draws = r.fake.bundles.flatMap((b) => b.commands).filter((c) => c.op.startsWith('draw'));
    expect(draws.map((c) => c.op)).toEqual(['drawIndirect']);
    const args = r.fake.buffers.find((b) => b.label === 'particles-core-draw')!;
    expect([...new Uint32Array(args.data.buffer, args.data.byteOffset, 2)]).toEqual([36, 8]);
    const p = pipelines(r.fake).get('particles-core-box')![0]!;
    expect(p.primitive!.cullMode).toBe('back');
    const light = lastWrite(r.fake, 'particles-core-box-light');
    expect([...(r.fake.writeData[light]!.data as Float32Array).slice(4, 7)]).toEqual([2, 1, 0.5]);
    expect(PARTICLE_CORE_BOX_WGSL).toContain('@group(1) @binding(7) var<uniform> box_light');
    // The quad default is unchanged: 6 vertices, no light block.
    const q = new ParticleSystem(r.core, { capacity: 16 });
    expect(q.coreDrawable!.shape).toBe('quad');
    expect(r.fake.buffers.filter((b) => b.label === 'particles-core-box-light').length).toBe(1);
  });

  it('every cube face winds counter-clockwise seen from outside', () => {
    // The vertex stage's face table, mirrored: face f's axis f / 2, side by f % 2.
    const quad = [
      [-1, -1],
      [1, -1],
      [1, 1],
    ] as const;
    for (let face = 0; face < 6; face++) {
      const axis = Math.floor(face / 2);
      const side = face % 2 === 1 ? 1 : -1;
      const pts = quad.map(([x, y]) =>
        axis === 0 ? [side, x * side, y] : axis === 1 ? [y, side, x * side] : [x, y * side, side],
      );
      const e1 = pts[1]!.map((v, i) => v - pts[0]![i]!);
      const e2 = pts[2]!.map((v, i) => v - pts[0]![i]!);
      const n = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      expect(Math.sign(n[axis]!)).toBe(side);
    }
    expect(PARTICLE_CORE_BOX_WGSL).toContain('local = vec3f(side, q.x * side, q.y);');
    expect(PARTICLE_CORE_BOX_WGSL).toContain('local = vec3f(q.y, side, q.x * side);');
    expect(PARTICLE_CORE_BOX_WGSL).toContain('local = vec3f(q.x, q.y * side, side);');
  });
});

describe('DrawSetShader.shadowVertexEntry (ws/fx-fit)', () => {
  it("the shadow pipeline uses its own vertex entry; the colour pipeline keeps 'vs'", () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    r.camera = Camera.perspective(Math.PI / 2, 1, 0.1, 100);
    r.camera.depthTest = true;
    const core = createRenderCore(r, { depthFormat: DEPTH_FORMAT });
    r.core = core;
    const vertices = core.createArena({ kind: 'vertex', blockBytes: 4096 });
    const box = vertices.alloc(24 * 8, 8);
    const sun = r.coreShadow;
    const set = core.createDrawSet({
      label: 'terrain',
      shader: {
        code:
          '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n' +
          '@vertex fn vs_shadow(in: VertexIn) -> @builtin(position) vec4f { return vec4f(1.0); }\n' +
          '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
        shadowVertexEntry: 'vs_shadow',
      },
      bindGroups: [{ layout: sun.layout, group: sun.group }],
      vertexLayout: createVertexLayout({
        stride: 8,
        attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
      }),
      vertices,
      capacity: 8,
      cull: 'cpu',
      pass: 'opaque',
    });
    set.add({ vertices: box, indexCount: 36, bounds: [0, 0, -5, 1] });
    const f = r.beginFrame(0, 0);
    f.lights.sun.direction = [0.2, -1, 0.1];
    f.lights.sun.shadow = { extent: 20, size: 1024 };
    r.endFrame();
    const used = [
      ...fake.passes.flatMap((p) => p.commands),
      ...fake.bundles.flatMap((b) => b.commands),
    ]
      .filter((c) => c.op === 'setPipeline')
      .map((c) => (c as { pipeline: { desc: GPURenderPipelineDescriptor } }).pipeline.desc)
      .filter((d) => d.label === 'terrain');
    const shadow = used.find((d) => !d.fragment)!;
    const color = used.find((d) => d.fragment)!;
    expect(shadow.vertex.entryPoint).toBe('vs_shadow');
    expect(color.vertex.entryPoint).toBe('vs');
    expect(fake.errors).toEqual([]);
  });
});
