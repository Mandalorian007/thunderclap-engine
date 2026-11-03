import { beforeAll, describe, expect, it } from 'vitest';
import { GpuTimer, supportsTimestamps } from './gpu-timer';

// Minimal fakes: the timer only needs createQuerySet/createBuffer, an encoder that records
// calls, and a read buffer whose mapped range we fill with chosen timestamps (ns).
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { QUERY_RESOLVE: 0x200, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 };
  g.GPUMapMode ??= { READ: 1 };
});

function fakeDevice() {
  const bufs: { data: BigInt64Array; mapState: string }[] = [];
  const device = {
    createQuerySet: () => ({ destroy() {} }),
    createBuffer: (d: { size: number }) => {
      const b = {
        data: new BigInt64Array(d.size / 8),
        mapState: 'unmapped',
        mapAsync() {
          b.mapState = 'mapped';
          return Promise.resolve();
        },
        getMappedRange: () => b.data.buffer,
        unmap() {
          b.mapState = 'unmapped';
        },
        destroy() {},
      };
      bufs.push(b);
      return b;
    },
  } as unknown as GPUDevice;
  const calls: string[] = [];
  const encoder = {
    beginComputePass: () => ({ end: () => calls.push('mark') }),
    resolveQuerySet: () => calls.push('resolve'),
    copyBufferToBuffer: () => calls.push('copy'),
  } as unknown as GPUCommandEncoder;
  // bufs[1] is the MAP_READ buffer (resolve buffer is created first).
  return { device, encoder, calls, read: () => bufs[1]! };
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
    f.read().data.set([
      ms(0),
      ms(0.1),
      ms(1),
      ms(9),
      ms(8),
      ms(10),
      ms(10),
      ms(11),
      ms(11),
      ms(12),
    ]);
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
    expect(f.calls).toEqual(['mark', 'resolve', 'copy']);
  });

  it('hands out nothing when not sampling and ignores unwritten pairs', async () => {
    const f = fakeDevice();
    const t = new GpuTimer(f.device, 4);
    expect(t.pass('scene')).toBeUndefined();
    t.begin();
    t.pass('scene');
    t.pass('rays'); // skipped pass: its pair stays 0
    t.resolve(f.encoder);
    f.read().data.set([0n, 0n, ms(2), ms(5), 0n, 0n]);
    const got = new Promise((r) => t.onResult(r));
    t.afterSubmit();
    await got;
    expect(t.result.totalMs).toBeCloseTo(3);
    expect(t.result.passes.scene).toBeCloseTo(3);
    expect(t.result.passes.rays).toBe(0);
  });
});
