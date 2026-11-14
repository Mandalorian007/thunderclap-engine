/** Post as a resolve pass on the core (ws/core-passes): per view, into `CoreTarget.output`. */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { Arena } from '../render/core/arena';
import { type CoreTarget, createRenderCore, type RenderCoreOptions } from '../render/core/core';
import { createVertexLayout } from '../render/core/layout';
import { createRenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice } from '../render/fake-gpu';
import type { PostInputs, PostProcessor } from '../render/renderer';
import { createCorePost } from './core-post';
import { createViewPost } from './view-post';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const SHADER = {
  code: '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
};

interface Call {
  proc: number;
  inputs: PostInputs;
  depth: boolean;
  near: number;
  out: GPUTextureView;
  vp: number | undefined;
  viewProj: number[];
  previousViewProj: number[];
}

function setup(targets?: RenderCoreOptions['targets']) {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device, { depthFormat: 'depth24plus', targets });
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
  const calls: Call[] = [];
  const resized: string[] = [];
  const proc = (i: number): PostProcessor => ({
    resize: (w, h) => resized.push(`${i} ${w}x${h}`),
    encode: (_e, inputs, out, vp) =>
      calls.push({
        proc: i,
        inputs,
        depth: inputs.depth !== null,
        near: inputs.projection?.near ?? 0,
        out,
        vp: vp?.x,
        viewProj: [...inputs.view!.viewProj],
        previousViewProj: [...inputs.view!.previousViewProj],
      }),
  });
  const scene = device.createTexture({
    size: [64, 32],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const out = device.createTexture({
    size: [128, 32],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target: CoreTarget = {
    view: scene.createView(),
    format: 'rgba16float',
    width: 64,
    height: 32,
    clear: { r: 0, g: 0, b: 0, a: 1 },
    output: out.createView(),
    outputFormat: 'bgra8unorm',
  };
  const cam = (x: number) => {
    const c = Camera.perspective(Math.PI / 2, 2, 0.1, 100);
    c.lookAt([x, 0, 0], [x, 0, -1]);
    return setViewFromCamera(createRenderView(), c);
  };
  return { fake, device, core, calls, resized, proc, target, cam };
}

describe('CorePost (ws/core-passes)', () => {
  it('resolves the scene into the output after transparent; overlay draws there, without depth', () => {
    const { fake, device, core, calls, resized, proc, target, cam } = setup();
    const post = createCorePost(core, proc(0));
    let overlay = 0;
    core.definePass({ id: 'ui', after: 'post', depth: 'none', encode: () => overlay++ });
    post.time = 2;
    const view = cam(0);
    const from = fake.passes.length;
    const enc = device.createCommandEncoder();
    core.prepare(enc, [view]);
    core.draw(enc, 0, target);
    device.queue.submit([enc.finish()]);

    expect(resized).toEqual(['0 64x32']);
    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.out).toBe(target.output);
    expect((c.inputs.color as { view: GPUTextureView }).view).toBe(target.view);
    expect(c.inputs.time).toBe(2);
    // The core's own depth, sampleable, with the projection's near plane.
    expect(c.depth).toBe(true);
    expect(c.near).toBeCloseTo(0.1, 4);
    expect(c.previousViewProj).toEqual(c.viewProj);

    const render = fake.passes.slice(from).filter((p) => p.kind === 'render');
    const last = render.filter((p) => p.label === 'core pass')[1]!;
    const desc = last.desc as GPURenderPassDescriptor;
    expect([...desc.colorAttachments][0]!.view).toBe(target.output);
    expect(desc.depthStencilAttachment).toBeUndefined();
    expect(overlay).toBe(1);
    // The scene drew before the resolve (the core reuses its attachment objects).
    expect(render.filter((p) => p.label === 'core pass').length).toBe(2);
    expect(post.resolves).toBe(1);
  });

  it('without an output the resolve is skipped and later passes keep the scene target', () => {
    const { device, core, calls, proc, target, cam } = setup();
    createCorePost(core, proc(0));
    const enc = device.createCommandEncoder();
    core.prepare(enc, [cam(0)]);
    core.draw(enc, 0, { ...target, output: undefined });
    expect(calls.length).toBe(0);
  });

  it('a ViewPost runs one processor per view (each eye), with each view its own history', () => {
    const { device, core, calls, proc, target, cam } = setup();
    createCorePost(core, createViewPost(proc));
    const left = cam(-1);
    const right = cam(1);
    for (let f = 0; f < 2; f++) {
      const enc = device.createCommandEncoder();
      if (f === 1) {
        // The eyes moved: each view's previous is its own last frame.
        const c = Camera.perspective(Math.PI / 2, 2, 0.1, 100);
        c.lookAt([-1, 0, 1], [-1, 0, 0]);
        setViewFromCamera(left, c);
      }
      core.prepare(enc, [{ views: [left, right], planes: 'union' }]);
      core.draw(enc, 0, { ...target, outputViewport: { x: 0, y: 0, width: 64, height: 32 } });
      core.draw(enc, 1, {
        ...target,
        clear: undefined,
        outputViewport: { x: 64, y: 0, width: 64, height: 32 },
      });
      device.queue.submit([enc.finish()]);
    }
    expect(calls.map((c) => `${c.proc}@${c.vp}`)).toEqual(['0@0', '1@64', '0@0', '1@64']);
    const [l0, r0, l1, r1] = calls;
    expect(l0!.viewProj).not.toEqual(r0!.viewProj);
    expect(l1!.previousViewProj).toEqual(l0!.viewProj);
    expect(l1!.viewProj).not.toEqual(l0!.viewProj);
    expect(r1!.previousViewProj).toEqual(r0!.viewProj);
  });

  it('feeds bloom, SSR and TAA from the core’s extra targets when it has them (ws/core-targets)', () => {
    const run = (targets?: RenderCoreOptions['targets']) => {
      const { device, core, calls, proc, target, cam } = setup(targets);
      createCorePost(core, proc(0));
      const enc = device.createCommandEncoder();
      core.prepare(enc, [cam(0)]);
      core.draw(enc, 0, target);
      return { inputs: calls[0]!.inputs };
    };
    const plain = run();
    expect(plain.inputs.roughMetal).toBeNull();
    expect(plain.inputs.velocity).toBeNull();
    expect((plain.inputs.emissive as { width: number }).width).toBe(1);
    const all = run(['emissive', 'roughMetal', 'velocity']);
    const view = (t: unknown) => (t as { view: GPUTextureView; width: number }).view;
    expect((all.inputs.emissive as { width: number }).width).toBe(64);
    expect(view(all.inputs.emissive)).toBeDefined();
    expect(view(all.inputs.roughMetal)).toBeDefined();
    expect(view(all.inputs.velocity)).toBeDefined();
    expect(view(all.inputs.velocity)).not.toBe(view(all.inputs.emissive));
  });
});
