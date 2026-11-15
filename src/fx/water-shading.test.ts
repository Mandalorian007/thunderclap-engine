/**
 * ws/water-split (E18): a water without its plane builds no plane (`Water` with `plane: false`
 * neither builds nor warms the plane's pipeline), and `WaterShading`, the look-only water,
 * shades a game's set with the same WGSL and blocks as a `Water` of the same settings.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createRenderCore } from '../render/core/core';
import { createVertexLayout } from '../render/core/layout';
import { createRenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice } from '../render/fake-gpu';
import { Water } from './water';
import { waterReflectionKnob } from './water-core';
import { WaterShading, waterShadeReads } from './water-shading';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});

/** A game's shading that reads a group of its look's set (not in the plane's layout). */
const SHADE =
  '@group(2) @binding(0) var<uniform> game_tint: vec4f;\n' +
  'fn water_shade(frag: vec2f, ndc: vec2f, world: vec3f, up: vec3f) -> WaterShade {\n' +
  '  var s = water_shade_engine(frag, ndc, world, up);\n' +
  '  s.color = vec4f(s.color.rgb * game_tint.rgb, s.color.a);\n' +
  '  return s;\n}';

const FS =
  '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n' +
  '@fragment fn fs(@builtin(position) p: vec4f) -> WaterLookOut {\n' +
  '  return water_look_out(water_look(p, vec3f(0.0), vec3f(0.0, 1.0, 0.0)));\n}';

function rig() {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const modules: string[] = [];
  const pipelines: string[] = [];
  const dev = fake.device as unknown as {
    createShaderModule: (d: GPUShaderModuleDescriptor) => unknown;
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => unknown;
  };
  const mod = dev.createShaderModule;
  const pipe = dev.createRenderPipeline;
  dev.createShaderModule = (d) => {
    modules.push(d.label ?? '');
    return mod(d);
  };
  dev.createRenderPipeline = (d) => {
    pipelines.push(d.label ?? '');
    return pipe(d);
  };
  const core = createRenderCore(device);
  const c = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
  c.lookAt([0, 4, 10], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), c);
  const texture = device.createTexture({
    size: [64, 64],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const frame = () => {
    const enc = device.createCommandEncoder();
    core.prepare(enc, [view]);
    core.draw(enc, 0, {
      view: texture.createView(),
      texture,
      format: 'rgba8unorm',
      width: 64,
      height: 64,
    });
    device.queue.submit([enc.finish()]);
  };
  return { fake, device, core, frame, modules, pipelines, view, camera: c };
}

/** The last bytes written to the buffer labelled `label`, as floats. */
function lastWrite(r: ReturnType<typeof rig>, label: string): number[] {
  for (let i = r.fake.writes.length - 1; i >= 0; i--) {
    if (r.fake.writes[i]!.buffer.label !== label) continue;
    const d = r.fake.writeData[i]!.data as Float32Array;
    return Array.from(d);
  }
  throw new Error(`no write to ${label}`);
}

describe('a water without its plane (ws/water-split)', () => {
  it('plane: false neither builds nor warms the plane, with a game’s own shading', () => {
    const r = rig();
    const water = new Water(r.core, { plane: false, shade: SHADE });
    expect(r.core.warming).toBe(true);
    r.frame();
    r.frame();
    expect(r.fake.errors).toEqual([]);
    expect(r.modules.filter((l) => l.startsWith('water-core'))).toEqual([]);
    expect(r.pipelines.filter((l) => l.startsWith('water-core'))).toEqual([]);
    const warmed = r.fake.warmPasses.flatMap((p) => p.commands);
    expect(warmed.filter((c) => c.op === 'setPipeline')).toEqual([]);
    // Its look still shades a set, and the plane comes back when turned on.
    expect(water.look().wgsl).toContain('game_tint.rgb');
    water.plane = true;
    r.frame();
    expect(r.pipelines.filter((l) => l === 'water-core')).toHaveLength(1);
    water.destroy();
  });

  it('WaterShading: the same look and blocks as a Water, no plane, never active', () => {
    const opts = { level: 2, refraction: 0.5, reflectionSteps: 8, depthFade: 3, shade: SHADE };
    const ref = rig();
    const water = new Water(ref.core, { ...opts, plane: false });
    const r = rig();
    const shading = new WaterShading(r.core, opts);
    expect(r.core.coreDrawables).toEqual([shading]);
    expect(shading.active).toBe(false);
    expect(shading.readsColor).toBe(true);
    const look = shading.look(1);
    expect(shading.look(1)).toBe(look);
    expect(look.wgsl).toBe(water.look(1).wgsl);
    expect(look.readsColor).toBe(true);
    expect(look.writes).toEqual(['roughMetal', 'velocity']);
    const vertices = r.core.createArena({ kind: 'vertex', blockBytes: 1 << 16 });
    const tint = r.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    const set = r.core.createDrawSet({
      label: 'lake',
      shader: { code: look.wgsl + FS, blend: look.blend, writes: look.writes },
      vertexLayout: PACKED,
      vertices,
      capacity: 4,
      cull: 'gpu',
      pass: 'transparent',
      bindGroups: [
        look.bindGroup,
        {
          layout: tint,
          group: r.device.createBindGroup({
            layout: tint,
            entries: [
              {
                binding: 0,
                resource: { buffer: r.device.createBuffer({ size: 16, usage: 64 }) },
              },
            ],
          }),
        },
      ],
      readsDepth: look.readsDepth,
      readsColor: look.readsColor,
    });
    set.add({ vertices: vertices.alloc(64, 8), indexCount: 6, bounds: [0, 0, 0, 1] });
    for (let f = 0; f < 3; f++) {
      water.update(0.25);
      shading.update(0.25);
      ref.frame();
      r.frame();
    }
    expect(r.fake.errors).toEqual([]);
    expect(r.modules.filter((l) => l.startsWith('water'))).toEqual([]);
    expect(r.pipelines.filter((l) => l.startsWith('water'))).toEqual([]);
    // The params block uploads every frame the clock moves; the core block once (unchanged).
    expect(r.fake.writes.filter((w) => w.buffer.label === 'water-params')).toHaveLength(3);
    expect(r.fake.writes.filter((w) => w.buffer.label === 'water-core')).toHaveLength(1);
    expect(ref.fake.writes.filter((w) => w.buffer.label === 'water-core')).toHaveLength(1);
    expect(lastWrite(r, 'water-params')).toEqual(lastWrite(ref, 'water-params'));
    expect(lastWrite(r, 'water-core')).toEqual(lastWrite(ref, 'water-core'));
    // The reflection knob takes it as it takes a Water.
    const knob = waterReflectionKnob([shading]);
    knob.step(true);
    expect(shading.reflectionSteps).toBe(0);
    knob.step(false);
    expect(shading.reflectionSteps).toBe(8);
    shading.destroy();
    expect(r.core.coreDrawables).toEqual([]);
  });

  it('uploads nothing over idle frames, and a block only when a value in it changed', () => {
    const WATCHED = ['water-params', 'water-core', 'core view extras'];
    const watched = (r: ReturnType<typeof rig>, from: number) =>
      r.fake.writes.slice(from).filter((w) => WATCHED.includes(w.buffer.label ?? ''));
    const bare = rig();
    const r = rig();
    const shading = new WaterShading(r.core);
    expect(shading.reads).toEqual({ params: true, core: true, view: true });
    bare.frame();
    r.frame();
    // The first frame uploads all three.
    expect(
      watched(r, 0)
        .map((w) => w.buffer.label)
        .sort(),
    ).toEqual([...WATCHED].sort());
    // Idle frames: no write at all beyond what the core alone makes.
    let at = r.fake.writes.length;
    let bareAt = bare.fake.writes.length;
    for (let f = 0; f < 5; f++) {
      bare.frame();
      r.frame();
    }
    expect(watched(r, at)).toEqual([]);
    expect(r.fake.writes.length - at).toBe(bare.fake.writes.length - bareAt);
    // The clock moves: the params alone.
    at = r.fake.writes.length;
    shading.update(0.1);
    r.frame();
    expect(watched(r, at).map((w) => w.buffer.label)).toEqual(['water-params']);
    // The sun's colour changes: the core block alone.
    at = r.fake.writes.length;
    shading.sunColor[0] = 2;
    r.frame();
    expect(watched(r, at).map((w) => w.buffer.label)).toEqual(['water-core']);
    // The camera moves: the view extras alone.
    at = r.fake.writes.length;
    r.camera.lookAt([1, 4, 10], [0, 0, 0]);
    setViewFromCamera(r.view, r.camera);
    r.frame();
    expect(watched(r, at).map((w) => w.buffer.label)).toEqual(['core view extras']);
    at = r.fake.writes.length;
    bareAt = bare.fake.writes.length;
    r.frame();
    bare.frame();
    expect(r.fake.writes.length - at).toBe(bare.fake.writes.length - bareAt);
    expect(r.fake.errors).toEqual([]);
    shading.destroy();
  });

  it('a game’s shading that reads none of the blocks uploads none of them', () => {
    const own =
      'fn water_shade(frag: vec2f, ndc: vec2f, world: vec3f, up: vec3f) -> WaterShade {\n' +
      '  // Not the engine water: no water.misc, no wc, no extras.\n' +
      '  var s: WaterShade;\n  s.color = vec4f(0.1, 0.3, 0.5, 0.8);\n  return s;\n}';
    const r = rig();
    const shading = new WaterShading(r.core, { shade: own, refraction: 0, reflectionSteps: 0 });
    expect(shading.reads).toEqual({ params: false, core: false, view: false });
    for (let f = 0; f < 3; f++) {
      shading.update(0.1);
      r.camera.lookAt([f, 4, 10], [0, 0, 0]);
      setViewFromCamera(r.view, r.camera);
      r.frame();
    }
    const labels = new Set(r.fake.writes.map((w) => w.buffer.label));
    expect(labels.has('water-params') || labels.has('water-core')).toBe(false);
    expect(labels.has('core view extras')).toBe(false);
    // `blocks: 'all'` keeps them all current, for a set whose own WGSL reads them.
    const all = new WaterShading(r.core, { shade: own, blocks: 'all' });
    expect(all.reads).toEqual({ params: true, core: true, view: true });
    r.frame();
    expect(r.fake.writes.some((w) => w.buffer.label === 'core view extras')).toBe(true);
    shading.destroy();
    all.destroy();
  });

  it('finds the blocks a shading reaches through the functions it calls', () => {
    const shade = (body: string, extra = '') =>
      `${extra}fn water_shade(frag: vec2f, ndc: vec2f, world: vec3f, up: vec3f) -> WaterShade {\n${body}\n}`;
    expect(waterShadeReads(undefined)).toEqual({ params: true, core: true, view: true });
    expect(waterShadeReads(shade('return water_shade_engine(frag, ndc, world, up);'))).toEqual({
      params: true,
      core: true,
      view: true,
    });
    expect(
      waterShadeReads(shade('let f = water_field(world.xz, 0.0);\nvar s: WaterShade;\nreturn s;')),
    ).toEqual({ params: true, core: false, view: false });
    expect(
      waterShadeReads(
        shade(
          'let p = my_pos(ndc);\nvar s: WaterShade;\nreturn s;',
          'fn my_pos(ndc: vec2f) -> vec3f { return w_unproject(ndc, 0.5); }\n',
        ),
      ),
    ).toEqual({ params: false, core: false, view: true });
    expect(
      waterShadeReads(shade('var s: WaterShade;\ns.color = wc.sky; /* water */\nreturn s;')),
    ).toEqual({ params: false, core: true, view: false });
    // A helper nobody calls reads nothing.
    expect(
      waterShadeReads(
        shade('var s: WaterShade;\nreturn s;', 'fn unused() -> f32 { return water.misc.x; }\n'),
      ),
    ).toEqual({ params: false, core: false, view: false });
  });
});
