import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import { Renderer } from './renderer';

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

  it('binds globals at 0 and the camera block at 1 of group 0', () => {
    const { fake } = setup();
    const g = fake.bindGroups.find((b) => b.label === 'engine-globals-group')!;
    expect(g.layout.entries.map((e) => e.binding)).toEqual([0, 1]);
    expect(g.entries.map((e) => e.resource)).toMatchObject([
      { size: 32 },
      { offset: 256, size: 256 },
    ]);
    const buf = fake.buffers.find((b) => b.label === 'engine-globals')!;
    expect(buf.size).toBe(512);
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
    expect(g.length).toBe(128);
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
