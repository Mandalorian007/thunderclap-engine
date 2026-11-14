import { describe, expect, it } from 'vitest';
import { createFakeDevice, fakeSceneTargets } from '../render/fake-gpu';
import type { Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { Transform } from '../render/transform';
import { compileModel } from './compile';
import { MODEL_INSTANCE, MODEL_INSTANCE_FLOATS, ModelInstances } from './instances';
import { createModelScene } from './scene';
import type { MaterialCodeTable, PartModel } from './spec';

const MATS: MaterialCodeTable = {
  body: { color: [0.7, 0.7, 0.7] },
  light: { color: [1, 0.8, 0.3] },
};
const box = (y: number) => ({ type: 'box', from: [-0.5, y, -0.5], to: [0.5, y + 1, 0.5] }) as const;

const SPEC: PartModel = {
  name: 'toy',
  channels: [{ name: 'turn', wrap: Math.PI * 2 }, 'on'],
  parts: [
    { shape: box(0) },
    { name: 'top', motion: { type: 'spin', axis: 'y', channel: 'turn' }, shape: box(1) },
    { name: 'lamp', material: 'light', glow: { channel: 'on' }, shape: box(2) },
  ],
};
const OTHER: PartModel = { name: 'block', parts: [{ shape: box(0) }] };

function make(maxInstances = 64) {
  const fake = createFakeDevice();
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    sceneTargets: fakeSceneTargets,
    target: { auxKey: 0 },
  } as unknown as Renderer;
  const scene = createModelScene(renderer, { materials: MATS, maxInstances });
  let time = 0;
  /** One frame: prepare then draw into a fresh pass; returns the pass's draws and the writes made. */
  const frame = (dt = 1 / 60) => {
    time += dt;
    const f = { time, dt, depthFormat: 'depth24plus', auxKey: 0 } as unknown as Frame;
    const w0 = fake.writes.length;
    const enc = fake.device.createCommandEncoder();
    scene.prepare(enc, f);
    const pass = enc.beginRenderPass({ colorAttachments: [] });
    scene.draw(pass, f);
    pass.end();
    const cmds = fake.passes[fake.passes.length - 1]!.commands;
    return { draws: cmds.filter((c) => c.op === 'draw'), writes: fake.writes.slice(w0) };
  };
  return { fake, scene, frame };
}

describe('ModelInstances', () => {
  it('groups the order by unit and writes only placed slots', () => {
    const toy = compileModel(SPEC, MATS);
    const inst = new ModelInstances({ maxInstances: 16 });
    const t = new Transform();
    inst.placeModel(toy, 0, t);
    inst.placeModel(toy, 5, t);
    const w: number[] = [];
    expect(inst.flush(w)).toBe(true);
    // Slots 0-2 merge into one range, 5-7 into another.
    expect(w).toEqual([
      0,
      3 * MODEL_INSTANCE_FLOATS,
      5 * MODEL_INSTANCE_FLOATS,
      8 * MODEL_INSTANCE_FLOATS,
    ]);
    expect(inst.drawCalls).toBe(3);
    expect(Array.from(inst.order.subarray(0, 6))).toEqual([0, 5, 1, 6, 2, 7]);
    expect(inst.flush(w)).toBe(false);
    expect(w).toEqual([]);
    // Moving one instance writes one slot and keeps the order.
    inst.place(toy.units[1]!, 6, [1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(inst.flush(w)).toBe(false);
    expect(w).toEqual([6 * MODEL_INSTANCE_FLOATS, 7 * MODEL_INSTANCE_FLOATS]);
    inst.remove(0);
    expect(inst.flush(w)).toBe(true);
    expect(inst.instances).toBe(5);
  });

  it('stores channel values back at the base time and rebases after ten minutes', () => {
    const toy = compileModel(SPEC, MATS);
    const inst = new ModelInstances({ maxInstances: 4 });
    inst.advance(100);
    inst.place(toy.units[1]!, 0, new Transform(), { channels: { turn: [1, 2] } });
    const d = inst.slotData(0);
    // value at base 0 = 1 - 2 × 100; the shader adds rate × dt (100) back.
    expect(d[MODEL_INSTANCE.VALUES]! + d[MODEL_INSTANCE.RATES]! * inst.dt).toBeCloseTo(1);
    const w: number[] = [];
    inst.flush(w);
    inst.advance(700);
    expect(inst.stats.rebases).toBe(1);
    expect(inst.dt).toBe(0);
    const v = d[MODEL_INSTANCE.VALUES]!;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(Math.PI * 2);
    // 1 + 2 × 600, wrapped into [0, 2π).
    expect(v).toBeCloseTo((1 + 1200) % (Math.PI * 2), 3);
    inst.flush(w);
    expect(w).toEqual([0, MODEL_INSTANCE_FLOATS]);
  });

  it('rejects slots out of range', () => {
    const inst = new ModelInstances({ maxInstances: 2 });
    const u = compileModel(OTHER, MATS).units[0]!;
    expect(() => inst.place(u, 2, new Transform())).toThrow(RangeError);
    expect(() => inst.place(u, 0.5, new Transform())).toThrow(RangeError);
  });
});

describe('ModelScene budget (fake GPU)', () => {
  it('draws one call per unit in use; a still frame writes no instance bytes', () => {
    const { scene, frame } = make();
    const toy = compileModel(SPEC, MATS);
    const block = compileModel(OTHER, MATS);
    for (let i = 0; i < 10; i++) {
      const t = new Transform().setPosition(i * 2, 0, 0);
      scene.placeModel(toy, i * 3, t, { channels: { turn: [0, 1.5], on: 1 } });
    }
    scene.placeModel(block, 40, new Transform());
    const first = frame();
    expect(first.draws.length).toBe(4); // toy static, top, lamp; block static
    expect(first.draws.map((d) => (d as { instances: number }).instances)).toEqual([10, 10, 10, 1]);
    expect(scene.stats.instanceBytes).toBe(31 * MODEL_INSTANCE_FLOATS * 4);
    const groups = scene.stats.bindGroups;
    for (let k = 0; k < 5; k++) {
      const still = frame();
      expect(still.draws.length).toBe(4);
      // Only the 16-byte frame clock.
      expect(still.writes.length).toBe(1);
      expect(still.writes[0]!.bytes).toBe(16);
    }
    expect(scene.stats.instanceBytes).toBe(31 * MODEL_INSTANCE_FLOATS * 4);
    expect(scene.stats.bindGroups).toBe(groups);
  });

  it('a moved instance writes its slot only; a new model grows the buffers once', () => {
    const { scene, frame } = make();
    const toy = compileModel(SPEC, MATS);
    scene.placeModel(toy, 0, new Transform());
    frame();
    const before = scene.stats.instanceBytes;
    const t = new Transform().setPosition(0, 1, 0);
    scene.place(toy.units[0]!, 0, t);
    frame();
    expect(scene.stats.instanceBytes - before).toBe(MODEL_INSTANCE_FLOATS * 4);
    const big: PartModel = {
      name: 'big',
      parts: Array.from({ length: 200 }, (_, i) => ({ shape: box(i) })),
    };
    scene.placeModel(compileModel(big, MATS), 10, new Transform());
    const after = frame();
    expect(after.draws.length).toBe(4);
    expect(scene.stats.bindGroups).toBe(2);
  });

  it('refuses a model compiled against another table', () => {
    const { scene } = make();
    const m = compileModel(OTHER, { stone: { color: [1, 1, 1] } });
    expect(() => scene.placeModel(m, 0, new Transform())).toThrow(/another material table/);
  });

  it('allocates nothing per still frame', () => {
    const { scene, frame } = make();
    scene.placeModel(compileModel(SPEC, MATS), 0, new Transform(), { channels: { turn: [0, 1] } });
    frame();
    const inst = scene.instances;
    const order = inst.order;
    const draws = inst.draws;
    for (let k = 0; k < 3; k++) frame();
    expect(inst.order).toBe(order);
    expect(inst.draws).toBe(draws);
    expect(inst.stats.orderBuilds).toBe(1);
    expect(inst.stats.placed).toBe(3);
  });
});
