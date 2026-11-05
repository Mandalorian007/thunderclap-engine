import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import { INSTANCE_FLOATS } from './material';
import { Renderer } from './renderer';
import { Transform, writeMatrix2d } from './transform';

const WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> u: vec4f;
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = u; o.emissive = u; return o; }`;

function setup(limits?: Partial<Record<string, number>>) {
  const fake = createFakeDevice(limits);
  const r = new Renderer(fakeRendererGpu(fake));
  return { fake, r };
}

/** Commands of the last scene pass. */
function sceneCommands(fake: FakeDevice): PassCommand[] {
  const p = [...fake.passes].reverse().find((x) => x.label === 'scene')!;
  return p.commands;
}

function draws(cmds: PassCommand[]) {
  return cmds.filter((c) => c.op === 'draw' || c.op === 'drawIndexed');
}

function group1(cmds: PassCommand[]) {
  return cmds.filter(
    (c): c is Extract<PassCommand, { op: 'setBindGroup' }> =>
      c.op === 'setBindGroup' && c.index === 1,
  );
}

describe('per-draw uniforms', () => {
  it('gives each draw its own block at a dynamic offset', () => {
    const { fake, r } = setup();
    const m = r.createMaterial({
      label: 'pd',
      wgsl: WGSL,
      uniformBytes: 16,
      perDrawUniforms: true,
    });
    m.setUniforms(new Float32Array([9, 9, 9, 9]));
    const f = r.beginFrame(0, 1 / 60);
    f.sprite(m, { x: 0, y: 0, uniforms: [1, 0, 0, 1] });
    f.sprite(m, { x: 1, y: 0, uniforms: [0, 1, 0, 1] });
    f.sprite(m, { x: 2, y: 0 }); // shared block
    f.sprite(m, { x: 3, y: 0 }); // merges with the previous (same offset)
    r.endFrame();
    expect(fake.errors).toEqual([]);
    const cmds = sceneCommands(fake);
    expect(draws(cmds).map((d) => d.instances)).toEqual([1, 1, 2]);
    expect(group1(cmds).map((g) => g.offsets)).toEqual([[256], [512], [0]]);
    expect(r.stats.drawCalls).toBe(3);
    // Slots 1..2 uploaded in one write after slot 0.
    const ub = fake.buffers.find((b) => b.label === 'material:pd-uniforms')!;
    const w = fake.writes.filter((x) => x.buffer === ub);
    expect(w.map((x) => [x.offset, x.bytes])).toEqual([
      [0, 16],
      [256, 512],
    ]);
  });

  it('declares a dynamic-offset layout and binds a block-sized range', () => {
    const { fake, r } = setup();
    const m = r.createMaterial({
      label: 'x',
      wgsl: WGSL,
      uniformBytes: 20,
      perDrawUniforms: true,
    });
    const f = r.beginFrame(0, 0);
    f.sprite(m, { x: 0, y: 0, uniforms: [1] });
    r.endFrame();
    const g = fake.bindGroups.find((b) => b.label === 'material:x-group')!;
    expect(g.layout.entries[0]!.buffer).toEqual({ hasDynamicOffset: true });
    expect(g.entries[0]!.resource).toMatchObject({ size: 32 });
  });

  it('grows the buffer and keeps the shared block', () => {
    const { fake, r } = setup();
    const m = r.createMaterial({ label: 'g', wgsl: WGSL, uniformBytes: 16, perDrawUniforms: true });
    m.setUniforms(new Float32Array([7, 7, 7, 7]));
    const first = fake.buffers.find((b) => b.label === 'material:g-uniforms')!;
    const f = r.beginFrame(0, 0);
    for (let i = 0; i < 40; i++) f.sprite(m, { x: i, y: 0, uniforms: [i] });
    r.endFrame();
    expect(fake.errors).toEqual([]);
    expect(first.destroyed).toBe(true);
    const grown = fake.buffers.filter((b) => b.label === 'material:g-uniforms').at(-1)!;
    expect(grown.size).toBeGreaterThanOrEqual(41 * 256);
    // Whole staging (incl. slot 0) re-uploaded into the new buffer.
    const w = fake.writes.filter((x) => x.buffer === grown);
    expect(w[0]).toMatchObject({ offset: 0, bytes: 41 * 256 });
    expect(group1(sceneCommands(fake))).toHaveLength(40);
  });

  it('resets per frame and does not allocate bind groups in steady state', () => {
    const { fake, r } = setup();
    const m = r.createMaterial({ label: 's', wgsl: WGSL, uniformBytes: 16, perDrawUniforms: true });
    const u = new Float32Array(4);
    const dp = { x: 0, y: 0, uniforms: u };
    const frame = () => {
      const f = r.beginFrame(0, 0);
      f.sprite(m, dp);
      f.sprite(m, dp);
      r.endFrame();
    };
    frame();
    const groups = fake.bindGroups.length;
    for (let i = 0; i < 5; i++) frame();
    expect(fake.bindGroups.length).toBe(groups);
    expect(group1(sceneCommands(fake)).map((g) => g.offsets)).toEqual([[256], [512]]);
  });

  it('rejects uniforms on a material without perDrawUniforms, and oversize blocks', () => {
    const { r } = setup();
    const plain = r.createMaterial({ label: 'p', wgsl: WGSL, uniformBytes: 16 });
    const pd = r.createMaterial({
      label: 'q',
      wgsl: WGSL,
      uniformBytes: 16,
      perDrawUniforms: true,
    });
    const f = r.beginFrame(0, 0);
    expect(() => f.sprite(plain, { x: 0, y: 0, uniforms: [1] })).toThrow(/perDrawUniforms/);
    expect(() => f.sprite(pd, { x: 0, y: 0, uniforms: [1, 2, 3, 4, 5] })).toThrow(/block/);
    r.endFrame();
    expect(() => r.createMaterial({ label: 'z', wgsl: WGSL, perDrawUniforms: true })).toThrow();
  });

  it('respects the device offset alignment', () => {
    const { fake, r } = setup({ minUniformBufferOffsetAlignment: 64 });
    const m = r.createMaterial({ label: 'a', wgsl: WGSL, uniformBytes: 80, perDrawUniforms: true });
    const f = r.beginFrame(0, 0);
    f.sprite(m, { x: 0, y: 0, uniforms: [1] });
    f.sprite(m, { x: 0, y: 0, uniforms: [2] });
    r.endFrame();
    expect(group1(sceneCommands(fake)).map((g) => g.offsets)).toEqual([[128], [256]]);
  });

  it('leaves ordinary materials untouched', () => {
    const { fake, r } = setup();
    const m = r.createMaterial({ label: 'o', wgsl: WGSL, uniformBytes: 16 });
    const f = r.beginFrame(0, 0);
    f.sprite(m, { x: 0, y: 0 });
    f.sprite(m, { x: 1, y: 0 });
    r.endFrame();
    const cmds = sceneCommands(fake);
    expect(draws(cmds).map((d) => d.instances)).toEqual([2]);
    expect(group1(cmds).map((g) => g.offsets)).toEqual([[]]);
    const ub = fake.buffers.find((b) => b.label === 'material:o-uniforms')!;
    expect(ub.size).toBe(16);
  });
});

describe('textures', () => {
  it('textureFromPixels uploads linear rgba8 by default', () => {
    const { fake, r } = setup();
    const t = r.textureFromPixels({ width: 3, height: 2, data: new Uint8Array(24), label: 'mask' });
    expect(t.format).toBe('rgba8unorm');
    const w = fake.textureWrites.at(-1)!;
    expect(w.bytesPerRow).toBe(12);
    expect(w.size).toEqual([3, 2]);
    expect(fake.errors).toEqual([]);
  });

  it('textureFromPixels handles single-channel and float formats', () => {
    const { fake, r } = setup();
    r.textureFromPixels({ width: 5, height: 1, data: new Uint8Array(5), format: 'r8unorm' });
    expect(fake.textureWrites.at(-1)!.bytesPerRow).toBe(5);
    const t = r.textureFromPixels({
      width: 2,
      height: 2,
      data: new Float32Array(16),
      format: 'rgba32float',
    });
    expect(fake.textureWrites.at(-1)!.bytesPerRow).toBe(32);
    expect(() => r.writePixels(t, new Float32Array(4))).toThrow(/needs 64/);
  });

  it('textureFromSource can upload linear data', () => {
    const { r } = setup();
    const img = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as unknown as ImageData;
    (globalThis as Record<string, unknown>).ImageData ??= class {};
    const srgb = r.textureFromSource(img, 'c');
    const lin = r.textureFromSource(img, 'd', { linear: true });
    expect(srgb.format).toBe('rgba8unorm-srgb');
    expect(lin.format).toBe('rgba8unorm');
  });
});

describe('PingPong', () => {
  it('alternates targets and reuses two bind groups', () => {
    const { fake, r } = setup();
    const pp = r.createPingPong({ width: 64, height: 64, label: 'sim' });
    const pass = r.createFullscreenPass({
      label: 'sim',
      wgsl: '',
      targets: ['rgba16float'],
      textures: 1,
    });
    const a = pp.read;
    const b = pp.write;
    expect(a.format).toBe('rgba16float');
    expect(a).not.toBe(b);
    const enc = fake.device.createCommandEncoder();
    const before = fake.bindGroups.length;
    const targets: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      targets.push(pp.write.view);
      pp.step(enc, pass);
    }
    expect(targets).toEqual([b.view, a.view, b.view, a.view, b.view, a.view]);
    expect(pp.read).toBe(a);
    expect(fake.bindGroups.length - before).toBe(2);
    pp.resize(32, 32);
    expect(a.texture as unknown as { destroyed: boolean }).toMatchObject({ destroyed: true });
    expect(pp.width).toBe(32);
    pp.destroy();
  });
});

describe('resolution', () => {
  it('sizes scene targets from the output size and resolution options', () => {
    const { fake, r } = setup();
    const sizes: [number, number][] = [];
    r.onResize((w, h) => sizes.push([w, h]));
    r.resize(2560, 1440);
    expect([r.width, r.height]).toEqual([2560, 1440]);
    r.setResolution({ maxPixels: 1280 * 720 });
    expect([r.outputWidth, r.outputHeight]).toEqual([2560, 1440]);
    expect([r.width, r.height]).toEqual([1280, 720]);
    expect(r.resolutionScale).toBe(0.5);
    r.setResolution({ maxPixels: 1280 * 720 }); // unchanged: no realloc
    r.resize(1280, 720); // output now fits the budget: still 1280×720, no realloc
    expect([r.width, r.height]).toEqual([1280, 720]);
    r.setResolution({ scale: 0.5 });
    expect([r.width, r.height]).toEqual([640, 360]);
    expect(sizes.slice(-3)).toEqual([
      [2560, 1440],
      [1280, 720],
      [640, 360],
    ]);
    const live = fake.textures.filter(
      (t) => t.label === 'scene-color' && !(t as unknown as { destroyed: boolean }).destroyed,
    );
    expect(live.map((t) => [t.width, t.height])).toEqual([[640, 360]]);
  });

  it('samples GPU time when enabled', async () => {
    const { r } = setup();
    r.resize(64, 64);
    const got: number[] = [];
    r.onGpuTime((ms) => got.push(ms));
    r.timingEvery = 2;
    for (let i = 0; i < 4; i++) {
      r.beginFrame(i / 60, 1 / 60);
      r.endFrame();
      await Promise.resolve();
    }
    expect(got.length).toBe(2);
    expect(r.timing.samples).toBe(2);
  });
});

/** Record the floats of every upload to the instance buffer (the last one is this frame's). */
function captureInstances(fake: FakeDevice): { last: () => Float32Array } {
  const q = fake.device.queue as unknown as {
    writeBuffer: (
      b: { label?: string },
      o: number,
      d: ArrayBuffer,
      off?: number,
      n?: number,
    ) => void;
  };
  const orig = q.writeBuffer.bind(q);
  let last = new Float32Array(0);
  q.writeBuffer = (b, o, d, off = 0, n) => {
    if (b.label === 'instances') last = new Float32Array(d.slice(off, off + (n ?? d.byteLength)));
    orig(b, o, d, off, n);
  };
  return { last: () => last };
}

/** Per uploaded instance, float `i` (e.g. 3 = translation x, 11 = z, 20 = params.x). */
function column(data: Float32Array, i: number): number[] {
  const out: number[] = [];
  for (let o = 0; o + INSTANCE_FLOATS <= data.length; o += INSTANCE_FLOATS) out.push(data[o + i]!);
  return out;
}

function pipelineLabels(cmds: PassCommand[]): string[] {
  return cmds
    .filter((c) => c.op === 'setPipeline')
    .map((c) => (c as { pipeline: { label: string } }).pipeline.label);
}

type CameraFlags = {
  layers?: number;
  depthTest?: boolean;
  depthWrite?: boolean;
  position?: number[];
};
function camera(r: Renderer): CameraFlags {
  return r.camera as unknown as CameraFlags;
}

function scenePassDesc(fake: FakeDevice): GPURenderPassDescriptor {
  return [...fake.passes].reverse().find((p) => p.label === 'scene')!
    .desc as GPURenderPassDescriptor;
}

describe('28-float instances', () => {
  it('DrawParams writes the matrix, uv, tint, params, emissive, flags and size', () => {
    const { fake, r } = setup();
    const cap = captureInstances(fake);
    const f = r.beginFrame(0, 0);
    f.sprite(null, {
      x: 10,
      y: 20,
      w: 30,
      h: -40,
      rotation: 0.25,
      uv: [0.1, 0.2, 0.3, 0.4],
      tint: [0.5, 0.6, 0.7],
      params: [1, 2],
      emissive: 3,
    });
    r.endFrame();
    const d = cap.last();
    expect(d.length).toBe(28);
    const m = new Float32Array(12);
    writeMatrix2d(m, 0, 10, 20, 30, -40, 0.25);
    expect([...d.slice(0, 12)]).toEqual([...m]);
    expect([...d.slice(12)]).toEqual([
      ...new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1, 1, 2, 0, 0, 3, 0, 30, -40]),
    ]);
  });

  it('defaults: unit size, full uv, white tint', () => {
    const { fake, r } = setup();
    const cap = captureInstances(fake);
    const f = r.beginFrame(0, 0);
    f.sprite(null, { x: 1, y: 2 });
    r.endFrame();
    // biome-ignore format: instance table
    expect([...cap.last()]).toEqual([
      1, -0, 0, 1,  0, 1, 0, 2,  0, 0, 1, 0,
      0, 0, 1, 1,  1, 1, 1, 1,  0, 0, 0, 0,  0, 0, 1, 1,
    ]);
  });

  it('a Transform places sprites and meshes by its world matrix; size = scale', () => {
    const { fake, r } = setup();
    const cap = captureInstances(fake);
    const parent = new Transform({ x: 100, y: 50 });
    const t = new Transform({ x: 5, y: 6, z: 2, rotation: 0.5, scaleX: 8, scaleY: 9, parent });
    const f = r.beginFrame(0, 0);
    f.sprite(null, t, { tint: [1, 0, 0, 1] });
    f.mesh(r.quad, r.defaultSprite, t);
    r.endFrame();
    const d = cap.last();
    expect(d.length).toBe(56);
    expect([...d.slice(0, 12)]).toEqual([...t.world]);
    expect([...d.slice(28, 40)]).toEqual([...t.world]);
    expect(d[3]).toBeCloseTo(105, 4);
    expect(d[11]).toBe(2);
    expect([...d.slice(16, 20)]).toEqual([1, 0, 0, 1]);
    expect([...d.slice(26, 28)]).toEqual([8, 9]);
    // Same material + mesh, contiguous: one instanced draw.
    expect(draws(sceneCommands(fake)).map((x) => x.instances)).toEqual([2]);
  });
});

describe('order and layers', () => {
  it('default order keeps submission order and batching', () => {
    const { fake, r } = setup();
    const a = r.createMaterial({ label: 'a', wgsl: WGSL, uniformBytes: 16 });
    const b = r.createMaterial({ label: 'b', wgsl: WGSL, uniformBytes: 16 });
    const cap = captureInstances(fake);
    const f = r.beginFrame(0, 0);
    for (const [m, x] of [
      [a, 0],
      [a, 1],
      [b, 2],
      [a, 3],
      [a, 4],
    ] as const) {
      f.sprite(m, { x, y: 0 });
    }
    r.endFrame();
    const cmds = sceneCommands(fake);
    expect(pipelineLabels(cmds)).toEqual(['material:a', 'material:b', 'material:a']);
    expect(draws(cmds).map((d) => [d.firstInstance, d.instances])).toEqual([
      [0, 2],
      [2, 1],
      [3, 2],
    ]);
    expect(column(cap.last(), 3)).toEqual([0, 1, 2, 3, 4]);
  });

  it('sorts by order, then submission index (stable)', () => {
    const { fake, r } = setup();
    const a = r.createMaterial({ label: 'a', wgsl: WGSL, uniformBytes: 16 });
    const b = r.createMaterial({ label: 'b', wgsl: WGSL, uniformBytes: 16 });
    const cap = captureInstances(fake);
    const f = r.beginFrame(0, 0);
    f.sprite(a, { x: 0, y: 0, order: 2 });
    f.sprite(b, { x: 1, y: 0, order: 1 });
    f.sprite(a, { x: 2, y: 0, order: 2 });
    f.sprite(b, { x: 3, y: 0, order: 1 });
    f.sprite(a, { x: 4, y: 0, order: -1 });
    r.endFrame();
    expect(column(cap.last(), 3)).toEqual([4, 1, 3, 0, 2]);
    const cmds = sceneCommands(fake);
    expect(pipelineLabels(cmds)).toEqual(['material:a', 'material:b', 'material:a']);
    expect(draws(cmds).map((d) => [d.firstInstance, d.instances])).toEqual([
      [0, 1],
      [1, 2],
      [3, 2],
    ]);
    expect(fake.errors).toEqual([]);
  });

  it('sorts drawables with instances', () => {
    const { r } = setup();
    const seen: string[] = [];
    const d1 = { draw: () => seen.push('d1') };
    const d2 = { draw: () => seen.push('d2') };
    const f = r.beginFrame(0, 0);
    f.drawable(d1, 5);
    f.sprite(null, { x: 0, y: 0, order: 3 });
    f.drawable(d2);
    r.endFrame();
    expect(seen).toEqual(['d2', 'd1']);
  });

  it('skips draws whose layers miss camera.layers; no layers = all', () => {
    const { fake, r } = setup();
    const cap = captureInstances(fake);
    const seen: string[] = [];
    const d = { draw: () => seen.push('d') };
    const frame = () => {
      const f = r.beginFrame(0, 0);
      f.sprite(null, { x: 0, y: 0 }); // layers 1
      f.sprite(null, { x: 1, y: 0, layers: 2 });
      f.sprite(null, { x: 2, y: 0, layers: 3 });
      f.drawable(d, 0, 4);
      r.endFrame();
    };
    frame();
    expect(column(cap.last(), 3)).toEqual([0, 1, 2]);
    expect(seen).toEqual(['d']);

    camera(r).layers = 2;
    frame();
    expect(column(cap.last(), 3)).toEqual([1, 2]);
    expect(r.stats.instances).toBe(2);
    expect(draws(sceneCommands(fake)).map((x) => [x.firstInstance, x.instances])).toEqual([[0, 2]]);
    expect(seen).toEqual(['d']);

    camera(r).layers = 4;
    frame();
    expect(r.stats.instances).toBe(0);
    expect(seen).toEqual(['d', 'd']);
  });
});

describe('depth', () => {
  function zs(...z: number[]): Transform[] {
    return z.map((v, i) => new Transform({ x: i, y: 0, z: v }));
  }

  it('has no depth attachment or depth texture without camera.depthTest', () => {
    const { fake, r } = setup();
    const f = r.beginFrame(0, 0);
    f.sprite(null, { x: 0, y: 0 });
    r.endFrame();
    expect(scenePassDesc(fake).depthStencilAttachment).toBeUndefined();
    expect(fake.textures.some((t) => t.format === 'depth24plus')).toBe(false);
    expect(f.depthFormat).toBeNull();
  });

  it('sorts opaque front-to-back, then blended back-to-front, with a depth attachment', () => {
    const { fake, r } = setup();
    const opaque = r.createMaterial({
      label: 'o',
      wgsl: WGSL,
      uniformBytes: 16,
      blend: 'opaque',
    });
    const glass = r.createMaterial({ label: 'g', wgsl: WGSL, uniformBytes: 16 });
    const cap = captureInstances(fake);
    camera(r).depthTest = true;
    const [o5, g2, o1, g9, o3] = zs(5, 2, 1, 9, 3);
    const f = r.beginFrame(0, 0);
    f.sprite(opaque, o5!, { params: [5] });
    f.sprite(glass, g2!, { params: [2] });
    f.sprite(opaque, o1!, { params: [1] });
    f.sprite(glass, g9!, { params: [9] });
    f.sprite(opaque, o3!, { params: [3] });
    r.endFrame();
    expect(column(cap.last(), 20)).toEqual([1, 3, 5, 9, 2]);
    const cmds = sceneCommands(fake);
    expect(pipelineLabels(cmds)).toEqual(['material:o:2d:d2', 'material:g:2d:d1']);
    expect(draws(cmds).map((d) => [d.firstInstance, d.instances])).toEqual([
      [0, 3],
      [3, 2],
    ]);
    expect(scenePassDesc(fake).depthStencilAttachment).toMatchObject({
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    });
    const depthTex = fake.textures.filter((t) => t.format === 'depth24plus');
    expect(depthTex.length).toBe(1);
    expect([depthTex[0]!.width, depthTex[0]!.height]).toEqual([r.width, r.height]);
    expect(f.depthFormat).toBe('depth24plus');
    expect(fake.errors).toEqual([]);
  });

  it('order is still the first key; camera.position gives distance', () => {
    const { fake, r } = setup();
    const opaque = r.createMaterial({
      label: 'o',
      wgsl: WGSL,
      uniformBytes: 16,
      blend: 'opaque',
    });
    const cap = captureInstances(fake);
    camera(r).depthTest = true;
    camera(r).position = [0, 0, 10];
    const [near, far, late] = zs(9, 0, 9.5);
    const f = r.beginFrame(0, 0);
    f.sprite(opaque, far!, { params: [1] });
    f.sprite(opaque, late!, { params: [3], order: 1 });
    f.sprite(opaque, near!, { params: [2] });
    r.endFrame();
    // near (dist² ≈ 2) before far (≈ 101); order 1 last regardless of distance.
    expect(column(cap.last(), 20)).toEqual([2, 1, 3]);
  });

  it('depthWrite: false uses test-only pipelines; turning depth off drops the attachment', () => {
    const { fake, r } = setup();
    const opaque = r.createMaterial({
      label: 'o',
      wgsl: WGSL,
      uniformBytes: 16,
      blend: 'opaque',
    });
    camera(r).depthTest = true;
    camera(r).depthWrite = false;
    let f = r.beginFrame(0, 0);
    f.sprite(opaque, { x: 0, y: 0 });
    r.endFrame();
    expect(pipelineLabels(sceneCommands(fake))).toEqual(['material:o:2d:d1']);

    camera(r).depthTest = false;
    f = r.beginFrame(0, 0);
    f.sprite(opaque, { x: 0, y: 0 });
    r.endFrame();
    expect(pipelineLabels(sceneCommands(fake))).toEqual(['material:o']);
    expect(scenePassDesc(fake).depthStencilAttachment).toBeUndefined();
    expect(f.depthFormat).toBeNull();
  });

  it('rebuilds the depth target on resize and frees it on destroy', () => {
    const { fake, r } = setup();
    camera(r).depthTest = true;
    const frame = () => {
      const f = r.beginFrame(0, 0);
      f.sprite(null, { x: 0, y: 0 });
      r.endFrame();
    };
    frame();
    expect(fake.textures.filter((t) => t.format === 'depth24plus').length).toBe(1);
    r.resize(r.outputWidth * 2, r.outputHeight * 2);
    frame();
    const all = fake.textures.filter((t) => t.format === 'depth24plus');
    expect(all.length).toBe(2);
    expect(all[0]!.destroyed).toBe(true);
    expect(all[1]!.width).toBe(r.width);
    r.destroy();
    expect(all[1]!.destroyed).toBe(true);
  });
});

describe('draw list steady state', () => {
  it('sorted, layered and depth frames allocate no GPU objects after the first', () => {
    const { fake, r } = setup();
    const opaque = r.createMaterial({
      label: 'o',
      wgsl: WGSL,
      uniformBytes: 16,
      blend: 'opaque',
    });
    const t = new Transform({ z: 1 });
    camera(r).depthTest = true;
    camera(r).layers = 3;
    const ps = [
      { x: 0, y: 0, order: 2 },
      { x: 1, y: 0, order: 1, layers: 4 },
      { x: 2, y: 0, order: 0 },
    ];
    const frame = () => {
      const f = r.beginFrame(0, 0);
      for (const p of ps) f.sprite(opaque, p);
      f.sprite(null, t);
      r.endFrame();
    };
    frame();
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 5; i++) frame();
    expect(counts()).toEqual(before);
    expect(fake.errors).toEqual([]);
  });
});
