import { describe, expect, it } from 'vitest';
import { createFakeDevice } from './fake-gpu';
import { GpuTimer, supportsTimestamps } from './gpu-timer';

// The fake GPU resolves the query set, copies it into the read buffer and maps it for real
// (ws/render-9); a test fills the query set's `values` with chosen timestamps (ns).
function fakeDevice() {
  const fake = createFakeDevice({}, ['timestamp-query']);
  const encoder = fake.device.createCommandEncoder();
  return {
    fake,
    device: fake.device,
    encoder,
    queries: () => fake.querySets[0]!.values,
    submit: () => fake.device.queue.submit([encoder.finish()]),
  };
}

// Real timestamps never read 0 (that marks an unwritten pair), so offset the time base.
const ms = (x: number) => BigInt(Math.round((x + 100) * 1e6));

describe('GpuTimer', () => {
  it('detects the feature without throwing on bare devices', () => {
    expect(supportsTimestamps({} as GPUDevice)).toBe(false);
    expect(supportsTimestamps({ features: new Set(['timestamp-query']) } as never)).toBe(true);
  });

  it('attributes marginal time so overlapping passes sum to the frame', async () => {
    const f = fakeDevice();
    const t = new GpuTimer(f.device, 8);
    expect(t.begin()).toBe(true);
    t.mark(f.encoder);
    expect(t.pass('scene')).toBeDefined();
    t.pass('bloom');
    t.pass('bloom');
    t.pass('composite');
    t.resolve(f.encoder);
    expect(t.busy).toBe(true);
    expect(t.begin()).toBe(false);
    // mark 0–0.1; scene 1–9; bloom 8–10 (overlaps scene by 1) and 10–11; composite 11–12.
    f.queries().set([ms(0), ms(0.1), ms(1), ms(9), ms(8), ms(10), ms(10), ms(11), ms(11), ms(12)]);
    f.submit();
    const got = new Promise((r) => t.onResult(r));
    t.afterSubmit();
    await got;
    const p = t.result.passes;
    expect(t.result.totalMs).toBeCloseTo(12);
    expect(p.pre).toBeCloseTo(0.9);
    expect(p.scene).toBeCloseTo(8);
    expect(p.bloom).toBeCloseTo(2);
    expect(p.composite).toBeCloseTo(1);
    expect(p.pre! + p.scene! + p.bloom! + p.composite!).toBeCloseTo(12 - 0.1);
    expect(t.busy).toBe(false);
    expect(f.fake.passes.map((p) => p.label)).toEqual(['gpu-timer-mark']);
    const copy = f.fake.bufferCopies[0]!;
    expect([copy.src.label, copy.dst.label, copy.size]).toEqual([
      'gpu-timer-resolve',
      'gpu-timer-read',
      10 * 8,
    ]);
    expect(f.fake.buffers.find((b) => b.label === 'gpu-timer-read')!.mapState).toBe('unmapped');
    expect(f.fake.errors).toEqual([]);
  });

  it('hands out nothing when not sampling and ignores unwritten pairs', async () => {
    const f = fakeDevice();
    const t = new GpuTimer(f.device, 4);
    expect(t.pass('scene')).toBeUndefined();
    t.begin();
    t.pass('scene');
    t.pass('rays'); // skipped pass: its pair stays 0
    t.resolve(f.encoder);
    f.queries().set([0n, 0n, ms(2), ms(5), 0n, 0n]);
    f.submit();
    const got = new Promise((r) => t.onResult(r));
    t.afterSubmit();
    await got;
    expect(t.result.totalMs).toBeCloseTo(3);
    expect(t.result.passes.scene).toBeCloseTo(3);
    expect(t.result.passes.rays).toBe(0);
  });
});
