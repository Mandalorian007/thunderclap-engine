import { describe, expect, it } from 'vitest';
import { createRandom } from '../core/random';
import { Camera } from '../render/camera';
import {
  createFakeDevice,
  type FakeBindGroup,
  type FakeDevice,
  type FakeView,
  fakeRendererGpu,
} from '../render/fake-gpu';
import type { Frame } from '../render/frame';
import { Renderer } from '../render/renderer';
import type { TextureLike } from '../render/texture';
import { DECAL_INSTANCE_FLOATS, Decals, type DecalsOptions } from './decals';
import { WGSL_DECAL_BOX, WGSL_DECAL_QUAD } from './decals-wgsl';

const F = DECAL_INSTANCE_FLOATS;

function makeDecals(opts: Partial<DecalsOptions> = {}, withDepth = false) {
  const fake = createFakeDevice();
  const device = fake.device;
  const texture: TextureLike = {
    view: device
      .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
      .createView(),
    width: 4,
    height: 4,
  };
  const depth = withDepth
    ? {
        view: device
          .createTexture({
            size: [64, 32],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          })
          .createView(),
        width: 64,
        height: 32,
      }
    : null;
  const renderer = {
    device,
    globalsLayout: device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    target: { depth },
  } as unknown as Renderer;
  const decals = new Decals(renderer, { texture, ...opts });
  return { fake, decals };
}

const DEPTH_FRAME = { depthFormat: 'depth24plus' } as unknown as Frame;
const FLAT_FRAME = { depthFormat: null } as unknown as Frame;

function data(d: Decals): Float32Array {
  return (d as unknown as { data: Float32Array }).data;
}

function scenePass(fake: FakeDevice) {
  return fake.device.createCommandEncoder().beginRenderPass({ colorAttachments: [] });
}

function pipelineLabel(fake: FakeDevice): string | undefined {
  const cmd = fake.passes.at(-1)!.commands.find((c) => c.op === 'setPipeline');
  return (cmd as { pipeline: { label: string } } | undefined)?.pipeline.label;
}

const floor = (x: number, z: number, extra: Partial<Parameters<Decals['add']>[0]> = {}) => ({
  x,
  y: 0,
  z,
  nx: 0,
  ny: 1,
  nz: 0,
  size: 2,
  ...extra,
});

describe('Decals ring buffer', () => {
  it('returns increasing handles and overwrites the oldest when full', () => {
    const { decals } = makeDecals({ capacity: 3 });
    const h = [0, 1, 2, 3].map((i) => decals.add(floor(i, 0)));
    expect(h[1]).toBeGreaterThan(h[0]!);
    expect(h[3]).toBeGreaterThan(h[2]!);
    expect(decals.count).toBe(3);
    expect(decals.has(h[0]!)).toBe(false);
    expect(decals.has(h[1]!)).toBe(true);
    expect(decals.has(h[3]!)).toBe(true);
    // Slot 0 now holds the second decal (x = 1): its row-2 translation is -x / size.
    expect(data(decals)[3]).toBeCloseTo(-1 / 2);
    expect(data(decals)[2 * F + 3]).toBeCloseTo(-3 / 2);
    // Overwriting again drops the next oldest.
    decals.add(floor(4, 0));
    expect(decals.has(h[1]!)).toBe(false);
    expect(decals.has(h[2]!)).toBe(true);
    expect(decals.count).toBe(3);
  });

  it('remove marks dead and update compacts, keeping the other handles stable', () => {
    const { decals } = makeDecals({ capacity: 8 });
    const a = decals.add(floor(1, 0));
    const b = decals.add(floor(2, 0));
    const c = decals.add(floor(3, 0));
    expect(decals.remove(b)).toBe(true);
    expect(decals.remove(b)).toBe(false);
    expect(decals.count).toBe(2);
    expect(decals.has(b)).toBe(false);
    decals.update(0.1);
    expect(decals.count).toBe(2);
    expect(decals.has(a)).toBe(true);
    expect(decals.has(c)).toBe(true);
    const d = data(decals);
    expect(d[3]).toBeCloseTo(-1 / 2);
    expect(d[F + 3]).toBeCloseTo(-3 / 2);
    expect(decals.ageOf(c)).toBeCloseTo(0.1);
    expect(decals.ageOf(b)).toBe(-1);
    decals.clear();
    expect(decals.count).toBe(0);
    expect(decals.has(a)).toBe(false);
  });

  it('expires decals past their lifetime and writes the normalised age', () => {
    const { decals } = makeDecals({ capacity: 4, lifetime: 1 });
    const short = decals.add(floor(0, 0));
    const forever = decals.add(floor(1, 0, { lifetime: Number.POSITIVE_INFINITY }));
    decals.update(0.5);
    expect(decals.count).toBe(2);
    const d = data(decals);
    expect(d[20]).toBeCloseTo(0.5);
    expect(d[F + 20]).toBe(0);
    decals.update(0.6);
    expect(decals.has(short)).toBe(false);
    expect(decals.has(forever)).toBe(true);
    expect(decals.count).toBe(1);
    expect(d[3]).toBeCloseTo(-1 / 2);
  });
});

describe('Decals instance layout', () => {
  it('packs the world → local rows, the atlas rect, the colour and the lifetime', () => {
    const { decals } = makeDecals({ atlas: { columns: 2, rows: 2 } });
    decals.add({
      x: 4,
      y: 0,
      z: -2,
      nx: 0,
      ny: 1,
      nz: 0,
      size: 4,
      tile: 3,
      color: [0.5, 0.25, 1, 0.75],
      lifetime: 7,
    });
    const d = data(decals);
    // Row 2 is the normal / size with -dot(normal, p) / size.
    expect(Array.from(d.subarray(8, 12))).toEqual([0, 0.25, 0, -0]);
    // Rows 0 and 1 are unit tangents / size, orthogonal to the normal and to each other.
    const r0 = d.subarray(0, 3);
    const r1 = d.subarray(4, 7);
    expect(Math.hypot(r0[0]!, r0[1]!, r0[2]!)).toBeCloseTo(0.25);
    expect(Math.hypot(r1[0]!, r1[1]!, r1[2]!)).toBeCloseTo(0.25);
    expect(r0[0]! * r1[0]! + r0[1]! * r1[1]! + r0[2]! * r1[2]!).toBeCloseTo(0);
    expect(r0[1]).toBeCloseTo(0);
    expect(r1[1]).toBeCloseTo(0);
    // The point itself maps to local 0.
    const px = d[0]! * 4 + d[2]! * -2 + d[3]!;
    const py = d[4]! * 4 + d[6]! * -2 + d[7]!;
    expect(px).toBeCloseTo(0);
    expect(py).toBeCloseTo(0);
    // Tile 3 of a 2×2 atlas is the bottom-right quarter.
    expect(Array.from(d.subarray(12, 16))).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(Array.from(d.subarray(16, 20))).toEqual([0.5, 0.25, 1, 0.75]);
    expect(d[20]).toBe(0);
    expect(d[21]).toBe(7);
    expect(F).toBe(24);
  });

  it('rotation spins the tangents about the normal', () => {
    const { decals } = makeDecals();
    decals.add(floor(0, 0, { rotation: Math.PI / 2, size: 1 }));
    const { decals: plain } = makeDecals();
    plain.add(floor(0, 0, { size: 1 }));
    const a = data(decals);
    const b = data(plain);
    // The rotated x axis is the unrotated y axis.
    expect(a[0]).toBeCloseTo(b[4]!);
    expect(a[2]).toBeCloseTo(b[6]!);
  });
});

describe('Decals draw', () => {
  it('draws one instanced box draw under a depth camera, after a depth copy pass', () => {
    const { fake, decals } = makeDecals({}, true);
    decals.add(floor(0, 0));
    decals.add(floor(1, 0));
    decals.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    expect(decals.activeMode).toBe('box');
    const copy = fake.passes.at(-1)!;
    expect(copy.label).toBe('decals-depth-copy');
    expect(copy.commands.find((c) => c.op === 'draw')).toEqual({
      op: 'draw',
      vertices: 3,
      instances: 1,
      firstInstance: 0,
    });
    // The instance upload covers exactly the live decals.
    const upload = fake.writes.find((w) => w.buffer.label === 'decals-instances');
    expect(upload?.bytes).toBe(2 * F * 4);
    decals.draw(scenePass(fake), DEPTH_FRAME);
    expect(pipelineLabel(fake)).toBe('decals:box:depth24plus');
    const cmds = fake.passes.at(-1)!.commands;
    expect(cmds.filter((c) => c.op === 'drawIndexed')).toEqual([
      { op: 'drawIndexed', indices: 36, instances: 2, firstInstance: 0 },
    ]);
    const pipe = (cmds[0] as { pipeline: { desc: GPURenderPipelineDescriptor } }).pipeline.desc;
    expect(pipe.depthStencil).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'always',
    });
    expect(fake.errors).toEqual([]);
  });

  it('falls back to the quad without a depth camera (depth test on, write off)', () => {
    const { fake, decals } = makeDecals();
    decals.add(floor(0, 0));
    decals.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    expect(decals.activeMode).toBe('quad');
    expect(fake.passes).toHaveLength(0);
    decals.draw(scenePass(fake), FLAT_FRAME);
    expect(pipelineLabel(fake)).toBe('decals:quad:none');
    const cmds = fake.passes.at(-1)!.commands;
    expect(cmds.filter((c) => c.op === 'drawIndexed')).toEqual([
      { op: 'drawIndexed', indices: 6, instances: 1, firstInstance: 0 },
    ]);
    const { fake: f2, decals: d2 } = makeDecals({ mode: 'quad' }, true);
    d2.add(floor(0, 0));
    d2.prepare(f2.device.createCommandEncoder(), DEPTH_FRAME);
    expect(d2.activeMode).toBe('quad');
    d2.draw(scenePass(f2), DEPTH_FRAME);
    const pipe = (
      f2.passes.at(-1)!.commands[0] as { pipeline: { desc: GPURenderPipelineDescriptor } }
    ).pipeline.desc;
    expect(pipe.depthStencil).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    });
  });

  it('box mode draws nothing before the scene has depth, and nothing when empty', () => {
    const { fake, decals } = makeDecals({ mode: 'box' });
    decals.add(floor(0, 0));
    decals.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    expect(decals.activeMode).toBe('box');
    decals.draw(scenePass(fake), DEPTH_FRAME);
    expect(fake.passes.at(-1)!.commands.some((c) => c.op === 'drawIndexed')).toBe(false);
    const { fake: f2, decals: empty } = makeDecals({}, true);
    empty.prepare(f2.device.createCommandEncoder(), DEPTH_FRAME);
    empty.draw(scenePass(f2), DEPTH_FRAME);
    expect(f2.passes.at(-1)!.commands).toEqual([]);
    expect(f2.writes.some((w) => w.buffer.label === 'decals-instances')).toBe(false);
  });

  it('multiply blend multiplies the destination; the shaders name every binding', () => {
    const { fake, decals } = makeDecals({ blend: 'multiply' });
    decals.add(floor(0, 0));
    decals.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    decals.draw(scenePass(fake), FLAT_FRAME);
    const pipe = (
      fake.passes.at(-1)!.commands[0] as { pipeline: { desc: GPURenderPipelineDescriptor } }
    ).pipeline.desc;
    const target = pipe.fragment!.targets[0] as GPUColorTargetState;
    expect(target.blend?.color.srcFactor).toBe('dst');
    const params = (decals as unknown as { params: Float32Array }).params;
    expect(params[19]).toBe(1);
    for (const wgsl of [WGSL_DECAL_BOX, WGSL_DECAL_QUAD]) {
      expect(wgsl).toContain('@group(1) @binding(0) var<uniform> decal');
      expect(wgsl).toContain('@group(1) @binding(3) var scene_depth: texture_depth_2d');
      expect(wgsl).toContain('@location(8) life');
    }
    expect(WGSL_DECAL_BOX).toContain('inv_view_proj * vec4f(ndc, d, 1.0)');
    expect(fake.errors).toEqual([]);
  });
});

describe('Decals on the depth hook (ws/fx-4)', () => {
  function real(opts: Partial<DecalsOptions> = {}) {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    r.camera = Camera.perspective(1, 1, 0.1, 100).lookAt([0, 5, 10], [0, 0, 0]);
    const tex = fake.device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const decals = new Decals(r, {
      texture: { view: tex.createView(), width: 4, height: 4 },
      ...opts,
    });
    decals.add(floor(0, 0));
    return { fake, r, decals };
  }

  function frame(r: Renderer, decals: Decals) {
    const f = r.beginFrame(0, 0);
    f.drawable(decals, 1);
    r.endFrame();
  }

  /** The depth view bound (binding 3) by the decal box draw in `pass`. */
  function boundDepth(fake: FakeDevice, label: string): FakeView | undefined {
    const pass = [...fake.passes].reverse().find((p) => p.label === label)!;
    const set = pass.commands.find(
      (c) =>
        c.op === 'setBindGroup' && c.index === 1 && (c.group as FakeBindGroup).label === 'decals',
    ) as { group: FakeBindGroup } | undefined;
    return set?.group.entries.find((e) => e.binding === 3)?.resource as FakeView | undefined;
  }

  it("reads depth by default and binds this frame's depth copy in the blended pass", () => {
    const { fake, r, decals } = real();
    expect(decals.readsDepth).toBe(true);
    frame(r, decals);
    const labels = fake.passes.map((p) => p.label);
    expect(labels).toContain('scene-blend');
    expect(labels).not.toContain('decals-depth-copy');
    expect(decals.activeMode).toBe('box');
    const view = boundDepth(fake, 'scene-blend');
    expect(view?.texture).toBe(r.target.depthCopy!.texture as unknown);
    // The copy is taken after this frame's opaque pass.
    const copy = fake.textureCopies.at(-1)!;
    expect(copy.dst).toBe(view!.texture);
    const blend = fake.passes.map((p) => p.label).lastIndexOf('scene-blend');
    expect(copy.afterPasses).toBe(blend);
    expect(fake.errors).toEqual([]);
  });

  it("reuses its hook bind group while the renderer's copy is unchanged", () => {
    const { fake, r, decals } = real();
    frame(r, decals);
    const groups = fake.bindGroups.filter((g) => g.label === 'decals').length;
    for (let i = 0; i < 5; i++) frame(r, decals);
    expect(fake.bindGroups.filter((g) => g.label === 'decals').length).toBe(groups);
    expect(boundDepth(fake, 'scene-blend')?.texture).toBe(r.target.depthCopy!.texture as unknown);
  });

  it("readsDepth: false is the fallback copy of last frame's depth in prepare", () => {
    const { fake, r, decals } = real({ readsDepth: false });
    frame(r, decals); // no scene depth yet on the first frame: nothing to copy
    frame(r, decals);
    const labels = fake.passes.map((p) => p.label);
    expect(labels).not.toContain('scene-blend');
    const copyAt = labels.lastIndexOf('decals-depth-copy');
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(copyAt).toBeLessThan(labels.lastIndexOf('scene'));
    expect(boundDepth(fake, 'scene')?.texture.label).toBe('decals-depth');
  });

  it("mode 'quad' does not read depth (no pass split)", () => {
    const { fake, r, decals } = real({ mode: 'quad' });
    expect(decals.readsDepth).toBe(false);
    frame(r, decals);
    expect(fake.passes.map((p) => p.label)).not.toContain('scene-blend');
  });
});

describe('Decals random (ws/fx-4)', () => {
  it("'random' rotation and tile draw from the decals' stream, the same under the same seed", () => {
    const rows = (seed: number) => {
      const { decals } = makeDecals({ atlas: { columns: 4, rows: 2 }, random: createRandom(seed) });
      for (let i = 0; i < 6; i++) decals.add(floor(i, 0, { rotation: 'random', tile: 'random' }));
      return Array.from(data(decals).subarray(0, 6 * F));
    };
    expect(rows(7)).toEqual(rows(7));
    expect(rows(7)).not.toEqual(rows(8));
    const d = rows(7);
    for (let i = 0; i < 6; i++) {
      const u = d[i * F + 12]!;
      const v = d[i * F + 13]!;
      expect([0, 0.25, 0.5, 0.75]).toContain(u);
      expect([0, 0.5]).toContain(v);
    }
  });
});
