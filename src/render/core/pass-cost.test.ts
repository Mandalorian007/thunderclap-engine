/**
 * ws/pass-cost: what a core pass attaches and when it opens, on the fake GPU. A pass attaches
 * only the extra targets it writes (`PassDesc.writes`), each cleared by the first pass that
 * attaches it (or on its own before a resolve that would read it unwritten), and a pass with
 * `encode` and nothing to draw (`PassDesc.encodeWhen`) opens no render pass.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakeDevice } from '../fake-gpu';
import { Arena } from './arena';
import { createRenderCore, type RenderCore } from './core';
import type { DrawSet } from './draw-set';
import { createInstanceLayout, createVertexLayout } from './layout';
import type { PassDesc } from './pass-list';
import type { CoreTargetName } from './targets';
import { createRenderView, type RenderView, setViewFromCamera } from './view';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const PLACE = createInstanceLayout({
  stride: 16,
  attributes: [{ name: 'place', format: 'float32x4', offset: 0 }],
});
const CODE =
  '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(in.place); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }';

interface Snap {
  label?: string;
  attachments: ({ view: unknown; loadOp: GPULoadOp } | null)[];
}

interface Scene {
  fake: FakeDevice;
  core: RenderCore;
  set: DrawSet;
  view: RenderView;
  passes: Snap[];
  encoder(): GPUCommandEncoder;
}

/** A core with `targets`, the `passes` defined, and one box set in pass `setPass`. */
function scene(
  targets: CoreTargetName[],
  passes: PassDesc[],
  setPass: string,
  writes: CoreTargetName[] = [],
): Scene {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device, { targets, passLabels: true });
  for (const p of passes) core.definePass(p);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 16 });
  const instances = new Arena(device, { kind: 'instance', blockBytes: 1 << 16 });
  const set = core.createDrawSet({
    label: 'box',
    shader: { code: CODE, writes },
    vertexLayout: PACKED,
    instanceLayout: PLACE,
    vertices,
    instances,
    capacity: 16,
    kind: 'static',
    cull: 'gpu',
    pass: setPass,
  });
  const box = vertices.alloc(24 * 8, 8);
  vertices.write(box, new Uint32Array(48));
  const inst = instances.alloc(16, 16);
  instances.write(inst, new Float32Array([0, 0, 0, 1]));
  set.add({ vertices: box, indexCount: 36, instances: inst, bounds: [0, 0, 0, 2] });
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([0, 5, -10], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), camera);
  const snaps: Snap[] = [];
  const encoder = () => {
    const enc = fake.device.createCommandEncoder();
    const begin = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (desc: GPURenderPassDescriptor) => {
      if (desc.label !== 'warm')
        snaps.push({
          label: desc.label,
          attachments: [...desc.colorAttachments].map((a) =>
            a ? { view: a.view, loadOp: a.loadOp } : null,
          ),
        });
      return begin(desc);
    };
    return enc;
  };
  return { fake, core, set, view, passes: snaps, encoder };
}

function target(fake: FakeDevice, extra: object = {}) {
  const tex = fake.device.createTexture({
    size: [320, 180],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    view: tex.createView(),
    format: 'bgra8unorm' as GPUTextureFormat,
    width: 320,
    height: 180,
    clear: { r: 0, g: 0, b: 0, a: 1 },
    ...extra,
  };
}

function frame(s: Scene, t: ReturnType<typeof target>): void {
  s.passes.length = 0;
  const enc = s.encoder();
  s.core.prepare(enc, [s.view]);
  s.core.draw(enc, 0, t);
  s.fake.device.queue.submit([enc.finish()]);
}

const loads = (p: Snap | undefined) => p?.attachments.map((a) => a?.loadOp ?? null);

describe('per-pass extra targets (ws/pass-cost)', () => {
  it('a pass attaches only what it writes; its sets and encode build for that mask', () => {
    const auxSeen: number[] = [];
    const s = scene(
      ['emissive', 'velocity'],
      [
        { id: 'terrain', after: 'cutout', writes: ['emissive'] },
        {
          id: 'water',
          after: 'transparent',
          depth: 'read',
          writes: [],
          encode: (_p, ctx) => auxSeen.push(ctx.aux),
        },
      ],
      'terrain',
      ['emissive'],
    );
    expect(s.core.passes.get('terrain')!.targetMask).toBe(1);
    expect(s.core.passes.get('water')!.targetMask).toBe(0);
    expect(s.core.passes.get('opaque')!.targetMask).toBe(7);
    frame(s, target(s.fake));
    const terrain = s.passes.find((p) => p.label === 'core terrain')!;
    // Emissive cleared by its first writer; velocity is cleared on its own at the view's end.
    expect(loads(terrain)).toEqual(['clear', 'clear']);
    const water = s.passes.find((p) => p.label === 'core water')!;
    expect(loads(water)).toEqual(['load']);
    expect(auxSeen).toEqual([0]);
    expect(s.fake.bundles.at(-1)!.desc.colorFormats).toEqual(['bgra8unorm', 'rgba16float']);
    expect(loads(s.passes.at(-1))).toEqual([null, null, null, 'clear']);
    expect(s.passes.at(-1)!.label).toBe('core target clear');
  });

  it('a target is cleared by the first pass that attaches it, not the view’s first pass', () => {
    const s = scene(
      ['emissive', 'velocity'],
      [
        { id: 'terrain', after: 'cutout', writes: ['emissive'] },
        { id: 'fx', after: 'terrain', writes: ['velocity', 'emissive'], encode: () => {} },
      ],
      'terrain',
      ['emissive'],
    );
    frame(s, target(s.fake));
    const fx = s.passes.find((p) => p.label === 'core fx')!;
    expect(loads(fx)).toEqual(['load', 'load', null, 'clear']);
    // Every target was written: no clear pass of its own.
    expect(s.passes.some((p) => p.label === 'core target clear')).toBe(false);
    expect(s.passes).toHaveLength(2);
  });

  it('a resolve never reads an extra target no pass cleared', () => {
    const seen: (GPUTextureView | null)[] = [];
    const s = scene(
      ['emissive', 'velocity'],
      [
        { id: 'terrain', after: 'cutout', writes: ['emissive'] },
        { id: 'post', after: 'transparent', resolve: (_e, ctx) => seen.push(ctx.velocity) },
      ],
      'terrain',
      ['emissive'],
    );
    const out = s.fake.device
      .createTexture({ size: [320, 180], format: 'bgra8unorm', usage: 0x10 })
      .createView();
    frame(s, target(s.fake, { output: out }));
    expect(s.passes.map((p) => p.label)).toEqual(['core terrain', 'core target clear']);
    expect(loads(s.passes[1])).toEqual([null, null, null, 'clear']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
  });

  it('coreTargets: false wins over writes, and a first pass without targets still has them cleared', () => {
    const s = scene(
      ['emissive'],
      [
        { id: 'sky', after: 'depthPre', depth: 'read', coreTargets: false, encode: () => {} },
        { id: 'late', after: 'transparent', writes: ['emissive'], coreTargets: false },
      ],
      'opaque',
      ['emissive'],
    );
    expect(s.core.passes.get('late')!.targetMask).toBe(0);
    frame(s, target(s.fake));
    expect(loads(s.passes[0])).toEqual(['clear']);
    // The opaque pass is the first to attach emissive: it clears it (before: loaded unwritten).
    expect(loads(s.passes[1])).toEqual(['load', 'clear']);
  });
});

describe('skipping empty passes (ws/pass-cost)', () => {
  it('encodeWhen false and no set at work: no render pass, and the next pass clears', () => {
    let has = false;
    let encoded = 0;
    const s = scene(
      [],
      [
        {
          id: 'sky',
          after: 'depthPre',
          encodeWhen: () => has,
          encode: () => {
            encoded++;
          },
        },
      ],
      'opaque',
    );
    frame(s, target(s.fake));
    expect(s.passes.map((p) => p.label)).toEqual(['core opaque']);
    expect(loads(s.passes[0])).toEqual(['clear']);
    expect(encoded).toBe(0);
    has = true;
    frame(s, target(s.fake));
    expect(s.passes.map((p) => p.label)).toEqual(['core sky', 'core opaque']);
    expect(loads(s.passes[1])).toEqual(['load']);
    expect(encoded).toBe(1);
  });

  it('a set at work opens the pass whatever encodeWhen says, and encode runs after it', () => {
    let encoded = 0;
    const s = scene(
      [],
      [
        {
          id: 'water',
          after: 'cutout',
          encodeWhen: () => false,
          encode: () => {
            encoded++;
          },
        },
      ],
      'water',
    );
    frame(s, target(s.fake));
    expect(s.passes.map((p) => p.label)).toEqual(['core water']);
    expect(encoded).toBe(1);
    s.set.remove(0);
    frame(s, target(s.fake));
    // Nothing drew: the target is still cleared.
    expect(s.passes.map((p) => p.label)).toEqual(['core clear']);
  });
});
