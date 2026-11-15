/**
 * ws/scene-read-fit: water as a look over a game's own geometry (fake GPU). A draw set takes the
 * look's WGSL, group, blend and writes, reads the scene through the core's scene-read group, and
 * the water without its plane keeps preparing its block for the look.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createRenderCore } from '../render/core/core';
import { createVertexLayout } from '../render/core/layout';
import { createRenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type PassCommand } from '../render/fake-gpu';
import { Water } from './water';
import { WATER_CORE_WGSL, waterCoreWgsl, waterLookWgsl } from './water-wgsl';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});

function rig(reversedZ = false) {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device, { reversedZ });
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
  return { fake, device, core, frame };
}

const FS =
  '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n' +
  '@fragment fn fs(@builtin(position) p: vec4f) -> WaterLookOut {\n' +
  '  return water_look_out(water_look(p, vec3f(0.0), vec3f(0.0, 1.0, 0.0)));\n}';

describe('a water look (ws/scene-read-fit)', () => {
  it('shades a draw set through the scene-read group, the plane off', () => {
    const r = rig();
    const water = new Water(r.core, { plane: false });
    const look = water.look();
    expect(water.look()).toBe(look);
    expect(look.readsDepth).toBe(true);
    expect(look.readsColor).toBe(true);
    expect(look.writes).toEqual(['roughMetal', 'velocity']);
    expect(look.wgsl).toContain('@group(1) @binding(0) var<uniform> water: WaterParams;');
    expect(look.wgsl).toContain('textureLoad(core_scene_depth');
    expect(look.wgsl).not.toMatch(/[^_]scene_depth/);
    const vertices = r.core.createArena({ kind: 'vertex', blockBytes: 1 << 16 });
    const set = r.core.createDrawSet({
      label: 'lake',
      shader: { code: look.wgsl + FS, blend: look.blend, writes: look.writes },
      vertexLayout: PACKED,
      vertices,
      capacity: 4,
      cull: 'gpu',
      pass: 'transparent',
      bindGroups: [look.bindGroup],
      readsDepth: look.readsDepth,
      readsColor: look.readsColor,
    });
    set.add({ vertices: vertices.alloc(64, 8), indexCount: 6, bounds: [0, 0, 0, 1] });
    r.frame();
    r.frame();
    expect(r.fake.errors).toEqual([]);
    expect(water.coreDrawable!.active).toBe(false);
    const bundle = r.fake.bundles.find((b) =>
      b.commands.some(
        (c) => c.op === 'setBindGroup' && (c as { group: unknown }).group === look.bindGroup.group,
      ),
    )!;
    const binds = bundle.commands.filter((c: PassCommand) => c.op === 'setBindGroup') as {
      index: number;
      group: unknown;
    }[];
    expect(binds.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(binds[2]!.group).toBe(r.core.sceneRead.group);
    // The plane draws no index buffer, the params still upload each frame; the core block
    // only when it changed (ws/g6-asks: once here).
    expect(
      r.fake.writes.filter((w) => w.buffer.label === 'water-params').length,
    ).toBeGreaterThanOrEqual(2);
    expect(r.fake.writes.filter((w) => w.buffer.label === 'water-core')).toHaveLength(1);
  });

  it('a group past the set’s own, reversed depth, no colour', () => {
    const r = rig(true);
    const water = new Water(r.core, { refraction: 0, reflectionSteps: 0 });
    const look = water.look(2);
    expect(look.readsColor).toBe(false);
    expect(look.wgsl).toContain('@group(2) @binding(2) var<storage, read> extras');
    expect(look.wgsl).toContain('const FX_REVERSED_Z = true;');
    expect(water.coreDrawable!.active).toBe(true);
  });

  it('a game’s own shading replaces the engine’s in the plane and every look (B24)', () => {
    expect(waterCoreWgsl()).toBe(WATER_CORE_WGSL);
    const SHADE =
      'fn water_shade(frag: vec2f, ndc: vec2f, world: vec3f, up: vec3f) -> WaterShade {\n' +
      '  var s = water_shade_engine(frag, ndc, world, up);\n' +
      '  s.color = vec4f(s.color.rgb * 0.5 + textureLoad(scene_depth, vec2i(frag), 0) * 0.0, s.color.a);\n' +
      '  return s;\n}';
    const r = rig();
    const water = new Water(r.core, { shade: SHADE });
    const look = water.look();
    expect(look.wgsl).toBe(waterLookWgsl(1, SHADE));
    expect(look.wgsl).toContain('fn water_shade_engine(');
    expect(look.wgsl).toContain('textureLoad(core_scene_depth, vec2i(frag)');
    expect(look.wgsl.match(/fn water_shade\(/g)).toHaveLength(1);
    expect(look.wgsl).not.toMatch(/[^_]scene_depth/);
    r.frame();
    expect(r.fake.errors).toEqual([]);
    const core = waterCoreWgsl(SHADE);
    expect(core.match(/fn water_shade\(/g)).toHaveLength(1);
    expect(core).toContain('s.color.rgb * 0.5');
    expect(waterLookWgsl(1)).not.toContain('water_shade_engine');
  });

  it('the plane’s own shading is the shared function with up = +y', () => {
    expect(WATER_CORE_WGSL).toContain(
      'water_shade(in.clip.xy, in.ndc.xy / in.ndc.w, in.world, vec3f(0.0, 1.0, 0.0))',
    );
    expect(WATER_CORE_WGSL).toContain('normalize(up + vec3f(-f.y, 0.0, -f.z) * max(up.y, 0.0))');
  });
});
