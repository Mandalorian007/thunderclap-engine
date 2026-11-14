/**
 * ws/core-targets: the core's extra colour targets (emissive, roughMetal, velocity) on the fake
 * GPU. A core without them keeps one attachment; one with them attaches each at its fixed
 * location, clears the view's first pass, hands them to a resolve, drops them after it, and
 * keeps each view's last-frame matrix for velocity.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakeDevice } from '../fake-gpu';
import { Arena } from './arena';
import { createRenderCore, type RenderCore, type RenderCoreOptions } from './core';
import type { DrawSet } from './draw-set';
import { createInstanceLayout, createVertexLayout } from './layout';
import { coreColorFormats, coreColorTargets, coreTargetMask } from './targets';
import {
  createRenderView,
  type RenderView,
  setViewFromCamera,
  VIEW_SLOT,
  VIEW_SLOT_FLOATS,
  writePrevRows,
} from './view';

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
  camera: Camera;
  /** Each render pass's attachments as they were when it began. */
  passes: Snap[];
  encoder(): GPUCommandEncoder;
}

function scene(opts: RenderCoreOptions = {}, writes?: ('emissive' | 'velocity')[]): Scene {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device, opts);
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
  });
  const box = vertices.alloc(24 * 8, 8);
  vertices.write(box, new Uint32Array(48));
  const inst = instances.alloc(16, 16);
  instances.write(inst, new Float32Array([0, 0, 0, 1]));
  set.add({ vertices: box, indexCount: 36, instances: inst, bounds: [0, 0, 0, 2] });
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([0, 5, -10], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), camera);
  const passes: Snap[] = [];
  const encoder = () => {
    const enc = fake.device.createCommandEncoder();
    const begin = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (desc: GPURenderPassDescriptor) => {
      passes.push({
        label: desc.label,
        attachments: [...desc.colorAttachments].map((a) =>
          a ? { view: a.view, loadOp: a.loadOp } : null,
        ),
      });
      return begin(desc);
    };
    return enc;
  };
  return { fake, core, set, view, camera, passes, encoder };
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
  const enc = s.encoder();
  s.core.prepare(enc, [s.view]);
  s.core.draw(enc, 0, t);
  s.fake.device.queue.submit([enc.finish()]);
}

/** The fragment targets of the draw set's colour pipelines, newest last. */
function pipelineTargets(s: Scene): (GPUColorTargetState | null)[][] {
  const out: (GPUColorTargetState | null)[][] = [];
  for (const b of s.fake.bundles) {
    for (const c of b.commands) {
      if (c.op !== 'setPipeline') continue;
      const desc = (c as unknown as { pipeline: { desc: GPURenderPipelineDescriptor } }).pipeline
        .desc;
      if (desc.fragment) out.push([...desc.fragment.targets]);
    }
  }
  return out;
}

describe('core target helpers (ws/core-targets)', () => {
  it('a mask of names, formats and target states at the fixed locations', () => {
    expect(coreTargetMask(['velocity', 'emissive'])).toBe(5);
    expect(coreTargetMask(undefined)).toBe(0);
    expect(coreColorFormats('bgra8unorm', 0)).toEqual(['bgra8unorm']);
    expect(coreColorFormats('bgra8unorm', 4)).toEqual(['bgra8unorm', null, null, 'rg16float']);
    expect(coreColorFormats('bgra8unorm', 3)).toEqual(['bgra8unorm', 'rgba16float', 'rg8unorm']);
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one' },
      alpha: { srcFactor: 'one', dstFactor: 'one' },
    };
    expect(coreColorTargets({ format: 'bgra8unorm', blend }, 0, 7)).toEqual([
      { format: 'bgra8unorm', blend },
    ]);
    expect(coreColorTargets({ format: 'bgra8unorm', blend }, 7, ['emissive', 'velocity'])).toEqual([
      { format: 'bgra8unorm', blend },
      { format: 'rgba16float', writeMask: 0xf, blend },
      { format: 'rg8unorm', writeMask: 0 },
      { format: 'rg16float', writeMask: 0xf },
    ]);
  });

  it('writePrevRows moves last frame’s rows to this frame’s origin', () => {
    const prev = new Float32Array(16);
    for (let i = 0; i < 16; i++) prev[i] = i + 1;
    const out = new Float32Array(VIEW_SLOT_FLOATS * 2);
    writePrevRows(out, 1, prev, 0, [1, 2, 3], 0, [3, 2, 1]);
    const o = VIEW_SLOT_FLOATS + VIEW_SLOT.prevRows;
    // Row x: column-major elements 0, 4, 8, 12, plus the origin moved by (2, 0, -2).
    expect([...out.subarray(o, o + 4)]).toEqual([1, 5, 9, 13 + 2 * 1 - 2 * 9]);
    expect([...out.subarray(o + 4, o + 8)]).toEqual([2, 6, 10, 14 + 2 * 2 - 2 * 10]);
    expect([...out.subarray(o + 8, o + 12)]).toEqual([4, 8, 12, 16 + 2 * 4 - 2 * 12]);
  });
});

describe('render core extra targets (ws/core-targets)', () => {
  it('a core without targets keeps one colour attachment and one-target pipelines', () => {
    const s = scene();
    frame(s, target(s.fake));
    expect(s.core.targetMask).toBe(0);
    for (const p of s.passes) expect(p.attachments).toHaveLength(1);
    expect(s.fake.bundles.every((b) => b.desc.colorFormats.length === 1)).toBe(true);
    expect(s.fake.textures.some((t) => t.label?.startsWith('core emissive'))).toBe(false);
  });

  it('opted-in targets attach at their locations, cleared once per view, in the core’s own textures', () => {
    const s = scene({ targets: ['emissive', 'velocity'] }, ['velocity']);
    const t = target(s.fake);
    frame(s, t);
    expect(s.core.targetMask).toBe(5);
    const own = s.fake.textures.filter(
      (x) => x.label === 'core emissive' || x.label === 'core velocity',
    );
    expect(own.map((x) => [x.label, x.format, x.width, x.height])).toEqual([
      ['core emissive', 'rgba16float', 320, 180],
      ['core velocity', 'rg16float', 320, 180],
    ]);
    const first = s.passes[0]!;
    expect(first.attachments).toHaveLength(4);
    expect(first.attachments[2]).toBeNull();
    expect(first.attachments.map((a) => a?.loadOp ?? null)).toEqual([
      'clear',
      'clear',
      null,
      'clear',
    ]);
    const bundle = s.fake.bundles.at(-1)!;
    expect(bundle.desc.colorFormats).toEqual(['bgra8unorm', 'rgba16float', null, 'rg16float']);
    const targets = pipelineTargets(s).at(-1)!;
    expect(targets.map((x) => x?.writeMask ?? null)).toEqual([null, 0, null, 0xf]);
    // The next frame re-uses the textures and clears again.
    const made = s.fake.textures.length;
    frame(s, t);
    expect(s.fake.textures.length).toBe(made);
    expect(s.passes.at(-1)!.attachments[1]!.loadOp).toBe('clear');
  });

  it('views the caller gives are attached instead, and setTargets([]) goes back to none', () => {
    const s = scene({ targets: ['emissive'] });
    const em = s.fake.device
      .createTexture({ size: [320, 180], format: 'rgba16float', usage: 0x10 })
      .createView();
    frame(s, target(s.fake, { emissive: em }));
    expect(s.passes[0]!.attachments[1]!.view).toBe(em);
    expect(s.fake.textures.some((x) => x.label === 'core emissive')).toBe(false);
    s.core.setTargets([]);
    s.passes.length = 0;
    frame(s, target(s.fake));
    for (const p of s.passes) expect(p.attachments).toHaveLength(1);
  });

  it('a resolve reads the targets; passes after it draw colour only', () => {
    const s = scene({ targets: ['emissive', 'roughMetal', 'velocity'] });
    const seen: (GPUTextureView | null)[] = [];
    s.core.passes.define({
      id: 'post',
      after: 'transparent',
      resolve: (_enc, ctx) => seen.push(ctx.emissive, ctx.roughMetal, ctx.velocity),
    });
    s.core.passes.define({ id: 'ui', after: 'post', encode: () => {} });
    const out = s.fake.device
      .createTexture({ size: [320, 180], format: 'bgra8unorm', usage: 0x10 })
      .createView();
    frame(
      s,
      target(s.fake, { output: out, outputViewport: { x: 0, y: 0, width: 320, height: 180 } }),
    );
    expect(seen).toHaveLength(3);
    expect(seen.every((v) => v !== null)).toBe(true);
    expect(s.passes[0]!.attachments).toHaveLength(4);
    const last = s.passes.at(-1)!;
    expect(last.attachments).toHaveLength(1);
    expect(last.attachments[0]!.view).toBe(out);
  });

  it('velocity: the first frame has no motion, the next one last frame’s matrix', () => {
    const s = scene({ targets: ['velocity'] });
    const t = target(s.fake);
    const data = (s.core as unknown as { viewData: Float32Array }).viewData;
    const rows = () => [...data.subarray(VIEW_SLOT.prevRows, VIEW_SLOT.prevRows + 12)];
    const vp = () => [...data.subarray(0, 16)];
    frame(s, t);
    const m0 = vp();
    expect(rows()).toEqual([0, 1, 3].flatMap((r) => [m0[r], m0[4 + r], m0[8 + r], m0[12 + r]]));
    s.camera.lookAt([1, 5, -10], [0, 0, 0]);
    setViewFromCamera(s.view, s.camera);
    frame(s, t);
    expect(vp()).not.toEqual(m0);
    expect(rows()).toEqual([0, 1, 3].flatMap((r) => [m0[r], m0[4 + r], m0[8 + r], m0[12 + r]]));
  });
});
