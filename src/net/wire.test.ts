import { describe, expect, it } from 'vitest';
import fixedVectors from './testdata/fixed.json';
import { DecodeError, Fixed, Reader, Writer } from './wire';

// Ported from the wire runtime's original tests; fixed.json holds the server's own answers.

function bytes(write: (w: Writer) => void): number[] {
  const w = new Writer();
  write(w);
  return Array.from(w.finish());
}

function read<T>(input: number[], f: (r: Reader) => T): T {
  const r = new Reader(Uint8Array.from(input));
  const value = f(r);
  r.finish();
  return value;
}

describe('wire', () => {
  it('encodes varint boundaries', () => {
    const cases: [number, number[]][] = [
      [0, [0x00]],
      [127, [0x7f]],
      [128, [0x80, 0x01]],
      [300, [0xac, 0x02]],
      [0xffff_ffff, [0xff, 0xff, 0xff, 0xff, 0x0f]],
      [Number.MAX_SAFE_INTEGER, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]],
    ];
    for (const [value, encoded] of cases) {
      expect(bytes((w) => w.u64(value))).toEqual(encoded);
      expect(read(encoded, (r) => r.u64())).toBe(value);
    }
  });

  it('round-trips i64 over the whole safe range', () => {
    for (const value of [0, -1, 1, -64, 64, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      expect(
        read(
          bytes((w) => w.i64(value)),
          (r) => r.i64(),
        ),
      ).toBe(value);
    }
    expect(bytes((w) => w.i64(-1))).toEqual([0x01]);
    expect(bytes((w) => w.i64(1))).toEqual([0x02]);
    expect(bytes((w) => w.i64(-Number.MAX_SAFE_INTEGER))).toEqual([
      0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f,
    ]);
  });

  it('encodes i32 extremes', () => {
    expect(bytes((w) => w.i32(-0x8000_0000))).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f]);
    expect(bytes((w) => w.i32(0x7fff_ffff))).toEqual([0xfe, 0xff, 0xff, 0xff, 0x0f]);
    expect(read([0xff, 0xff, 0xff, 0xff, 0x0f], (r) => r.i32())).toBe(-0x8000_0000);
  });

  it('rejects values outside their type when encoding', () => {
    expect(() => bytes((w) => w.u8(256))).toThrow(RangeError);
    expect(() => bytes((w) => w.u8(-1))).toThrow(RangeError);
    expect(() => bytes((w) => w.u16(0x1_0000))).toThrow(RangeError);
    expect(() => bytes((w) => w.u32(2 ** 32))).toThrow(RangeError);
    expect(() => bytes((w) => w.i32(2 ** 31))).toThrow(RangeError);
    expect(() => bytes((w) => w.u64(2 ** 53))).toThrow(RangeError);
    expect(() => bytes((w) => w.u64(-1))).toThrow(RangeError);
    expect(() => bytes((w) => w.i64(-(2 ** 53)))).toThrow(RangeError);
    expect(() => bytes((w) => w.u32(1.5))).toThrow(TypeError);
    expect(() => bytes((w) => w.u32(Number.NaN))).toThrow(TypeError);
    expect(() => bytes((w) => w.u64(Number.POSITIVE_INFINITY))).toThrow(TypeError);
    expect(() => bytes((w) => w.u32('1' as unknown as number))).toThrow(TypeError);
    expect(() => bytes((w) => w.bool(1 as unknown as boolean))).toThrow(TypeError);
    expect(() => bytes((w) => w.string('\ud800'))).toThrow(TypeError);
    expect(() => bytes((w) => w.option(undefined as unknown as null, () => {}))).toThrow(TypeError);
  });

  it('rejects 64-bit values beyond the safe range when decoding', () => {
    const twoTo53 = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10];
    expect(() => read(twoTo53, (r) => r.u64())).toThrow(DecodeError);
    const u64Max = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    expect(() => read(u64Max, (r) => r.u64())).toThrow(DecodeError);
    expect(() => read(u64Max, (r) => r.i64())).toThrow(DecodeError);
  });

  it('keeps a leading byte order mark', () => {
    expect(read([3, 0xef, 0xbb, 0xbf], (r) => r.string())).toBe('﻿');
  });

  it('is strict: trailing bytes, overlong varints, bad tags, unordered map keys', () => {
    expect(() => read([0, 0], (r) => r.u8())).toThrow(DecodeError);
    expect(() => read([0x80, 0x00], (r) => r.u32())).toThrow(DecodeError);
    expect(() => read([2], (r) => r.bool())).toThrow(DecodeError);
    expect(() =>
      read([2, 5, 0, 3, 0], (r) =>
        r.map(
          () => r.u32(),
          () => r.u8(),
        ),
      ),
    ).toThrow(DecodeError);
    try {
      read([1, 0xff], (r) => r.string());
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      expect((e as DecodeError).offset).toBe(1);
    }
  });

  it('writes maps in key order, strings by code point', () => {
    const m = new Map<string, number>([
      ['b', 2],
      ['\u{1F600}', 3],
      ['￿', 4],
      ['a', 1],
    ]);
    const out: string[] = [];
    const r = new Reader(
      Uint8Array.from(
        bytes((w) =>
          w.map(
            m,
            (k) => w.string(k),
            (v) => w.u8(v),
          ),
        ),
      ),
    );
    r.map(
      () => {
        const k = r.string();
        out.push(k);
        return k;
      },
      () => r.u8(),
    );
    expect(out).toEqual(['a', 'b', '￿', '\u{1F600}']);
  });

  it('grows past its initial buffer', () => {
    expect(bytes((w) => w.string('x'.repeat(1000))).length).toBe(2 + 1000);
  });
});

describe('Fixed', () => {
  it('matches the server for every display and floor vector', () => {
    expect(fixedVectors.fixed.length).toBeGreaterThan(40);
    for (const { bits, display, floor } of fixedVectors.fixed) {
      const f = new Fixed(BigInt(bits));
      expect(f.toString()).toBe(display);
      expect(f.floor()).toBe(floor);
      expect(Fixed.parse(display).bits).toBe(f.bits);
      expect(JSON.stringify({ f })).toBe(`{"f":"${display}"}`);
    }
  });

  it('parses like the server: nearest, ties away from zero', () => {
    for (const { text, bits } of fixedVectors.parse)
      expect(Fixed.parse(text).bits).toBe(BigInt(bits));
  });

  it('rejects what the server rejects', () => {
    for (const bad of [
      '',
      '-',
      '.5',
      '5.',
      '1e3',
      ' 1',
      '1.2.3',
      'NaN',
      '0x10',
      '2147483648',
      '-2147483648.0000000002',
    ]) {
      expect(() => Fixed.parse(bad)).toThrow(RangeError);
    }
  });

  it('has constants, ints and comparison', () => {
    expect(Fixed.ONE.bits).toBe(1n << 32n);
    expect(Fixed.fromInt(-3).toString()).toBe('-3');
    expect(Fixed.fromInt(1728n).floor()).toBe(1728);
    expect(Fixed.MIN.toString()).toBe('-2147483648');
    expect(() => Fixed.fromInt(2 ** 31)).toThrow(RangeError);
    expect(() => Fixed.fromInt(0.5)).toThrow(TypeError);
    expect(() => new Fixed(1n << 63n)).toThrow(RangeError);
    const a = Fixed.parse('0.25');
    const b = Fixed.parse('-0.25');
    expect(a.compare(b)).toBe(1);
    expect(b.compare(a)).toBe(-1);
    expect(a.equals(Fixed.fromBits(1n << 30n))).toBe(true);
    expect(b.toNumber()).toBe(-0.25);
    expect(Fixed.fromBits(-1n).floor()).toBe(-1);
  });

  it('is its bits as a zigzag varint', () => {
    const cases: [Fixed, number[]][] = [
      [Fixed.ZERO, [0x00]],
      [Fixed.fromBits(-1n), [0x01]],
      [Fixed.ONE, [0x80, 0x80, 0x80, 0x80, 0x20]],
      [Fixed.fromInt(-1), [0xff, 0xff, 0xff, 0xff, 0x1f]],
      [Fixed.MAX, [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]],
      [Fixed.MIN, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]],
    ];
    for (const [value, encoded] of cases) {
      expect(bytes((w) => w.fixed(value))).toEqual(encoded);
      expect(read(encoded, (r) => r.fixed()).bits).toBe(value.bits);
    }
    expect(() => new Writer().fixed(5 as unknown as Fixed)).toThrow(
      /Fixed: expected a Fixed, got 5/,
    );
  });
});
