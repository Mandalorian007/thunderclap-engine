/**
 * ws/render-9: the fake GPU rejects the usage-flag mistakes a real device would, and its
 * `MAP_READ` buffers map the bytes a submitted copy brought.
 */
import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeBuffer, FakeGpuValidationError } from './fake-gpu';

function setup() {
  const fake = createFakeDevice();
  const U = GPUBufferUsage;
  const make = (label: string, usage: number, size = 16) =>
    fake.device.createBuffer({ label, size, usage }) as unknown as FakeBuffer;
  const gpu = (b: FakeBuffer) => b as unknown as GPUBuffer;
  return { fake, U, make, gpu };
}

describe('fake GPU usage flags (ws/render-9)', () => {
  it('copyBufferToBuffer needs COPY_SRC on the source and COPY_DST on the destination', () => {
    const { fake, U, make, gpu } = setup();
    const src = make('src', U.STORAGE);
    const dst = make('dst', U.MAP_READ | U.COPY_DST);
    const enc = fake.device.createCommandEncoder();
    expect(() => enc.copyBufferToBuffer(gpu(src), 0, gpu(dst), 0, 16)).toThrow(
      FakeGpuValidationError,
    );
    expect(fake.errors).toEqual(['copyBufferToBuffer: src lacks COPY_SRC']);
    const src2 = make('src2', U.STORAGE | U.COPY_SRC);
    const dst2 = make('dst2', U.MAP_READ);
    expect(() => enc.copyBufferToBuffer(gpu(src2), 0, gpu(dst2), 0, 16)).toThrow(
      /dst2 lacks COPY_DST/,
    );
    expect(fake.bufferCopies).toEqual([]);
  });

  it('writeBuffer needs COPY_DST; mapAsync needs MAP_READ (or MAP_WRITE)', () => {
    const { fake, U, make, gpu } = setup();
    let err: unknown;
    try {
      fake.device.queue.writeBuffer(gpu(make('vb', U.VERTEX)), 0, new Float32Array(4));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FakeGpuValidationError);
    expect((err as Error).name).toBe('GPUValidationError');
    expect((err as Error).message).toBe('writeBuffer: vb lacks COPY_DST');
    expect(() => make('storage', U.STORAGE | U.COPY_DST).mapAsync(GPUMapMode.READ)).toThrow(
      /storage lacks MAP_READ/,
    );
    expect(() => make('read', U.MAP_READ | U.COPY_DST).mapAsync(GPUMapMode.WRITE)).toThrow(
      /read lacks MAP_WRITE/,
    );
    expect(fake.writes).toEqual([]);
  });

  it('records writeBuffer sizes in bytes for typed arrays (offset and size in elements)', () => {
    const { fake, U, make, gpu } = setup();
    const b = make('b', U.COPY_DST, 32);
    fake.device.queue.writeBuffer(gpu(b), 4, new Float32Array([1, 2, 3, 4, 5]), 1, 3);
    expect(fake.writes.at(-1)!.bytes).toBe(12);
    expect(Array.from(new Float32Array(b.data.buffer, 4, 3))).toEqual([2, 3, 4]);
    fake.device.queue.writeBuffer(gpu(b), 16, new Uint32Array([7, 8]).buffer, 4);
    expect(fake.writes.at(-1)!.bytes).toBe(4);
    expect(new Uint32Array(b.data.buffer)[4]).toBe(8);
  });
});

describe('fake GPU staging buffers (ws/render-9)', () => {
  it('maps the bytes a submitted copy brought; unmap detaches the range', async () => {
    const { fake, U, make, gpu } = setup();
    const src = make('src', U.STORAGE | U.COPY_SRC | U.COPY_DST);
    const read = make('read', U.MAP_READ | U.COPY_DST);
    fake.device.queue.writeBuffer(gpu(src), 0, new Float32Array([1, 2, 3, 4]));
    const enc = fake.device.createCommandEncoder();
    enc.copyBufferToBuffer(gpu(src), 4, gpu(read), 0, 8);
    // Encoded, not submitted: nothing has moved yet.
    expect(Array.from(new Float32Array(read.data.buffer))).toEqual([0, 0, 0, 0]);
    fake.device.queue.submit([enc.finish()]);
    expect(fake.submits).toBe(1);
    const mapped = read.mapAsync(GPUMapMode.READ);
    expect(read.mapState).toBe('pending');
    expect(() => read.getMappedRange()).toThrow(/pending/);
    await mapped;
    expect(read.mapState).toBe('mapped');
    const range = read.getMappedRange(0, 8);
    const view = new Float32Array(range);
    expect(Array.from(view)).toEqual([2, 3]);
    read.unmap();
    expect(read.mapState).toBe('unmapped');
    expect(range.byteLength).toBe(0);
    expect(view.length).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('flags a copy into a buffer that is pending a map, and a second map', async () => {
    const { fake, U, make, gpu } = setup();
    const src = make('src', U.COPY_SRC);
    const read = make('read', U.MAP_READ | U.COPY_DST);
    const enc = fake.device.createCommandEncoder();
    enc.copyBufferToBuffer(gpu(src), 0, gpu(read), 0, 16);
    const mapped = read.mapAsync(GPUMapMode.READ);
    const again = read.mapAsync(GPUMapMode.READ);
    fake.device.queue.submit([enc.finish()]);
    await expect(again).rejects.toThrow(/read is pending/);
    expect(fake.errors).toEqual(['mapAsync: read is pending', 'submit: read is pending']);
    await mapped;
  });

  it('an unmap before the map resolves rejects it', async () => {
    const { U, make } = setup();
    const read = make('read', U.MAP_READ | U.COPY_DST);
    const mapped = read.mapAsync(GPUMapMode.READ);
    read.unmap();
    await expect(mapped).rejects.toThrow(/unmapped before it mapped/);
    expect(read.mapState).toBe('unmapped');
  });

  it('runPass stands in for a shader, in order with the clears and copies', async () => {
    const { fake, U, make, gpu } = setup();
    const out = make('out', U.STORAGE | U.COPY_SRC | U.COPY_DST, 8);
    const read = make('read', U.MAP_READ | U.COPY_DST, 8);
    fake.runPass = (p) => {
      if (p.label === 'count') out.data.set(new Uint8Array(new Uint32Array([5, 6]).buffer));
    };
    const enc = fake.device.createCommandEncoder();
    enc.clearBuffer(gpu(out));
    enc.beginComputePass({ label: 'count' }).end();
    enc.copyBufferToBuffer(gpu(out), 0, gpu(read), 0, 8);
    enc.clearBuffer(gpu(out));
    fake.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    expect(Array.from(new Uint32Array(read.getMappedRange()))).toEqual([5, 6]);
    expect(Array.from(new Uint32Array(out.data.buffer))).toEqual([0, 0]);
    read.unmap();
  });

  it('resolveQuerySet needs QUERY_RESOLVE and writes the set at submit', () => {
    const { fake, U, make, gpu } = setup();
    const set = fake.device.createQuerySet({ type: 'timestamp', count: 2 });
    fake.querySets[0]!.values.set([3n, 9n]);
    const enc = fake.device.createCommandEncoder();
    expect(() => enc.resolveQuerySet(set, 0, 2, gpu(make('bad', U.COPY_SRC)), 0)).toThrow(
      /bad lacks QUERY_RESOLVE/,
    );
    const dst = make('resolve', U.QUERY_RESOLVE | U.COPY_SRC);
    enc.resolveQuerySet(set, 0, 2, gpu(dst), 0);
    fake.device.queue.submit([enc.finish()]);
    expect(Array.from(new BigUint64Array(dst.data.buffer))).toEqual([3n, 9n]);
  });
});
