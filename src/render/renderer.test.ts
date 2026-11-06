import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import {
  createFakeDevice,
  type FakeBindGroup,
  type FakeDevice,
  type FakeView,
  fakeRendererGpu,
  type PassCommand,
} from './fake-gpu';
import type { Frame } from './frame';
import {
  DEFAULT_SHADOW_BIAS,
  LIGHTS_BLOCK_FLOATS,
  Lights,
  SHADOW_PARAMS_OFFSET_FLOATS,
  SUN_VIEW_PROJ_OFFSET_FLOATS,
} from './lights';
import { INSTANCE_FLOATS, INSTANCE_OFFSET } from './material';
import { quadGeometry, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from './mesh';
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

describe('camera block', () => {
  /** Capture the floats of every write to the engine globals buffer. */
  function captureGlobals(fake: FakeDevice): Float32Array[] {
    const seen: Float32Array[] = [];
    const q = fake.device.queue as unknown as { writeBuffer: (...a: unknown[]) => void };
    const orig = q.writeBuffer.bind(q);
    q.writeBuffer = (buffer: unknown, offset: unknown, data: unknown, ...rest: unknown[]) => {
      if ((buffer as { label?: string }).label === 'engine-globals') {
        seen.push(new Float32Array(data as Float32Array));
      }
      orig(buffer, offset, data, ...rest);
    };
    return seen;
  }

  it('binds globals at 0, the camera block at 1, the lights at 2, the shadow map and sampler at 3 and 4', () => {
    const { fake } = setup();
    const g = fake.bindGroups.find((b) => b.label === 'engine-globals-group')!;
    expect(g.layout.entries.map((e) => e.binding)).toEqual([0, 1, 2, 3, 4]);
    expect(g.layout.entries[3]).toMatchObject({ texture: { sampleType: 'depth' } });
    expect(g.layout.entries[4]).toMatchObject({ sampler: { type: 'comparison' } });
    expect(g.entries.map((e) => e.resource)).toMatchObject([
      { size: 32 },
      { offset: 256, size: 256 },
      { offset: 512, size: LIGHTS_BLOCK_FLOATS * 4 },
      {
        texture: {
          label: 'engine-shadow-placeholder',
          width: 1,
          height: 1,
          format: 'depth32float',
        },
      },
      { label: 'engine-shadow-sampler' },
    ]);
    const buf = fake.buffers.find((b) => b.label === 'engine-globals')!;
    expect(buf.size).toBe(512 + LIGHTS_BLOCK_FLOATS * 4);
  });

  it('uploads the default unlit block, then the frame.lights the game sets, per view', () => {
    const { fake, r } = setup();
    const seen = captureGlobals(fake);
    const f = r.beginFrame(0, 0);
    r.endFrame();
    expect(f.lights).toBeInstanceOf(Lights);
    const unlit = seen[0]!.subarray(128, 128 + LIGHTS_BLOCK_FLOATS);
    expect([...unlit.subarray(0, 3)]).toEqual([1, 1, 1]);
    expect(new Uint32Array(unlit.buffer, unlit.byteOffset)[3]).toBe(0);
    expect([...unlit.subarray(4, 12)]).toEqual([0, -1, 0, 0, 0, 0, 0, 0]);
    expect(unlit.subarray(12).every((v) => v === 0)).toBe(true);

    f.lights.ambient.set([0.2, 0.3, 0.4]);
    f.lights.sun.color = [1, 0.9, 0.8];
    f.lights.points.push({ position: [1, 2, 3], color: [5, 6, 7], radius: 9 });
    const b = Camera.perspective(1, 1, 0.1, 10);
    b.screen.width = 0.5;
    r.beginFrame(1, 0);
    r.render(f, r.camera);
    r.render(f, b);
    r.endFrame();
    // `captureGlobals` sees view 0's buffer; view 1 (`engine-globals-1`) gets the same bytes.
    expect(seen.length).toBe(2);
    const l = seen[1]!.subarray(128, 128 + LIGHTS_BLOCK_FLOATS);
    expect([...l.subarray(0, 3)]).toEqual([0.2, 0.3, 0.4].map(Math.fround));
    expect(new Uint32Array(l.buffer, l.byteOffset)[3]).toBe(1);
    expect([...l.subarray(8, 11)]).toEqual([1, 0.9, 0.8].map(Math.fround));
    expect([...l.subarray(12, 20)]).toEqual([1, 2, 3, 9, 5, 6, 7, 0]);
    const writes = fake.writes.filter((w) => (w.buffer.label ?? '').startsWith('engine-globals'));
    expect(writes.map((w) => w.bytes)).toEqual(Array(3).fill(512 + LIGHTS_BLOCK_FLOATS * 4));
    expect(fake.errors).toEqual([]);
  });

  it('uploads globals and the default ortho2d camera once per frame', () => {
    const { fake, r } = setup();
    expect(r.camera).toBeInstanceOf(Camera);
    expect(r.camera.screen).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    r.resize(800, 450);
    const seen = captureGlobals(fake);
    r.camera.x = 100;
    r.camera.zoom = 2;
    r.beginFrame(1.5, 0.25);
    r.endFrame();
    expect(fake.errors).toEqual([]);
    expect(seen.length).toBe(1);
    const g = seen[0]!;
    expect(g.length).toBe(128 + LIGHTS_BLOCK_FLOATS);
    expect([...g.subarray(0, 6)]).toEqual([1920, 1080, 800, 450, 1.5, 0.25]);
    expect([...g.subarray(64, 80)]).toEqual([...r.camera.view]);
    expect([...g.subarray(80, 96)]).toEqual([...r.camera.projection]);
    expect([...g.subarray(96, 112)]).toEqual([...r.camera.viewProjection]);
    expect([...g.subarray(116, 120)]).toEqual([0, 0, 800, 450]); // viewport: scene target px
    expect(new Uint32Array(g.buffer)[120]).toBe(0); // view_index
  });

  it('draws through an assigned camera', () => {
    const { fake, r } = setup();
    const seen = captureGlobals(fake);
    r.camera = Camera.perspective(1, 16 / 9, 0.1, 100).lookAt([0, 0, 5], [0, 0, 0]);
    r.beginFrame(0, 0);
    r.endFrame();
    expect([...seen[0]!.subarray(96, 112)]).toEqual([...r.camera.viewProjection]);
    expect(seen[0]![114]).toBeCloseTo(5, 4); // camera_pos.z
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

    r.camera.layers = 2;
    frame();
    expect(column(cap.last(), 3)).toEqual([1, 2]);
    expect(r.stats.instances).toBe(2);
    expect(draws(sceneCommands(fake)).map((x) => [x.firstInstance, x.instances])).toEqual([[0, 2]]);
    expect(seen).toEqual(['d']);

    r.camera.layers = 4;
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
    r.camera.depthTest = true;
    r.camera.depthWrite = true;
    const [o5, g2, o1, g9, o3] = zs(5, 2, 1, 9, 3); // ortho2d: z into the screen (larger = farther)
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

  it('order is still the first key; the camera view gives depth', () => {
    const { fake, r } = setup();
    const opaque = r.createMaterial({
      label: 'o',
      wgsl: WGSL,
      uniformBytes: 16,
      blend: 'opaque',
    });
    const cap = captureInstances(fake);
    r.camera = Camera.perspective(1, 1, 0.1, 100).lookAt([0, 0, 10], [0, 0, 0]);
    const [near, far, late] = zs(9, 0, 9.5);
    const f = r.beginFrame(0, 0);
    f.sprite(opaque, far!, { params: [1] });
    f.sprite(opaque, late!, { params: [3], order: 1 });
    f.sprite(opaque, near!, { params: [2] });
    r.endFrame();
    // near (view depth 1) before far (10); order 1 last regardless of depth.
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
    r.camera.depthTest = true;
    r.camera.depthWrite = false;
    let f = r.beginFrame(0, 0);
    f.sprite(opaque, { x: 0, y: 0 });
    r.endFrame();
    expect(pipelineLabels(sceneCommands(fake))).toEqual(['material:o:2d:d1']);

    r.camera.depthTest = false;
    f = r.beginFrame(0, 0);
    f.sprite(opaque, { x: 0, y: 0 });
    r.endFrame();
    expect(pipelineLabels(sceneCommands(fake))).toEqual(['material:o']);
    expect(scenePassDesc(fake).depthStencilAttachment).toBeUndefined();
    expect(f.depthFormat).toBeNull();
  });

  it('rebuilds the depth target on resize and frees it on destroy', () => {
    const { fake, r } = setup();
    r.camera.depthTest = true;
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
    r.camera.depthTest = true;
    r.camera.layers = 3;
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

describe('frustum cull (ws/cull)', () => {
  /** A perspective camera at the origin looking down -z, 90° fov, so |x| or |y| beyond |z| is out. */
  function cullSetup() {
    const { fake, r } = setup();
    r.camera = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
    r.camera.depthTest = false; // no depth sort: alternating materials stay separate draws
    const a = r.createMaterial({ label: 'a', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' });
    const b = r.createMaterial({ label: 'b', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' });
    const sphere = r.createMesh({ ...quadGeometry(), bounds: { center: [0, 0, 0], radius: 1 } });
    return { fake, r, a, b, sphere };
  }

  it('skips 1000 spheres round the camera to the half it sees, and the draw calls fall', () => {
    const { fake, r, a, b, sphere } = cullSetup();
    // Alternating materials keep every draw separate: 1000 instances are 1000 draw calls.
    const ts: Transform[] = [];
    for (let i = 0; i < 1000; i++) {
      // Two in front, two behind, with the material alternating: no two neighbours merge.
      const z = i % 4 < 2 ? -10 - (i % 7) : 10 + (i % 7);
      ts.push(new Transform({ x: (i % 5) - 2, y: (i % 3) - 1, z }));
    }
    const frame = () => {
      const f = r.beginFrame(0, 0);
      for (let i = 0; i < ts.length; i++) f.mesh(sphere, i % 2 === 0 ? a : b, ts[i]!);
      r.endFrame();
    };
    r.camera.cull = false;
    frame();
    expect(r.stats.culled).toBe(0);
    expect(r.stats.drawCalls).toBe(1000);
    expect(r.stats.instances).toBe(1000);
    r.camera.cull = true;
    frame();
    expect(r.stats.culled).toBe(500);
    expect(r.stats.instances).toBe(500);
    expect(r.stats.drawCalls).toBe(500);
    expect(draws(sceneCommands(fake))).toHaveLength(500);
    // Steady state: culled frames allocate no GPU objects.
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 3; i++) frame();
    expect(counts()).toEqual(before);
    expect(fake.errors).toEqual([]);
  });

  it('carries the sphere through the instance matrix: scale and translation', () => {
    const { r, a, sphere } = cullSetup();
    const frame = (t: Transform) => {
      const f = r.beginFrame(0, 0);
      f.mesh(sphere, a, t);
      r.endFrame();
      return r.stats.culled;
    };
    expect(frame(new Transform({ x: 30, z: -10 }))).toBe(1); // right of the cone
    expect(frame(new Transform({ x: 30, z: -10, scaleX: 25 }))).toBe(0); // max axis reaches in
    expect(frame(new Transform({ x: 30, z: -10, scaleZ: 25 }))).toBe(0); // any axis counts
    expect(frame(new Transform({ x: 30, z: -10, scaleX: 0.5, scaleY: 0.5, scaleZ: 0.5 }))).toBe(1);
    expect(frame(new Transform({ z: -10 }))).toBe(0);
    expect(frame(new Transform({ z: 10 }))).toBe(1); // behind
    // A mesh placed by DrawParams is culled from its 2D position too.
    const f = r.beginFrame(0, 0);
    f.mesh(sphere, a, { x: 500, y: 0, w: 1, h: 1 });
    r.endFrame();
    expect(r.stats.culled).toBe(1);
  });

  it('never culls sprites or meshes without bounds; a camera with cull off draws everything', () => {
    const { r, a } = cullSetup();
    const unbounded = r.createMesh({ ...quadGeometry(), autoBounds: false });
    expect(unbounded.bounds.radius).toBe(Number.POSITIVE_INFINITY);
    const far = new Transform({ x: 500, z: 10 });
    const f = r.beginFrame(0, 0);
    f.sprite(a, far);
    f.sprite(null, { x: 9000, y: 9000 });
    f.mesh(unbounded, a, far);
    r.endFrame();
    expect(r.stats.culled).toBe(0);
    expect(r.stats.instances).toBe(3);
    // The default ortho2d camera has cull off: an off-screen mesh with bounds still draws.
    const { r: r2 } = setup();
    const a2 = r2.createMaterial({ label: 'a2', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' });
    const q = r2.createMesh(quadGeometry());
    expect(q.bounds.radius).toBeCloseTo(Math.SQRT1_2, 6);
    const g = r2.beginFrame(0, 0);
    g.mesh(q, a2, { x: -5000, y: -5000, w: 1, h: 1 });
    r2.endFrame();
    expect(r2.camera.cull).toBe(false);
    expect(r2.stats.culled).toBe(0);
    expect(r2.stats.instances).toBe(1);
  });

  it('sums culled over views and resets it each frame', () => {
    const { r, a, sphere } = cullSetup();
    const front = new Transform({ z: -10 });
    const back = new Transform({ z: 10 });
    const f = r.beginFrame(0, 0);
    f.mesh(sphere, a, front);
    f.mesh(sphere, a, back);
    r.endFrame();
    expect(r.stats.culled).toBe(1);
    const turned = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
    turned.lookAt([0, 0, 0], [0, 0, 1]);
    const g = r.beginFrame(0, 0);
    g.mesh(sphere, a, front);
    g.mesh(sphere, a, back);
    r.render(g, r.camera);
    r.render(g, turned);
    r.endFrame();
    expect(r.stats.culled).toBe(2);
    expect(r.stats.instances).toBe(2);
  });
});

describe('render call', () => {
  function scenePasses(fake: FakeDevice) {
    return fake.passes.filter((p) => p.label === 'scene');
  }

  it('endFrame renders through renderer.camera when nothing called render', () => {
    const { fake, r } = setup();
    const f = r.beginFrame(0, 0);
    f.sprite(null, { x: 1, y: 1 });
    r.endFrame();
    expect(scenePasses(fake).length).toBe(1);
    expect(r.stats.instances).toBe(1);
  });

  it('two cameras in one frame: two scene passes, own uniforms, clear then load', () => {
    const { fake, r } = setup();
    r.resize(800, 400);
    // The pass descriptor is reused, so record the load ops as each pass begins.
    const colorOps: string[][] = [];
    const dev = fake.device as unknown as {
      createCommandEncoder: (d?: unknown) => GPUCommandEncoder;
    };
    const mk = dev.createCommandEncoder.bind(dev);
    dev.createCommandEncoder = (d?: unknown) => {
      const enc = mk(d);
      const begin = enc.beginRenderPass.bind(enc);
      enc.beginRenderPass = (desc: GPURenderPassDescriptor) => {
        if (desc.label === 'scene') {
          const atts = desc.colorAttachments as GPURenderPassColorAttachment[];
          colorOps.push(atts.map((a) => a.loadOp));
        }
        return begin(desc);
      };
      return enc;
    };
    const world = Camera.ortho2d(1920, 1080);
    const ui = Camera.ortho2d(1920, 1080);
    ui.layers = 2;
    const f = r.beginFrame(1, 0.1);
    f.sprite(null, { x: 1, y: 1 }); // layer 1: the world camera (all layers) only
    f.sprite(null, { x: 2, y: 2, layers: 2 }); // both cameras
    r.render(f, world);
    r.render(f, ui);
    r.endFrame();
    expect(fake.errors).toEqual([]);
    const passes = scenePasses(fake);
    expect(passes.length).toBe(2);
    expect(colorOps).toEqual([
      ['clear', 'clear'],
      ['load', 'load'],
    ]);
    // Each view binds its own engine uniforms.
    const groups = passes.map(
      (p) =>
        (p.commands.find((c) => c.op === 'setBindGroup') as { group: { label: string } }).group
          .label,
    );
    expect(groups).toEqual(['engine-globals-group', 'engine-globals-group-1']);
    const writes = fake.writes.filter((w) => (w.buffer.label ?? '').startsWith('engine-globals'));
    expect(writes.map((w) => w.buffer.label)).toEqual(['engine-globals', 'engine-globals-1']);
    // The second view's instances follow the first's two in the instance buffer.
    const inst = fake.writes.filter((w) => w.buffer.label === 'instances');
    expect(inst.map((w) => w.offset)).toEqual([0, 2 * INSTANCE_FLOATS * 4]);
    expect(r.stats.instances).toBe(3);
    expect(r.stats.drawCalls).toBe(2);
  });

  it('a half-screen camera sets a viewport in target pixels; a full one sets none', () => {
    const { fake, r } = setup();
    r.resize(960, 540);
    const left = Camera.ortho2d(1920, 1080);
    left.screen.width = 960; // left half of the logical space
    const persp = Camera.perspective(1, 1, 0.1, 10);
    persp.screen.x = 0.5;
    persp.screen.width = 0.5; // right half, normalised
    const f = r.beginFrame(0, 0);
    f.sprite(null, { x: 1, y: 1 });
    r.render(f, left);
    r.render(f, persp);
    r.render(f, r.camera);
    r.endFrame();
    expect(fake.errors).toEqual([]);
    const names = scenePasses(fake).map(
      (p) => p.commands.filter((c) => c.op === 'other' && c.name === 'setViewport').length,
    );
    expect(names).toEqual([1, 1, 0]);
    // The camera block's viewport field is the sub-rect, in target pixels.
    const seen: number[][] = [];
    const q = fake.device.queue as unknown as { writeBuffer: (...a: unknown[]) => void };
    const orig = q.writeBuffer.bind(q);
    q.writeBuffer = (buffer: unknown, offset: unknown, data: unknown, ...rest: unknown[]) => {
      if ((buffer as { label?: string }).label?.startsWith('engine-globals')) {
        seen.push([...new Float32Array(data as Float32Array).subarray(116, 120)]);
      }
      orig(buffer, offset, data, ...rest);
    };
    const g = r.beginFrame(0, 0);
    r.render(g, left);
    r.render(g, persp);
    r.endFrame();
    expect(seen).toEqual([
      [0, 0, 480, 540],
      [480, 0, 480, 540],
    ]);
  });

  it("each view carries its camera's viewIndex as view_index, whatever the call order", () => {
    const { fake, r } = setup();
    const right = Camera.perspective(1, 1, 0.1, 10);
    right.viewIndex = 1;
    right.screen.x = 0.5;
    right.screen.width = 0.5;
    const left = Camera.perspective(1, 1, 0.1, 10);
    left.screen.width = 0.5;
    const seen: number[] = [];
    const q = fake.device.queue as unknown as { writeBuffer: (...a: unknown[]) => void };
    const orig = q.writeBuffer.bind(q);
    q.writeBuffer = (buffer: unknown, offset: unknown, data: unknown, ...rest: unknown[]) => {
      if ((buffer as { label?: string }).label?.startsWith('engine-globals')) {
        seen.push(new Uint32Array((data as Float32Array).buffer)[120]!);
      }
      orig(buffer, offset, data, ...rest);
    };
    const f = r.beginFrame(0, 0);
    f.sprite(null, { x: 1, y: 1 });
    r.render(f, right);
    r.render(f, left);
    r.render(f, r.camera);
    r.endFrame();
    expect(fake.errors).toEqual([]);
    expect(seen).toEqual([1, 0, 0]);
  });

  it('renders into another SceneTarget, with its own depth, and the surface shows the default', () => {
    const { fake, r } = setup();
    r.resize(800, 450);
    const portal = r.createSceneTarget({ width: 64, height: 32, label: 'portal' });
    const cam = Camera.perspective(1, 2, 0.1, 10);
    const f = r.beginFrame(0, 0);
    f.sprite(null, { x: 1, y: 1 });
    r.render(f, cam, portal);
    r.render(f, r.camera);
    r.endFrame();
    expect(fake.errors).toEqual([]);
    const [p0, p1] = scenePasses(fake).map((p) => p.desc as GPURenderPassDescriptor);
    const view0 = (p0!.colorAttachments as GPURenderPassColorAttachment[])[0]!.view as unknown as {
      texture: { label: string };
    };
    expect(view0.texture.label).toBe('portal-color');
    expect(p0!.depthStencilAttachment).toBeDefined();
    expect(portal.depth?.width).toBe(64);
    expect(p1!.depthStencilAttachment).toBeUndefined();
    expect(r.target.depth).toBeNull();
    expect(fake.textures.find((t) => t.label === 'portal-depth')?.destroyed).toBe(false);
    portal.destroy();
    expect(fake.textures.find((t) => t.label === 'portal-depth')?.destroyed).toBe(true);
  });

  it('two-camera frames allocate nothing after the first', () => {
    const { fake, r } = setup();
    const a = Camera.ortho2d(1920, 1080);
    const b = Camera.perspective(1, 1, 0.1, 10);
    b.depthTest = true;
    b.screen.width = 0.5;
    const frame = () => {
      const f = r.beginFrame(0, 0);
      for (let i = 0; i < 20; i++) f.sprite(null, { x: i, y: 0 });
      r.render(f, a);
      r.render(f, b);
      r.endFrame();
    };
    frame();
    frame();
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 5; i++) frame();
    expect(counts()).toEqual(before);
    expect(fake.errors).toEqual([]);
  });

  it('grows the instance buffer across views and retires the old one after submit', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake), { initialInstances: 4 });
    const cam = Camera.ortho2d(1920, 1080);
    const f = r.beginFrame(0, 0);
    for (let i = 0; i < 3; i++) f.sprite(null, { x: i, y: 0 });
    r.render(f, r.camera);
    r.render(f, cam);
    r.endFrame();
    expect(fake.errors).toEqual([]);
    const bufs = fake.buffers.filter((b) => b.label === 'instances');
    expect(bufs.length).toBe(2);
    expect(bufs[0]!.destroyed).toBe(true);
    expect(bufs[1]!.destroyed).toBe(false);
    expect(bufs[1]!.size).toBeGreaterThanOrEqual(6 * INSTANCE_FLOATS * 4);
  });

  it('rejects render outside a frame or with a foreign frame', () => {
    const { r } = setup();
    expect(() => r.render(r.beginFrame(0, 0), r.camera)).not.toThrow();
    r.endFrame();
    const f = r.beginFrame(0, 0);
    r.endFrame();
    expect(() => r.render(f, r.camera)).toThrow(/outside/);
  });
});

describe('shadow pass', () => {
  /** Floats of every write to view 0's engine uniform buffer. */
  function captureGlobals(fake: FakeDevice): Float32Array[] {
    const seen: Float32Array[] = [];
    const q = fake.device.queue as unknown as { writeBuffer: (...a: unknown[]) => void };
    const orig = q.writeBuffer.bind(q);
    q.writeBuffer = (buffer: unknown, offset: unknown, data: unknown, ...rest: unknown[]) => {
      if ((buffer as { label?: string }).label === 'engine-globals') {
        seen.push(new Float32Array(data as Float32Array));
      }
      orig(buffer, offset, data, ...rest);
    };
    return seen;
  }

  const CUBE = new Float32Array(VERTEX3D_FLOATS * 3);
  const OPAQUE = { label: 'o', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' as const };

  function shadowPasses(fake: FakeDevice) {
    return fake.passes.filter((p) => p.label === 'shadow');
  }

  function sunShadowOn(f: Frame, extent = 20) {
    f.lights.sun.dir = [-0.4, -1, -0.3];
    f.lights.sun.color = [1, 1, 1];
    f.lights.sun.shadow = { extent };
  }

  it('is not encoded for a frame without sun.shadow, and the lights block says disabled', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    r.camera = Camera.perspective(1, 1, 0.1, 100);
    const f = r.beginFrame(0, 0);
    f.mesh(cube, m, new Transform());
    r.endFrame();
    expect(shadowPasses(fake)).toEqual([]);
    expect(fake.textures.filter((t) => t.format === 'depth32float').map((t) => t.width)).toEqual([
      1,
    ]);
    expect(fake.errors).toEqual([]);
  });

  it('encodes one depth-only pass before the scene pass over opaque 3D draws, skipping 2D sprites and blended meshes', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const glass = r.createMaterial({ ...OPAQUE, label: 'g', blend: 'alpha' });
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    r.camera = Camera.perspective(1, 1, 0.1, 100).lookAt([0, 5, 10], [0, 0, 0]);
    const seen = captureGlobals(fake);
    const f = r.beginFrame(0, 0);
    sunShadowOn(f);
    f.sprite(null, { x: 0, y: 0 });
    f.mesh(cube, m, new Transform({ x: 1 }));
    f.mesh(cube, m, new Transform({ x: 2 }));
    f.mesh(cube, glass, new Transform({ x: 3 }));
    r.endFrame();
    const labels = fake.passes.map((p) => p.label);
    expect(labels.indexOf('shadow')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('shadow')).toBeLessThan(labels.indexOf('scene'));
    const sp = shadowPasses(fake)[0]!;
    const desc = sp.desc as GPURenderPassDescriptor;
    expect(desc.colorAttachments).toEqual([]);
    expect(desc.depthStencilAttachment).toMatchObject({
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    });
    const map = fake.textures.find((t) => t.label === 'engine-shadow-map')!;
    expect([map.width, map.height, map.format]).toEqual([2048, 2048, 'depth32float']);
    // Only the two opaque cubes (one instanced call); the sprite and the blended mesh stay out.
    // The shadow list's instances are uploaded after the scene's four.
    expect(draws(sp.commands).map((d) => [d.firstInstance, d.instances])).toEqual([[4, 2]]);
    expect(r.stats.shadowDraws).toBe(2);
    const pipe = sp.commands.find((c) => c.op === 'setPipeline') as {
      pipeline: { label: string; desc: GPURenderPipelineDescriptor };
    };
    expect(pipe.pipeline.label).toBe('engine-shadow:3d');
    expect(pipe.pipeline.desc.fragment).toBeUndefined();
    expect(pipe.pipeline.desc.depthStencil).toMatchObject({
      format: 'depth32float',
      depthWriteEnabled: true,
    });
    // The shadow pass binds the placeholder (the map is its attachment); the scene pass binds the map.
    const bind = sp.commands.find((c) => c.op === 'setBindGroup') as { group: FakeBindGroup };
    expect(bind.group.label).toBe('engine-shadow-globals-group-0');
    expect((bind.group.entries[3]!.resource as unknown as FakeView).texture.label).toBe(
      'engine-shadow-placeholder',
    );
    const sceneBind = sceneCommands(fake).find((c) => c.op === 'setBindGroup') as {
      group: FakeBindGroup;
    };
    expect((sceneBind.group.entries[3]!.resource as unknown as FakeView).texture).toBe(map);
    expect(r.globalsBindGroup).toBe(sceneBind.group);
    // The view's lights block carries the sun matrix, enabled 1 and the map's texel size.
    const l = seen.at(-1)!.subarray(128, 128 + LIGHTS_BLOCK_FLOATS);
    expect(l[SHADOW_PARAMS_OFFSET_FLOATS + 2]).toBe(1);
    expect(l[SHADOW_PARAMS_OFFSET_FLOATS + 1]).toBe(Math.fround(1 / 2048));
    expect(l[SHADOW_PARAMS_OFFSET_FLOATS]).toBe(Math.fround(DEFAULT_SHADOW_BIAS));
    expect(
      l
        .subarray(SUN_VIEW_PROJ_OFFSET_FLOATS, SUN_VIEW_PROJ_OFFSET_FLOATS + 16)
        .some((v) => v !== 0),
    ).toBe(true);
    // Scene stats count scene draws only.
    expect(r.stats.instances).toBe(4);
    expect(fake.errors).toEqual([]);
  });

  it('castShadow overrides the layout default both ways; a frame with no casters renders no pass', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    r.camera = Camera.perspective(1, 1, 0.1, 100);
    const seen = captureGlobals(fake);
    let f = r.beginFrame(0, 0);
    sunShadowOn(f);
    f.mesh(cube, m, new Transform(), { castShadow: false });
    f.sprite(m, { x: 0, y: 0, castShadow: true });
    r.endFrame();
    const sp = shadowPasses(fake)[0]!;
    // The cube at the eye is view-culled (and casts nothing); the sprite's shadow copy follows it.
    expect(r.stats.culled).toBe(1);
    expect(draws(sp.commands).map((d) => [d.firstInstance, d.instances])).toEqual([[1, 1]]);
    expect(
      (sp.commands.find((c) => c.op === 'setPipeline') as { pipeline: { label: string } }).pipeline
        .label,
    ).toBe('engine-shadow:2d');

    f = r.beginFrame(1, 0);
    sunShadowOn(f);
    f.mesh(cube, m, new Transform(), { castShadow: false });
    r.endFrame();
    expect(shadowPasses(fake).length).toBe(1);
    expect(seen.at(-1)![128 + SHADOW_PARAMS_OFFSET_FLOATS + 2]).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('receiveShadow: false sets instance flag bit 0; the default leaves it 0', () => {
    const { fake, r } = setup();
    const cap = captureInstances(fake);
    const f = r.beginFrame(0, 0);
    f.sprite(null, { x: 0, y: 0 });
    f.sprite(null, { x: 1, y: 0, receiveShadow: false });
    f.sprite(null, { x: 2, y: 0, receiveShadow: true });
    r.endFrame();
    expect(column(cap.last(), INSTANCE_OFFSET.flags)).toEqual([0, 1, 0]);
  });

  it('a 2D frame with sun.shadow set but only sprites is untouched: no pass, no map', () => {
    const { fake, r } = setup();
    const f = r.beginFrame(0, 0);
    sunShadowOn(f);
    f.sprite(null, { x: 0, y: 0 });
    r.endFrame();
    expect(shadowPasses(fake)).toEqual([]);
    expect(fake.textures.some((t) => t.label === 'engine-shadow-map')).toBe(false);
  });

  it('places the sun camera as an ortho box of half-width extent centred on the camera', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    r.camera = Camera.perspective(1, 1, 0.1, 100).lookAt([3, 4, 5], [0, 0, 0]);
    const seen = captureGlobals(fake);
    const f = r.beginFrame(0, 0);
    f.lights.sun.dir = [0, -1, 0];
    f.lights.sun.shadow = { extent: 10, size: 1024, bias: 0.01 };
    f.mesh(cube, m, new Transform());
    r.endFrame();
    const l = seen.at(-1)!.subarray(128, 128 + LIGHTS_BLOCK_FLOATS);
    const vp = l.subarray(SUN_VIEW_PROJ_OFFSET_FLOATS, SUN_VIEW_PROJ_OFFSET_FLOATS + 16);
    const project = (p: number[]) => {
      const x = vp[0]! * p[0]! + vp[4]! * p[1]! + vp[8]! * p[2]! + vp[12]!;
      const y = vp[1]! * p[0]! + vp[5]! * p[1]! + vp[9]! * p[2]! + vp[13]!;
      const z = vp[2]! * p[0]! + vp[6]! * p[1]! + vp[10]! * p[2]! + vp[14]!;
      return [x, y, z];
    };
    // The camera position maps to the centre of the box at mid depth.
    const centre = project([3, 4, 5]);
    expect(centre[0]).toBeCloseTo(0, 5);
    expect(centre[1]).toBeCloseTo(0, 5);
    expect(centre[2]).toBeCloseTo(0.5, 5);
    // `extent` world units sideways reach the clip edge; the light's far end (down) maps to 1.
    const edge = project([13, 4, 5]);
    expect(Math.hypot(edge[0]!, edge[1]!)).toBeCloseTo(1, 5);
    expect(project([3, -6, 5])[2]).toBeCloseTo(1, 5);
    expect(project([3, 14, 5])[2]).toBeCloseTo(0, 5);
    expect([...l.subarray(SHADOW_PARAMS_OFFSET_FLOATS, SHADOW_PARAMS_OFFSET_FLOATS + 3)]).toEqual(
      [0.01, 1 / 1024, 1].map(Math.fround),
    );
    const map = fake.textures.find((t) => t.label === 'engine-shadow-map')!;
    expect(map.width).toBe(1024);
    expect(fake.errors).toEqual([]);
  });

  it('allocates nothing after the first shadowed frame; a size change replaces the map after submit', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    r.camera = Camera.perspective(1, 1, 0.1, 100); // the cube at the eye is view-culled, still casts
    const frame = (size: 1024 | 2048) => {
      const f = r.beginFrame(0, 0);
      sunShadowOn(f);
      f.lights.sun.shadow!.size = size;
      f.mesh(cube, m, new Transform());
      r.endFrame();
    };
    frame(2048);
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 5; i++) frame(2048);
    expect(counts()).toEqual(before);
    frame(1024);
    const maps = fake.textures.filter((t) => t.label === 'engine-shadow-map');
    expect(maps.map((t) => [t.width, t.destroyed])).toEqual([
      [2048, true],
      [1024, false],
    ]);
    expect(fake.errors).toEqual([]);
  });

  it('two shadowed views in one frame get their own shadow uniforms and passes', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    const a = Camera.perspective(1, 1, 0.1, 100);
    const b = Camera.perspective(1, 1, 0.1, 100);
    b.screen.width = 0.5;
    const f = r.beginFrame(0, 0);
    sunShadowOn(f);
    f.mesh(cube, m, new Transform());
    r.render(f, a);
    r.render(f, b);
    r.endFrame();
    expect(fake.passes.map((p) => p.label).filter((l) => l === 'shadow' || l === 'scene')).toEqual([
      'shadow',
      'scene',
      'shadow',
      'scene',
    ]);
    expect(
      fake.buffers.filter((x) => (x.label ?? '').startsWith('engine-shadow-globals')).length,
    ).toBe(2);
    expect(fake.errors).toEqual([]);
  });

  it('a caster behind the camera still shadows (ws/shadow-cull); one outside the sun box does not', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const cube = r.createMesh({
      vertices: CUBE,
      layout: VERTEX_LAYOUT_3D,
      bounds: { center: [0, 0, 0], radius: 1 },
    });
    // At the origin looking down -z: z = +10 is behind the camera, z = -10 in front.
    r.camera = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
    const receiver = new Transform({ z: -10 });
    const behind = new Transform({ z: 10 });
    const farOut = new Transform({ x: 100, z: -10 }); // outside the view and the 20-unit sun box
    const frame = () => {
      const f = r.beginFrame(0, 0);
      sunShadowOn(f);
      f.mesh(cube, m, receiver);
      f.mesh(cube, m, behind);
      f.mesh(cube, m, farOut);
      r.endFrame();
    };
    frame();
    // The scene pass is view-culled as before: one of three drawn, two culled.
    expect(r.stats.culled).toBe(2);
    expect(r.stats.instances).toBe(1);
    expect(draws(sceneCommands(fake))).toHaveLength(1);
    // The shadow pass draws the receiver and the caster behind the camera, not the far one.
    const sp = shadowPasses(fake)[0]!;
    expect(draws(sp.commands).map((d) => [d.firstInstance, d.instances])).toEqual([[1, 2]]);
    expect(r.stats.shadowDraws).toBe(2);
    const bind = sp.commands.find((c) => c.op === 'setBindGroup') as { group: FakeBindGroup };
    expect(bind.group.label).toBe('engine-shadow-globals-group-0');
    // Steady state: frames with culled casters allocate no GPU objects.
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 3; i++) frame();
    expect(counts()).toEqual(before);
    expect(r.stats.shadowDraws).toBe(2);
    // Turning the camera round swaps which caster the scene sees; the shadow pass is unchanged.
    r.camera.lookAt([0, 0, 0], [0, 0, 1]);
    frame();
    expect(r.stats.culled).toBe(2);
    expect(draws(shadowPasses(fake).at(-1)!.commands).map((d) => d.instances)).toEqual([2]);
    expect(fake.errors).toEqual([]);
  });

  it('batches shadow draws by mesh then material whatever the scene order; shadowDraws sums over views', () => {
    const { fake, r } = setup();
    const a = r.createMaterial(OPAQUE);
    const b = r.createMaterial({ ...OPAQUE, label: 'b' });
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    const slab = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    r.camera = Camera.perspective(1, 1, 0.1, 100).lookAt([0, 5, 10], [0, 0, 0]);
    const f = r.beginFrame(0, 0);
    sunShadowOn(f);
    // Interleaved meshes and materials at different depths: the depth sort scatters them.
    f.mesh(cube, a, new Transform({ x: 1, z: 3 }));
    f.mesh(slab, b, new Transform({ x: 2, z: -2 }));
    f.mesh(cube, b, new Transform({ x: 3, z: 1 }));
    f.mesh(slab, a, new Transform({ x: 4, z: -1 }));
    f.mesh(cube, a, new Transform({ x: 5, z: 2 }));
    r.endFrame();
    expect(r.stats.instances).toBe(5);
    const sp = shadowPasses(fake)[0]!;
    // Five scene instances first, then (cube: a, a, b), (slab: a, b): four draws, two meshes.
    expect(draws(sp.commands).map((d) => [d.firstInstance, d.instances])).toEqual([
      [5, 2],
      [7, 1],
      [8, 1],
      [9, 1],
    ]);
    // Two mesh switches, each binding the vertex and the instance buffer.
    expect(
      sp.commands.filter((c) => c.op === 'other' && c.name === 'setVertexBuffer'),
    ).toHaveLength(4);
    expect(r.stats.shadowDraws).toBe(5);

    const other = Camera.perspective(1, 1, 0.1, 100).lookAt([10, 5, 0], [0, 0, 0]);
    const g = r.beginFrame(1, 0);
    sunShadowOn(g);
    g.mesh(cube, a, new Transform({ x: 1 }));
    r.render(g, r.camera);
    r.render(g, other);
    r.endFrame();
    expect(r.stats.shadowDraws).toBe(2);
    expect(fake.errors).toEqual([]);
  });

  it('destroy releases the map, the placeholder and the shadow uniform buffers', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const cube = r.createMesh({ vertices: CUBE, layout: VERTEX_LAYOUT_3D });
    r.camera = Camera.perspective(1, 1, 0.1, 100);
    const f = r.beginFrame(0, 0);
    sunShadowOn(f);
    f.mesh(cube, m, new Transform());
    r.endFrame();
    r.destroy();
    expect(fake.textures.filter((t) => t.format === 'depth32float').every((t) => t.destroyed)).toBe(
      true,
    );
    expect(
      fake.buffers
        .filter((x) => (x.label ?? '').startsWith('engine-shadow-globals'))
        .every((x) => x.destroyed),
    ).toBe(true);
  });
});
