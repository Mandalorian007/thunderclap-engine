/**
 * ws/core-passes: the core's hidden bit, coalesced bundle rebuilds and device restore, on the
 * fake GPU (a forced loss: `loseDevice`, then a second fake device).
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakeBundle, type FakeDevice } from '../fake-gpu';
import type { Arena, ArenaAlloc } from './arena';
import { createRenderCore, type RenderCore } from './core';
import { SLOT, SLOT_HIDDEN, SLOT_WORDS } from './cull';
import type { DrawSet, DrawSetDesc } from './draw-set';
import { createVertexLayout } from './layout';
import { createRenderView, type RenderView, setViewFromCamera } from './view';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const SHADER = {
  code: '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(in.place); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
};

interface Scene {
  fake: FakeDevice;
  core: RenderCore;
  vertices: Arena;
  sets: DrawSet[];
  box: ArenaAlloc;
  view: RenderView;
}

function scene(
  n: number,
  sets = 1,
  desc: Partial<DrawSetDesc> = {},
  coalesceRebuilds = true,
): Scene {
  const fake = createFakeDevice();
  const core = createRenderCore(fake.device, { coalesceRebuilds });
  const vertices = core.createArena({ kind: 'vertex', blockBytes: 1 << 16 });
  const box = vertices.alloc(24 * 8, 8);
  vertices.write(box, new Uint32Array(48));
  const out: DrawSet[] = [];
  for (let k = 0; k < sets; k++) {
    const set = core.createDrawSet({
      label: `set ${k}`,
      shader: SHADER,
      vertexLayout: PACKED,
      vertices,
      capacity: 256,
      cull: 'gpu',
      ...desc,
    });
    for (let i = 0; i < n; i++) {
      set.add({ vertices: box, indexCount: 36, bounds: [i * 4, 0, k * 4, 1.8] });
    }
    out.push(set);
  }
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  camera.lookAt([0, 60, -30], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), camera);
  return { fake, core, vertices, sets: out, box, view };
}

function frame(s: Scene): void {
  const tex = s.fake.device.createTexture({
    size: [64, 64],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const enc = s.fake.device.createCommandEncoder();
  s.core.prepare(enc, [s.view]);
  s.core.draw(enc, 0, {
    view: tex.createView(),
    format: 'bgra8unorm',
    width: 64,
    height: 64,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  });
  s.fake.device.queue.submit([enc.finish()]);
}

const draws = (b: { commands: FakeBundle['commands'] }) =>
  b.commands.filter((c) => c.op === 'drawIndexedIndirect' || c.op === 'drawIndexed').length;
/** Draws in the last render pass (a CPU-culled set draws directly). */
const passDraws = (fake: FakeDevice) =>
  draws(fake.passes.filter((p) => p.kind === 'render').at(-1)!);

describe('the hidden bit (ws/core-passes)', () => {
  it('a hidden slot keeps its place, uploads its flag and does not rebuild a GPU set', () => {
    const s = scene(8);
    const set = s.sets[0]!;
    frame(s);
    const builds = s.core.stats.bundleBuilds;
    set.setHidden(3, true);
    expect(set.isHidden(3)).toBe(true);
    expect(set.count).toBe(8);
    frame(s);
    expect(s.core.stats.bundleBuilds).toBe(builds);
    expect(s.core.stats.slotBytes).toBe(48);
    const slots = s.fake.buffers.find((b) => b.label === 'set 0 slots')!;
    const flags = new Uint32Array(slots.data.buffer)[3 * SLOT_WORDS + SLOT.flags]!;
    expect(flags & SLOT_HIDDEN).toBe(SLOT_HIDDEN);
    // A write keeps it hidden; showing clears it.
    set.setBounds(3, 1, 0, 0, 2);
    expect(set.isHidden(3)).toBe(true);
    set.setHidden(3, false);
    expect(set.isHidden(3)).toBe(false);
  });

  it('a CPU-culled set skips hidden slots', () => {
    const s = scene(8, 1, { cull: 'cpu' });
    const set = s.sets[0]!;
    frame(s);
    const all = passDraws(s.fake);
    expect(all).toBeGreaterThan(2);
    set.setHidden(0, true);
    set.setHidden(1, true);
    frame(s);
    expect(passDraws(s.fake)).toBe(all - 2);
  });
});

describe('coalesced bundle rebuilds (ws/core-passes)', () => {
  it('at most one stale set re-records a frame; the others replay their old bundles', () => {
    const s = scene(4, 3);
    frame(s);
    const built = s.core.stats.bundleBuilds;
    for (const set of s.sets) set.remove(0);
    frame(s);
    expect(s.core.stats.bundleBuilds - built).toBe(1);
    expect(s.core.stats.deferredBuilds).toBe(2);
    frame(s);
    expect(s.core.stats.bundleBuilds - built).toBe(2);
    frame(s);
    expect(s.core.stats.bundleBuilds - built).toBe(3);
    expect(s.core.stats.deferredBuilds).toBe(0);
    frame(s);
    expect(s.core.stats.bundleBuilds - built).toBe(3);
  });

  it('with coalesceRebuilds off every stale set re-records at once', () => {
    const s = scene(4, 3, {}, false);
    frame(s);
    const built = s.core.stats.bundleBuilds;
    for (const set of s.sets) set.remove(0);
    frame(s);
    expect(s.core.stats.bundleBuilds - built).toBe(3);
    expect(s.core.stats.deferredBuilds).toBe(0);
  });

  it('a new arena block is never deferred: an old bundle would bind a buffer it lacks', () => {
    const s = scene(4, 2);
    frame(s);
    const built = s.core.stats.bundleBuilds;
    // Fill the block so the next allocation opens a second one.
    const big = s.vertices.alloc((1 << 16) - 256, 8);
    const far = s.vertices.alloc(24 * 8, 8);
    expect(big.block === far.block).toBe(false);
    for (const set of s.sets) set.add({ vertices: far, indexCount: 36, bounds: [0, 0, 0, 1] });
    frame(s);
    expect(s.core.stats.bundleBuilds - built).toBe(2);
  });
});

describe('device restore (ws/core-passes)', () => {
  it('rebuilds arenas, sets, bundles and the cull on the new device; one event', async () => {
    const s = scene(6, 2);
    frame(s);
    expect(s.fake.bundles.length).toBeGreaterThan(0);
    s.fake.loseDevice('unknown', 'forced');
    await s.fake.lost;
    const next = createFakeDevice();
    let events = 0;
    let rewritten = false;
    s.core.onDeviceRestored((device) => {
      events++;
      expect(device).toBe(next.device);
      // The game writes its bytes again; every allocation is still valid.
      s.vertices.write(s.box, new Uint32Array(48));
      rewritten = true;
    });
    s.core.restore(next.device);
    expect(events).toBe(1);
    expect(rewritten).toBe(true);
    expect(s.core.restores).toBe(1);
    expect(s.core.device).toBe(next.device);
    expect(s.vertices.buffers[0]).toBe(next.buffers.find((b) => b.label === 'vertex arena 0'));
    expect(next.buffers.some((b) => b.label === 'set 0 slots')).toBe(true);
    // The next frame records on the new device only, every slot again.
    const old = s.fake.calls;
    s.fake = next;
    frame(s);
    expect(s.fake.calls).toBeGreaterThan(0);
    expect(next.bundles).toHaveLength(2);
    for (const b of next.bundles) expect(draws(b)).toBe(6);
    expect(s.core.stats.slotBytes).toBe(2 * 6 * 48);
    expect(next.errors).toEqual([]);
    expect(old).toBeGreaterThan(0);
  });

  it('keeps hidden bits and removals across a restore', () => {
    const s = scene(5, 1, { cull: 'cpu' });
    const set = s.sets[0]!;
    set.setHidden(1, true);
    set.remove(2);
    frame(s);
    const next = createFakeDevice();
    s.core.restore(next.device);
    s.fake = next;
    frame(s);
    expect(passDraws(next)).toBe(3);
    expect(set.isHidden(1)).toBe(true);
  });

  it('a set made with bind groups waits for new ones', () => {
    const fake0 = createFakeDevice();
    const layout = (d: GPUDevice) => d.createBindGroupLayout({ entries: [] });
    const l0 = layout(fake0.device);
    const s = scene(3, 1, {
      bindGroups: [
        { layout: l0, group: fake0.device.createBindGroup({ layout: l0, entries: [] }) },
      ],
    });
    frame(s);
    const next = createFakeDevice();
    s.core.restore(next.device);
    s.fake = next;
    frame(s);
    expect(next.bundles).toHaveLength(0);
    const l1 = layout(next.device);
    s.sets[0]!.setBindGroups([
      { layout: l1, group: next.device.createBindGroup({ layout: l1, entries: [] }) },
    ]);
    frame(s);
    expect(next.bundles).toHaveLength(1);
  });
});
