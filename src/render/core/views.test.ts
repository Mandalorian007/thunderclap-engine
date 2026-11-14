/**
 * ws/core-views: plural views on the render core. A stereo pair is one cull group: one cull
 * dispatch, one slot upload and one bundle serve both eyes, so stereo costs the single-view frame
 * plus a constant. The union frustum holds both eyes. A camera-relative origin keeps a scene
 * 100 km out as precise as one at the origin.
 */
import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { createWorkMeter, expectProportional } from '../../testing/budget';
import { Camera } from '../camera';
import { createFakeDevice, type FakeBuffer, type FakeDevice, type FakePass } from '../fake-gpu';
import { Arena } from './arena';
import { createRenderCore, type RenderCore, type RenderCoreOptions } from './core';
import { ARGS_WORDS, cullSlotsCpu, SLOT, SLOT_WORDS } from './cull';
import type { DrawSet, DrawSetDesc } from './draw-set';
import { createInstanceLayout, createVertexLayout } from './layout';
import {
  type CullGroup,
  createRenderView,
  type RenderView,
  setViewFromCamera,
  sphereInPlanes,
  unionPlanesInto,
  VIEW_SLOT,
  VIEW_SLOT_FLOATS,
} from './view';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const PLACE = createInstanceLayout({
  stride: 16,
  attributes: [{ name: 'place', format: 'float32x4', offset: 0 }],
});
const SHADER = {
  code: '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(in.place); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
};
const IPD = 0.064;

interface Scene {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  set: DrawSet;
  /** Mono: the centre eye. */
  mono: RenderView;
  /** Stereo: left and right eyes. */
  left: RenderView;
  right: RenderView;
  centre: Camera;
  eyes: [Camera, Camera];
}

/** Point the three cameras at `target` from `eye`, the stereo pair `IPD` apart. */
function aim(s: Pick<Scene, 'centre' | 'eyes'>, eye: number[], target: number[]): void {
  s.centre.lookAt(eye, target);
  const fx = target[0]! - eye[0]!;
  const fz = target[2]! - eye[2]!;
  const l = Math.hypot(fx, fz) || 1;
  // Right = forward × up, in the ground plane.
  const rx = -fz / l;
  const rz = fx / l;
  for (const [cam, k] of [
    [s.eyes[0], -0.5],
    [s.eyes[1], 0.5],
  ] as const) {
    const e = [eye[0]! + rx * IPD * k, eye[1]!, eye[2]! + rz * IPD * k];
    cam.lookAt(e, [target[0]! + rx * IPD * k, target[1]!, target[2]! + rz * IPD * k]);
  }
}

/** A grid of `n` boxes in one set, seen from above; `place` offsets the world (and its origins). */
function scene(
  n: number,
  opts: {
    core?: RenderCoreOptions;
    cull?: DrawSetDesc['cull'];
    kind?: DrawSetDesc['kind'];
    device?: (d: GPUDevice) => GPUDevice;
    at?: [number, number, number];
  } = {},
): Scene {
  const fake = createFakeDevice();
  const device = opts.device
    ? opts.device(fake.device as unknown as GPUDevice)
    : (fake.device as unknown as GPUDevice);
  const core = createRenderCore(device, opts.core);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 20 });
  const instances = new Arena(device, { kind: 'instance', blockBytes: 1 << 20 });
  const set = core.createDrawSet({
    label: 'boxes',
    shader: SHADER,
    vertexLayout: PACKED,
    instanceLayout: PLACE,
    vertices,
    instances,
    capacity: 8192,
    kind: opts.kind ?? 'static',
    cull: opts.cull ?? 'gpu',
  });
  const box = vertices.alloc(24 * 8, 8);
  vertices.write(box, new Uint32Array(48));
  const side = Math.ceil(Math.sqrt(n));
  const at = opts.at ?? [0, 0, 0];
  const place = new Float32Array([0, 0, 0, 1]);
  for (let i = 0; i < n; i++) {
    const x = (i % side) * 4;
    const z = Math.floor(i / side) * 4;
    const inst = instances.alloc(16, 16);
    instances.write(inst, place);
    set.add({
      vertices: box,
      indexCount: 36,
      instances: inst,
      bounds: [0, 0, 0, 1.8],
      origin: opts.core?.originGrid ? [at[0] + x, at[1], at[2] + z] : undefined,
      ...(opts.core?.originGrid ? {} : { bounds: [x, 0, z, 1.8] }),
    });
  }
  const make = () => Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  const s = { centre: make(), eyes: [make(), make()] as [Camera, Camera] };
  const c = side * 2;
  aim(s, [at[0] + c, at[1] + 60, at[2] + c - 30], [at[0] + c, at[1], at[2] + c]);
  const view = (cam: Camera) => setViewFromCamera(createRenderView(), cam);
  return {
    fake,
    device,
    core,
    set,
    mono: view(s.centre),
    left: view(s.eyes[0]),
    right: view(s.eyes[1]),
    ...s,
  };
}

function refresh(s: Scene): void {
  setViewFromCamera(s.mono, s.centre);
  setViewFromCamera(s.left, s.eyes[0]);
  setViewFromCamera(s.right, s.eyes[1]);
}

const target = (device: GPUDevice) => {
  const tex = device.createTexture({
    size: [640, 360],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    view: tex.createView(),
    format: 'bgra8unorm' as GPUTextureFormat,
    width: 640,
    height: 360,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  };
};

/** One mono frame. */
function monoFrame(s: Scene, t = target(s.device)): void {
  const enc = s.device.createCommandEncoder();
  s.core.prepare(enc, [s.mono]);
  s.core.draw(enc, 0, t);
  s.device.queue.submit([enc.finish()]);
}

/** One stereo frame: both eyes one cull group (or `'each'`), into one target. */
function stereoFrame(
  s: Scene,
  t = target(s.device),
  planes: CullGroup['planes'] = 'union',
  groups: CullGroup[] = [{ views: [s.left, s.right], planes }],
): void {
  const enc = s.device.createCommandEncoder();
  s.core.prepare(enc, groups);
  s.core.draw(enc, 0, t);
  s.core.draw(enc, 1, { ...t, clear: undefined });
  s.device.queue.submit([enc.finish()]);
}

/** GPU calls of `run`. */
function calls(s: Scene, run: () => void): number {
  const before = s.fake.calls;
  run();
  return s.fake.calls - before;
}

/** Run compute passes through the cull's CPU twin, reading the views at the binding's offset. */
function cullOnSubmit(s: Scene): void {
  s.fake.runPass = (pass: FakePass) => {
    if (pass.kind !== 'compute') return;
    let group: { entries: GPUBindGroupEntry[] } | null = null;
    for (const c of pass.commands) {
      if (c.op === 'setBindGroup') group = c.group as { entries: GPUBindGroupEntry[] };
      if (c.op !== 'dispatch' || !group) continue;
      const res = (i: number) =>
        group!.entries[i]!.resource as unknown as { buffer: FakeBuffer; offset?: number };
      const params = new Uint32Array(res(1).buffer.data.buffer, 0, 4);
      const slots = res(2).buffer.data.buffer;
      const views = new Float32Array(res(0).buffer.data.buffer, res(0).offset ?? 0);
      cullSlotsCpu(
        new Float32Array(slots),
        new Uint32Array(slots),
        params[0]!,
        params[1]!,
        views,
        params[2]!,
        params[3] !== 0,
        new Uint32Array(res(3).buffer.data.buffer),
      );
    }
  };
}

/** Visible slots of argument set `g` in a set's args buffer. */
function visibleIn(s: Scene, g: number, n: number): number {
  const u = new Uint32Array(s.fake.buffers.find((b) => b.label === 'boxes args')!.data.buffer);
  let seen = 0;
  for (let i = 0; i < n; i++) if (u[(g * 8192 + i) * ARGS_WORDS + 1]) seen++;
  return seen;
}

describe('cull groups (ws/core-views)', () => {
  it('stereo costs the mono frame plus a constant, at 1,500 and 6,000 meshes', () => {
    const rows = [1500, 6000].map((n) => {
      const s = scene(n);
      monoFrame(s);
      const mono = calls(s, () => monoFrame(s));
      const monoStats = { ...s.core.stats };
      const t = scene(n);
      stereoFrame(t);
      const stereo = calls(t, () => stereoFrame(t));
      const st = t.core.stats;
      expect(t.fake.errors).toEqual([]);
      // One cull, one upload, one bundle for both eyes.
      expect(st.dispatches).toBe(monoStats.dispatches);
      expect(st.dispatches).toBe(1);
      expect(st.slotBytes).toBe(monoStats.slotBytes);
      expect(st.bundleBuilds).toBe(1);
      expect(st.bundles).toBe(2);
      expect(st.passes).toBe(2);
      return { mono, stereo };
    });
    // Mono: write, compute (5), render pass (3), submit. Stereo adds, per eye, the copy of its
    // view into the group's binding, and the second eye's render pass (3).
    expect(rows[0]!.mono).toBe(10);
    expect(rows[0]!.stereo).toBe(rows[0]!.mono + 5);
    expect(rows[1]).toEqual(rows[0]);
  });

  it('each eye copies its own view slot into the binding the shared bundle reads', () => {
    const s = scene(16);
    stereoFrame(s);
    const copies = s.fake.bufferCopies.slice(-2);
    expect(copies.map((c) => [c.src.label, c.srcOffset, c.dst.label, c.size])).toEqual([
      ['core views', 0, 'core current view', 256],
      ['core views', 256, 'core current view', 256],
    ]);
    // Both eyes' passes execute the one bundle.
    const [a, b] = s.fake.passes.filter((p) => p.kind === 'render').slice(-2);
    const ex = (p: FakePass) => p.commands.find((c) => c.op === 'executeBundles');
    expect(ex(a!)).toEqual(ex(b!));
  });

  it("'each' culls every view on its own: a bundle and a dispatch row per view", () => {
    const s = scene(64);
    stereoFrame(s, undefined, 'each');
    expect(s.core.groups).toBe(2);
    expect(s.core.stats.bundleBuilds).toBe(2);
    expect(s.core.stats.dispatches).toBe(1);
    const d = s.fake.passes
      .filter((p) => p.kind === 'compute')
      .at(-1)!
      .commands.find((c) => c.op === 'dispatch');
    expect(d && d.op === 'dispatch' && d.y).toBe(2);
    // Plain view lists keep their B1 meaning: a group each, no copies.
    const t = scene(64);
    const enc = t.device.createCommandEncoder();
    t.core.prepare(enc, [t.left, t.right]);
    t.core.draw(enc, 0, target(t.device));
    t.core.draw(enc, 1, target(t.device));
    expect(t.core.groups).toBe(2);
    expect(t.fake.bufferCopies).toHaveLength(0);
  });

  it('the GPU cull writes one argument set for the pair from the union frustum', () => {
    const s = scene(64);
    cullOnSubmit(s);
    aim(s, [16, 2, 16], [16, 2, 100]);
    refresh(s);
    stereoFrame(s);
    const pair = visibleIn(s, 0, 64);
    monoFrame(s);
    const mono = visibleIn(s, 0, 64);
    expect(pair).toBeGreaterThan(0);
    expect(pair).toBeLessThan(64);
    // The union holds the centre eye's set and at most a little more.
    expect(pair).toBeGreaterThanOrEqual(mono);
    expect(pair).toBeLessThanOrEqual(Math.ceil(mono * 1.15));
  });

  it('a CPU-culled set culls once per group, not once per eye', () => {
    const s = scene(64, { cull: 'cpu' });
    aim(s, [16, 2, 16], [16, 2, 100]);
    refresh(s);
    stereoFrame(s);
    const [a, b] = s.fake.passes.filter((p) => p.kind === 'render').slice(-2);
    const draws = (p: FakePass) => p.commands.filter((c) => c.op === 'drawIndexed').length;
    expect(draws(a!)).toBeGreaterThan(0);
    expect(draws(a!)).toBeLessThan(64);
    expect(draws(b!)).toBe(draws(a!));
  });

  it('a viewport draws one view into a rectangle of the target', () => {
    const s = scene(4);
    const t = target(s.device);
    const enc = s.device.createCommandEncoder();
    s.core.prepare(enc, [{ views: [s.left, s.right] }]);
    s.core.draw(enc, 0, { ...t, viewport: { x: 0, y: 0, width: 320, height: 360 } });
    s.core.draw(enc, 1, {
      ...t,
      clear: undefined,
      viewport: { x: 320, y: 0, width: 320, height: 360 },
    });
    const passes = s.fake.passes.filter((p) => p.kind === 'render');
    const vp = passes.map((p) =>
      p.commands.find((c) => c.op === 'other' && c.name === 'setViewport'),
    );
    expect(vp.map((c) => c && c.op === 'other' && c.args)).toEqual([
      [0, 0, 320, 360, 0, 1],
      [320, 0, 320, 360, 0, 1],
    ]);
  });

  it('the fake GPU splits calls by view through the core hook', () => {
    const s = scene(100);
    s.core.onView = (i) => s.fake.markView(`eye ${i}`);
    stereoFrame(s);
    const before = new Map(s.fake.callsByView);
    s.fake.markView('frame');
    stereoFrame(s);
    const per = (k: string) => s.fake.callsByView.get(k)! - (before.get(k) ?? 0);
    // Each eye: the copy and its render pass (begin, executeBundles, end); eye 1 also takes the
    // submit, which follows it.
    expect(per('eye 0')).toBe(4);
    expect(per('eye 1')).toBe(5);
    // The view-buffer write and the cull pass (begin, pipeline, group, dispatch, end).
    expect(per('frame')).toBe(6);
    const tagged = s.fake.passes.slice(-2).map((p) => p.view);
    expect(tagged).toEqual(['eye 0', 'eye 1']);
  });

  it("the work meter's per-view split: each eye's work is flat in the scene's size", () => {
    const perEye = (n: number) => {
      let meter: ReturnType<typeof createWorkMeter> | null = null;
      const s = scene(n, {
        device: (d) => {
          meter = createWorkMeter(d);
          return meter.device;
        },
      });
      s.core.onView = (i) => meter!.view(`eye ${i}`);
      const r = meter!.run(() => stereoFrame(s), { frames: 4, warmup: 2 });
      // The copy and the render pass (begin, executeBundles, end); the submit follows eye 1.
      expect(r.views['eye 0']!.commands).toBe(4);
      return r.views['eye 1']!.commands + r.views.frame!.commands;
    };
    expectProportional(perEye, [100, 1000, 4000], { shape: 'flat', label: 'stereo commands' });
  });

  it('a stereo frame of a held scene allocates nothing', () => {
    const s = scene(1500);
    const t = target(s.device);
    const t1 = { ...t, clear: undefined };
    stereoFrame(s, t);
    const noop = () => {};
    const pass = {
      setPipeline: noop,
      setBindGroup: noop,
      setVertexBuffer: noop,
      setIndexBuffer: noop,
      drawIndexedIndirect: noop,
      dispatchWorkgroups: noop,
      executeBundles: noop,
      end: noop,
    };
    const enc = {
      beginComputePass: () => pass,
      beginRenderPass: () => pass,
      copyBufferToBuffer: noop,
    } as unknown as GPUCommandEncoder;
    (s.device.queue as unknown as { writeBuffer: unknown }).writeBuffer = noop;
    const groups: CullGroup[] = [{ views: [s.left, s.right] }];
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        s.core.prepare(enc, groups);
        s.core.draw(enc, 0, t);
        s.core.draw(enc, 1, t1);
      }
    };
    run(20_000);
    let bytes = Infinity;
    for (let r = 0; r < 5; r++)
      bytes = Math.min(
        bytes,
        allocated(() => run(2000)),
      );
    // Under 8 bytes a frame: one real allocation per frame (a typed array, a closure, a copied
    // view list) would be ≥ 64 KB over 2,000 frames, while V8's own bookkeeping under a loaded
    // machine is about 1 KB.
    expect(bytes).toBeLessThan(2000 * 8);
  });
});

describe('the union frustum (ws/core-views)', () => {
  it('holds every point either eye sees, and not much more', () => {
    const s = scene(1);
    aim(s, [3, 1.7, -2], [10, 1.2, 40]);
    refresh(s);
    const out = new Float32Array(24);
    const ok = unionPlanesInto(out, 0, [s.left, s.right], 0, 2, new Float64Array(3), false);
    expect(ok).toBe(true);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let inEye = 0;
    let inUnionOnly = 0;
    for (let i = 0; i < 20_000; i++) {
      const p = [3 + (rnd() - 0.5) * 200, 1.7 + (rnd() - 0.5) * 120, -2 + rnd() * 220];
      const eyes =
        sphereInPlanes(s.left.planes, 0, p[0]!, p[1]!, p[2]!, 0) ||
        sphereInPlanes(s.right.planes, 0, p[0]!, p[1]!, p[2]!, 0);
      const union = sphereInPlanes(out, 0, p[0]!, p[1]!, p[2]!, 1e-4);
      if (eyes) {
        inEye++;
        expect(union, `point ${p}`).toBe(true);
      } else if (union) inUnionOnly++;
    }
    expect(inEye).toBeGreaterThan(500);
    expect(inUnionOnly / inEye).toBeLessThan(0.15);
  });

  it('views without a projection fall back to planes that cull nothing', () => {
    const s = scene(16);
    cullOnSubmit(s);
    const bare = (v: RenderView): RenderView => ({
      viewProj: v.viewProj,
      planes: v.planes,
      position: v.position,
    });
    stereoFrame(s, undefined, 'union', [{ views: [bare(s.left), bare(s.right)] }]);
    expect(s.fake.errors).toEqual([]);
    expect(visibleIn(s, 0, 16)).toBe(16);
  });
});

describe('camera-relative origin (ws/core-views)', () => {
  const FAR: [number, number, number] = [100_000, 30, -100_000];

  it('a scene 100 km out writes the same GPU numbers as the scene at the origin', () => {
    const near = scene(16, { core: { originGrid: 1024 } });
    const far = scene(16, { core: { originGrid: 1024 }, at: FAR });
    monoFrame(near);
    monoFrame(far);
    // The frame origin is the eye snapped to the grid.
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(far.core.origin[k]! % 1024)).toBe(0);
      expect(Math.abs(far.core.origin[k]! - far.mono.eye![k]!)).toBeLessThanOrEqual(512);
    }
    // Relative to their own origins, both views are the same camera.
    const shift = (s: Scene) => Array.from(s.mono.eye!, (e, k) => e - s.core.origin[k]!);
    const dn = shift(near);
    const df = shift(far);
    const slot = (s: Scene) => s.core.viewData.subarray(0, VIEW_SLOT_FLOATS);
    const sn = slot(near);
    const sf = slot(far);
    // Same eye offset from the origin within the grid's float32 step, so near-identical slots.
    for (let k = 0; k < 3; k++) {
      expect(sf[VIEW_SLOT.position + k]).toBeCloseTo(df[k]!, 6);
      expect(sn[VIEW_SLOT.position + k]).toBeCloseTo(dn[k]!, 6);
    }
    expect(sf[VIEW_SLOT.origin]).toBe(far.core.origin[0]);
    // The relative view-projection of the far scene maps a slot to the same clip point as the
    // world matrix computed at float64 would; the plain float32 world matrix would not.
    const clip = (m: ArrayLike<number>, p: number[]) => {
      const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
      return [0, 1].map(
        (r) => (m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!) / w,
      );
    };
    const world = [FAR[0] + 4.25, FAR[1] + 0.5, FAR[2] + 3.75];
    const rel = world.map((x, k) => x - far.core.origin[k]!);
    const truth = (() => {
      // float64 viewProj from the camera's own pieces.
      const p = far.centre.projection;
      const v = far.centre.view;
      const e = far.mono.eye!;
      const r = [world[0]! - e[0]!, world[1]! - e[1]!, world[2]! - e[2]!];
      const ve = [0, 1, 2, 3].map((i) =>
        i === 3 ? 1 : v[i]! * r[0]! + v[4 + i]! * r[1]! + v[8 + i]! * r[2]!,
      );
      return [0, 1].map(
        (row) =>
          (p[row]! * ve[0]! + p[4 + row]! * ve[1]! + p[8 + row]! * ve[2]! + p[12 + row]!) /
          (p[3]! * ve[0]! + p[7]! * ve[1]! + p[11]! * ve[2]! + p[15]!),
      );
    })();
    const got = clip(sf.subarray(0, 16), rel);
    expect(Math.abs(got[0]! - truth[0]!)).toBeLessThan(1e-5);
    expect(Math.abs(got[1]! - truth[1]!)).toBeLessThan(1e-5);
    const naive = clip(far.mono.viewProj, world);
    expect(
      Math.max(Math.abs(naive[0]! - truth[0]!), Math.abs(naive[1]! - truth[1]!)),
    ).toBeGreaterThan(1e-4);
  });

  it('slots carry frame-relative bounds and origins; crossing a grid line rebases them all', () => {
    const s = scene(16, { core: { originGrid: 1024 }, at: FAR });
    monoFrame(s);
    const table = new Float32Array(
      s.fake.buffers.find((b) => b.label === 'boxes slots')!.data.buffer,
    );
    const origins = s.fake.buffers.find((b) => b.label === 'boxes origins')!;
    expect(origins.size).toBe(8192 * 16);
    // Slot 0 sits at FAR; its centre is relative to the frame origin.
    const o = Array.from(s.core.origin);
    expect(table[SLOT.x]).toBeCloseTo(FAR[0] - o[0]!, 3);
    expect(table[SLOT.z]).toBeCloseTo(FAR[2] - o[2]!, 3);
    const rel = s.fake.writes.filter((w) => w.buffer === origins);
    expect(rel.length).toBeGreaterThan(0);
    // The shader gets core_origin, bound per slot at stride 0.
    const bundle = s.fake.bundles.at(-1)!;
    const bound = bundle.commands.filter((c) => c.op === 'other' && c.slot === 2);
    expect(bound).toHaveLength(16);
    expect(bound[3]!.op === 'other' && [bound[3]!.offset, bound[3]!.size]).toEqual([48, 12]);
    // Held: nothing uploads.
    monoFrame(s);
    expect(s.core.stats.slotBytes).toBe(0);
    // Two grid cells east: every slot moves, the bundle does not rebuild.
    aim(s, [FAR[0] + 2048 + 8, FAR[1] + 60, FAR[2] - 22], [FAR[0] + 2048 + 8, FAR[1], FAR[2] + 8]);
    refresh(s);
    const builds = s.core.stats.bundleBuilds;
    monoFrame(s);
    expect(s.core.origin[0]).toBe(o[0]! + 2048);
    expect(s.core.stats.slotBytes).toBe(16 * SLOT_WORDS * 4);
    expect(s.core.stats.bundleBuilds).toBe(builds);
    expect(table[SLOT.x]).toBeCloseTo(FAR[0] - o[0]! - 2048, 3);
    expect(s.fake.errors).toEqual([]);
  });

  it('without originGrid a slot origin is refused and nothing changes', () => {
    const s = scene(4);
    const v = new Arena(s.device, { kind: 'vertex', blockBytes: 4096 });
    expect(() =>
      s.set.add({
        vertices: v.alloc(8, 8),
        indexCount: 6,
        bounds: [0, 0, 0, 1],
        origin: [1, 0, 0],
      }),
    ).toThrow(/originGrid/);
    monoFrame(s);
    expect(s.fake.buffers.some((b) => b.label === 'boxes origins')).toBe(false);
  });
});

/** Bytes allocated while `run` runs (retried until no collection ran during it). */
function allocated(run: () => void): number {
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = new v8.GCProfiler();
    p.start();
    v8.getHeapStatistics();
    const a = v8.getHeapStatistics().used_heap_size;
    run();
    const b = v8.getHeapStatistics().used_heap_size;
    if (p.stop().statistics.length === 0) return b - a;
  }
  throw new Error('a collection ran during every attempt');
}
