import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, fakeCanvasContext } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import {
  BudgetError,
  budget,
  countAllocs,
  createWorkMeter,
  diffTraceGolden,
  expectProportional,
  sha256Hex,
  traceGolden,
} from './budget';

/** A hand-written frame on the raw device: one pass, `draws` draws, one write, one submit. */
function rawFrame(device: GPUDevice, buf: GPUBuffer, data: Float32Array, draws: number): void {
  device.queue.writeBuffer(buf, 0, data);
  const enc = device.createCommandEncoder({ label: 'f' });
  const pass = enc.beginRenderPass({ label: 'p', colorAttachments: [] });
  pass.setPipeline({ label: 'pipe' } as unknown as GPURenderPipeline);
  for (let i = 0; i < draws; i++) pass.draw(3);
  pass.end();
  device.queue.submit([enc.finish()]);
}

function setup(trace = false) {
  const fake = createFakeDevice();
  const meter = createWorkMeter(fake.device, { trace });
  const buf = meter.device.createBuffer({
    label: 'u',
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  return { fake, meter, buf, data: new Float32Array(16) };
}

describe('createWorkMeter', () => {
  it('counts device, queue, encoder and pass calls by kind, per frame', () => {
    const { fake, meter, buf, data } = setup();
    const r = meter.run(() => rawFrame(meter.device, buf, data, 4), { frames: 5, warmup: 2 });
    expect(r.frames).toBe(5);
    expect(r.gpu.draw).toBe(4);
    expect(r.gpu.setPipeline).toBe(1);
    expect(r.gpu.beginRenderPass).toBe(1);
    expect(r.gpu.submit).toBe(1);
    expect(r.gpu.writeBuffer).toBe(1);
    expect(r.gpu.writeBufferBytes).toBe(64);
    // writeBuffer, createCommandEncoder, beginRenderPass, setPipeline, 4 draws, end, finish, submit.
    expect(r.gpu.commands).toBe(11);
    expect(r.gpu.byMethod.end).toBe(1);
    expect(r.commandsPerFrame).toEqual([11, 11, 11, 11, 11]);
    // The fake device still saw everything (warm-up included).
    expect(fake.submits).toBe(7);
    expect(fake.passes[0]!.commands.filter((c) => c.op === 'draw')).toHaveLength(4);
  });

  it('counts the code under test allocating, not the device', () => {
    const { meter, buf, data } = setup();
    // The fake's writeBuffer makes a Uint8Array view each call: not the frame's allocation.
    const quiet = meter.run(() => rawFrame(meter.device, buf, data, 1), { frames: 4 });
    expect(quiet.allocs.typedArrays).toBe(0);
    const noisy = meter.run(
      () => {
        const m = new Float32Array(16);
        new ArrayBuffer(8);
        new DataView(m.buffer);
        meter.device.queue.writeBuffer(buf, 0, m);
      },
      { frames: 4 },
    );
    expect(noisy.allocs.typedArrays).toBe(1);
    expect(noisy.allocs.arrayBuffers).toBe(1);
    expect(noisy.allocs.dataViews).toBe(1);
    expect(noisy.allocs.byType).toEqual({ Float32Array: 1, ArrayBuffer: 1, DataView: 1 });
    // The globals are back afterwards and still make real typed arrays.
    const after = new Float32Array(2);
    expect(after).toBeInstanceOf(Float32Array);
    expect(Object.getPrototypeOf(after)).toBe(Float32Array.prototype);
  });

  it('counts clock reads', () => {
    const { meter } = setup();
    const r = meter.run(
      () => {
        performance.now();
        Date.now();
      },
      { frames: 3 },
    );
    expect(r.clockReads).toBe(2);
  });

  it('splits GPU work per view when the frame marks views', () => {
    const { meter, buf, data } = setup();
    const r = meter.run(
      () => {
        meter.device.queue.writeBuffer(buf, 0, data);
        meter.view('left');
        rawFrame(meter.device, buf, data, 2);
        meter.view('right');
        rawFrame(meter.device, buf, data, 3);
      },
      { frames: 2 },
    );
    expect(Object.keys(r.views).sort()).toEqual(['frame', 'left', 'right']);
    expect(r.views.frame!.writeBuffer).toBe(1);
    expect(r.views.left!.draw).toBe(2);
    expect(r.views.right!.draw).toBe(3);
    expect(r.views.left!.commands + r.views.right!.commands + r.views.frame!.commands).toBe(
      r.gpu.commands,
    );
    const unmarked = meter.run(() => rawFrame(meter.device, buf, data, 1), { frames: 1 });
    expect(unmarked.views).toEqual({});
  });

  it('counts indirect draws and bundles', () => {
    const { meter } = setup();
    // The fake device validates indirect draws (ws/core-retained), so they take a real INDIRECT buffer.
    const args = meter.device.createBuffer({
      label: 'args',
      size: 32,
      usage: GPUBufferUsage.INDIRECT,
    });
    const r = meter.measure(() => {
      const enc = meter.device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [] });
      pass.drawIndirect(args, 0);
      pass.drawIndexedIndirect(args, 0);
      pass.executeBundles([]);
      pass.end();
    });
    expect(r.gpu.drawIndirect).toBe(1);
    expect(r.gpu.drawIndexedIndirect).toBe(1);
    expect(r.gpu.executeBundles).toBe(1);
  });

  it('records a normalized trace while measuring', () => {
    const { meter, buf, data } = setup(true);
    const r = meter.run(() => rawFrame(meter.device, buf, data, 1), { frames: 2, warmup: 1 });
    expect(r.trace).toEqual([
      'writeBuffer({u},0,<bytes:64>)',
      'createCommandEncoder({f})',
      'beginRenderPass({p})',
      'setPipeline({pipe})',
      'draw(3)',
      'end()',
      'finish()',
      'submit([1])',
      '--',
      'writeBuffer({u},0,<bytes:64>)',
      'createCommandEncoder({f})',
      'beginRenderPass({p})',
      'setPipeline({pipe})',
      'draw(3)',
      'end()',
      'finish()',
      'submit([1])',
      '--',
    ]);
    const g = traceGolden(r.trace!);
    expect(g.frames).toBe(2);
    expect(g.perFrame).toEqual([[8, 2]]);
    expect(g.first).toHaveLength(8);
    expect(g.sha256).toBe(createHash('sha256').update(r.trace!.join('\n')).digest('hex'));
  });

  it('drives a Renderer on the counted fake device', () => {
    const fake = createFakeDevice();
    const meter = createWorkMeter(fake.device);
    const renderer = new Renderer({
      device: meter.device,
      context: fakeCanvasContext(fake),
      format: 'bgra8unorm',
    });
    renderer.resize(320, 180);
    renderer.camera = Camera.ortho2d(320, 180);
    const r = meter.run(
      (i) => {
        const f = renderer.beginFrame(i / 60, 1 / 60);
        f.clear(0, 0, 0);
        f.sprite(null, { x: 10, y: 10, w: 8, h: 8 });
        renderer.endFrame();
      },
      { frames: 10 },
    );
    expect(r.gpu.submit).toBe(1);
    expect(r.gpu.draw + r.gpu.drawIndexed).toBeGreaterThan(0);
    expect(new Set(r.commandsPerFrame).size).toBe(1);
    expect(r.allocs.typedArrays).toBe(0);
    expect(r.clockReads).toBe(0);
    expect(fake.errors).toEqual([]);
  });
});

describe('budget', () => {
  it('passes a report within its limits and names every counter over', () => {
    const { meter, buf, data } = setup();
    const r = meter.run(() => rawFrame(meter.device, buf, data, 4), { frames: 2 });
    expect(budget(r, { draw: 4, submit: 1, typedArrays: 0, clockReads: 0 })).toBe(r);
    expect(() => budget(r, { draw: 3, commands: 10, submit: 1 }, 'scene')).toThrow(
      /scene: over budget per frame: draw 4 > 3; commands 11 > 10/,
    );
    expect(() => budget(r, { draw: 3 })).toThrow(BudgetError);
  });
});

describe('countAllocs', () => {
  it('counts typed arrays made in a call', () => {
    expect(countAllocs(() => new Uint16Array(4)).typedArrays).toBe(1);
    expect(countAllocs(() => [1, 2, 3].map((x) => x * 2)).typedArrays).toBe(0);
  });
});

describe('expectProportional', () => {
  it('holds a flat count and a linear one', () => {
    expect(expectProportional(() => 46, [1500, 6000], { shape: 'flat' }).intercept).toBe(46);
    const lin = expectProportional((n) => 10 + 3 * n, [1, 4, 16]);
    expect(lin.slope).toBe(3);
    expect(lin.intercept).toBe(10);
    expect(
      expectProportional((n) => 10 + 3 * n + (n === 4 ? 1 : 0), [1, 4, 16], { slack: 1 }).slope,
    ).toBe(3);
  });

  it('fails a count that grows with what is held, or bends', () => {
    expect(() =>
      expectProportional((n) => n / 4, [1500, 6000], { shape: 'flat', label: 'commands' }),
    ).toThrow(/commands is not flat in size .*1500: 375, 6000: 1500/);
    expect(() => expectProportional((n) => n * n, [1, 2, 4])).toThrow(BudgetError);
    expect(() => expectProportional((n) => 3 * n, [1, 4], { perUnit: 2 })).toThrow(/per unit/);
    expect(() => expectProportional((n) => 3 * n - 5, [2, 4])).toThrow(/negative overhead/);
    expect(() => expectProportional((n) => n, [3, 3])).toThrow(RangeError);
  });
});

describe('trace goldens', () => {
  it('match, and a difference reads at its first call', () => {
    const a = traceGolden(['x(1)', 'y()', '--', 'x(1)', 'y()', '--']);
    expect(diffTraceGolden(a, a)).toBeNull();
    const b = traceGolden(['x(2)', 'y()', '--', 'x(1)', 'y()', '--']);
    expect(diffTraceGolden(b, a)).toBe('first frame, call 0: got x(2), want x(1)');
    const c = traceGolden(['x(1)', 'y()', '--', 'x(1)', '--']);
    expect(diffTraceGolden(c, a)).toMatch(/calls per frame/);
    const d = traceGolden(['x(1)', 'y()', '--', 'x(1)', 'z()', '--']);
    expect(diffTraceGolden(d, a)).toMatch(/a later frame differs/);
  });

  it('hashes like sha256', () => {
    for (const s of ['', 'abc', 'é ünïcode', 'x'.repeat(1000)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
});
