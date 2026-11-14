/**
 * ws/core-passes: the retained core drawn inside a `Renderer` frame. Its opaque passes go
 * between the view's opaque and blended draws, into the scene's colour and depth (loaded, never
 * cleared); its transparent passes after the blended draws; one view a frame.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, fakeRendererGpu } from '../fake-gpu';
import { DEPTH_FORMAT } from '../material';
import { Renderer } from '../renderer';
import { Transform } from '../transform';
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
  const core = r.core;
  const vertices = core.createArena({ kind: 'vertex', blockBytes: 4096 });
  const box = vertices.alloc(24 * 8, 8);
  const add = (pass: 'opaque' | 'transparent') => {
    const set = core.createDrawSet({
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
    expect(r.core.depth).toBeNull();
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
});
