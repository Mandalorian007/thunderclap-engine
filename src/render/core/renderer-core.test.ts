/**
 * ws/core-passes: the retained core drawn inside a `Renderer` frame. Its opaque passes go
 * between the view's opaque and blended draws, into the scene's colour and depth (loaded, never
 * cleared); its transparent passes after the blended draws; one view a frame.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, fakeRendererGpu } from '../fake-gpu';
import type { Frame } from '../frame';
import { DEPTH_FORMAT } from '../material';
import { VERTEX_LAYOUT_3D } from '../mesh';
import { Renderer } from '../renderer';
import { Transform } from '../transform';
import { createRenderCore } from './core';
import { createVertexLayout } from './layout';

const WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> u: vec4f;
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = u; o.emissive = u; return o; }`;
const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const SHADER = {
  code: '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
};

function setup() {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  r.camera = Camera.perspective(Math.PI / 2, 1, 0.1, 100);
  r.camera.depthTest = true;
  const core = createRenderCore(r, { depthFormat: DEPTH_FORMAT });
  r.core = core;
  const vertices = core.createArena({ kind: 'vertex', blockBytes: 4096 });
  const box = vertices.alloc(24 * 8, 8);
  const add = (
    pass: 'opaque' | 'transparent',
    bindGroups?: { layout: GPUBindGroupLayout; group: GPUBindGroup }[],
  ) => {
    const set = core.createDrawSet({
      bindGroups,
      label: pass,
      shader: SHADER,
      vertexLayout: PACKED,
      vertices,
      capacity: 8,
      cull: 'cpu',
      pass,
    });
    set.add({ vertices: box, indexCount: 36, bounds: [0, 0, -5, 1] });
    return set;
  };
  const opaque = r.createMaterial({ label: 'o', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' });
  const glass = r.createMaterial({ label: 'g', wgsl: WGSL, uniformBytes: 16, blend: 'alpha' });
  return { fake, r, add, opaque, glass };
}

const sunOn = (f: Frame): Frame => {
  f.lights.sun.direction = [0.2, -1, 0.1];
  f.lights.sun.shadow = { extent: 20, size: 1024 };
  return f;
};

const labels = (fake: ReturnType<typeof createFakeDevice>, from: number) =>
  fake.passes.slice(from).map((p) => p.label);

describe('the core inside a Renderer frame (ws/core-passes)', () => {
  it('opaque core passes between the opaque and blended draws, transparent after', () => {
    const { fake, r, add, opaque, glass } = setup();
    add('opaque');
    add('transparent');
    const t = new Transform({ z: -3 });
    const from = fake.passes.length;
    const f = r.beginFrame(0, 0);
    f.sprite(opaque, t);
    f.sprite(glass, new Transform({ z: -2 }));
    r.endFrame();
    const seq = labels(fake, from).filter(
      (l) => l === 'scene' || l === 'scene-blend' || l?.startsWith('core'),
    );
    expect(seq).toEqual(['scene', 'core pass', 'scene-blend', 'core pass']);
    expect(r.core!.depth).toBeNull();
    // The core's passes load the scene's depth, in its format, and never clear it.
    const corePasses = fake.passes.slice(from).filter((p) => p.label === 'core pass');
    for (const p of corePasses) {
      const d = (p.desc as GPURenderPassDescriptor).depthStencilAttachment!;
      expect(d.depthLoadOp === 'load' || d.depthReadOnly).toBe(true);
      const color = (p.desc as GPURenderPassDescriptor)
        .colorAttachments as GPURenderPassColorAttachment[];
      expect(color[0]!.loadOp).toBe('load');
    }
    expect(fake.bundles.every((b) => b.desc.depthStencilFormat === DEPTH_FORMAT)).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it('without blended draws the scene pass is not split; an idle core costs nothing', () => {
    const { fake, r, add, opaque } = setup();
    let from = fake.passes.length;
    let f = r.beginFrame(0, 0);
    f.sprite(opaque, new Transform({ z: -3 }));
    r.endFrame();
    expect(labels(fake, from).some((l) => l?.startsWith('core'))).toBe(false);
    add('opaque');
    from = fake.passes.length;
    f = r.beginFrame(0, 0);
    f.sprite(opaque, new Transform({ z: -3 }));
    r.endFrame();
    const seq = labels(fake, from).filter(
      (l) => l === 'scene' || l === 'scene-blend' || l?.startsWith('core'),
    );
    expect(seq).toEqual(['scene', 'core pass']);
  });

  it('a second view in the same frame does not draw the core again', () => {
    const { fake, r, add, opaque } = setup();
    add('opaque');
    const from = fake.passes.length;
    const f = r.beginFrame(0, 0);
    f.sprite(opaque, new Transform({ z: -3 }));
    r.render(f, r.camera);
    r.render(f, r.camera);
    r.endFrame();
    expect(labels(fake, from).filter((l) => l === 'core pass')).toHaveLength(1);
  });

  it("casters draw into the sun's map through its own cull group; receivers bind coreShadow", () => {
    const { fake, r, add } = setup();
    const sun = r.coreShadow;
    const g0 = sun.group;
    // A receiver that casts too: its group holds the map it draws into.
    const set = add('opaque', [{ layout: sun.layout, group: g0 }]);
    expect(set.castShadow).toBe(true);
    expect(add('transparent').castShadow).toBe(false);
    const from = fake.passes.length;
    sunOn(r.beginFrame(0, 0));
    r.endFrame();
    const seq = labels(fake, from).filter((l) => l?.startsWith('core') || l === 'shadow');
    // No immediate casters: the core's own pass clears the map, before the colour passes.
    expect(seq).toEqual(['core shadow', 'core pass', 'core pass']);
    const shadow = fake.passes.slice(from).find((p) => p.label === 'core shadow')!;
    const d = shadow.desc as GPURenderPassDescriptor;
    expect(d.colorAttachments).toEqual([]);
    expect(d.depthStencilAttachment!.depthLoadOp).toBe('clear');
    // The caster drew in it (the sun's cull kept it).
    const ops = shadow.commands.map((c) => c.op);
    expect(ops.includes('drawIndexed') || ops.includes('executeBundles')).toBe(true);
    // Depth-only: no fragment stage (no `shadowFragmentEntry`), both faces, depth written.
    const cmds = [...shadow.commands, ...fake.bundles.flatMap((x) => x.commands)];
    const pipe = cmds.find(
      (c) =>
        c.op === 'setPipeline' &&
        (c.pipeline as { desc: GPURenderPipelineDescriptor }).desc.depthStencil?.format ===
          'depth32float',
    ) as { pipeline: { desc: GPURenderPipelineDescriptor } };
    expect(pipe.pipeline.desc.fragment).toBeUndefined();
    expect(pipe.pipeline.desc.primitive!.cullMode).toBe('none');
    expect(pipe.pipeline.desc.depthStencil!.depthWriteEnabled).toBe(true);
    // The set's own groups (a receiver's may hold this very map) are not bound in it.
    const shadowCmds = [
      ...shadow.commands,
      ...fake.bundles.filter((b) => b.desc.colorFormats.length === 0).flatMap((b) => b.commands),
    ];
    expect(shadowCmds.some((c) => c.op === 'setBindGroup' && c.index > 0)).toBe(false);
    // The map was made: the receiver's group follows it.
    expect(sun.group).not.toBe(g0);
    expect(r.core!.groups).toBe(2);
    expect(fake.errors).toEqual([]);
  });

  it('with immediate casters too, the core draws over their map (loaded)', () => {
    const { fake, r, add, opaque } = setup();
    add('opaque');
    const mesh = r.createMesh({
      layout: VERTEX_LAYOUT_3D,
      vertices: new Float32Array(36),
      indices: new Uint16Array([0, 1, 2]),
    });
    const from = fake.passes.length;
    const f = sunOn(r.beginFrame(0, 0));
    f.mesh(mesh, opaque, new Transform({ z: -3 }));
    r.endFrame();
    const seq = labels(fake, from).filter((l) => l === 'core shadow' || l === 'shadow');
    expect(seq).toEqual(['shadow', 'core shadow']);
    const shadow = fake.passes.slice(from).find((p) => p.label === 'core shadow')!;
    expect((shadow.desc as GPURenderPassDescriptor).depthStencilAttachment!.depthLoadOp).toBe(
      'load',
    );
  });

  it('no sun shadow: one cull group, no shadow pass', () => {
    const { fake, r, add } = setup();
    add('opaque');
    const from = fake.passes.length;
    r.beginFrame(0, 0);
    r.endFrame();
    expect(labels(fake, from).some((l) => l === 'core shadow')).toBe(false);
    expect(r.core!.groups).toBe(1);
  });
});
