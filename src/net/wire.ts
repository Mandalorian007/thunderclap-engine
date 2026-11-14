/**
 * The wire format runtime: the byte-level reader and writer every message codec in `net` uses.
 *
 * u8 and bool are one byte; u16, u32, u64 are unsigned LEB128 varints; i32 and i64 are zigzag
 * varints; a Fixed is its raw i64 bits as a zigzag varint; strings are a varint byte length plus
 * UTF-8; bytes are a varint length plus the bytes; vectors are a varint count plus items; maps are a
 * varint count plus key and value of each entry in ascending key order; options are a 0/1 tag plus
 * the value; enums are a varint variant index plus the variant's fields.
 *
 * Decoding is strict: overlong varints, values out of range, invalid UTF-8, bad tags, unknown
 * variants, map keys that are not strictly ascending, and trailing bytes are errors. 64-bit integers
 * must also be safe JavaScript integers. The format is the server foundation's (`tc-wire`): both
 * sides encode byte for byte the same.
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const U32_MAX = 0xffff_ffff;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const FRAC_BITS = 32n;
const FRAC_MASK = (1n << FRAC_BITS) - 1n;

const textEncoder = new TextEncoder();
// ignoreBOM: a leading U+FEFF is string content, as in Rust, not a marker to strip.
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Thrown when bytes are not a valid message. */
export class DecodeError extends Error {
  /** Byte offset where the bad value starts. */
  readonly offset: number;

  constructor(offset: number, message: string) {
    super(`at byte ${offset}: ${message}`);
    this.name = 'DecodeError';
    this.offset = offset;
  }
}

/**
 * A signed 32.32 fixed-point number, exactly as the server's 32.32 `Fixed`:
 * the value is `bits / 2^32`, held as the raw i64 `bits` in a bigint. Nothing
 * here goes through floating point except `toNumber()`.
 */
export class Fixed {
  /** Number of fractional bits. */
  static readonly FRAC_BITS = 32;
  /** 0. */
  static readonly ZERO = new Fixed(0n);
  /** 1. */
  static readonly ONE = new Fixed(1n << FRAC_BITS);
  /** The smallest value, -2^31. */
  static readonly MIN = new Fixed(I64_MIN);
  /** The largest value, 2^31 - 2^-32. */
  static readonly MAX = new Fixed(I64_MAX);

  /** The raw 32.32 bits, a signed 64-bit integer. */
  readonly bits: bigint;

  /** From the raw bits. Throws unless they fit in an i64. */
  constructor(bits: bigint) {
    if (typeof bits !== 'bigint') {
      throw new TypeError(`Fixed: expected bigint bits, got ${show(bits)}`);
    }
    if (bits < I64_MIN || bits > I64_MAX) {
      throw new RangeError(`Fixed: bits ${bits} are outside the i64 range`);
    }
    this.bits = bits;
  }

  /** From the raw bits; same as `new Fixed(bits)`. */
  static fromBits(bits: bigint): Fixed {
    return new Fixed(bits);
  }

  /** A whole number, exactly. Throws unless it is an integer in -2^31..2^31-1. */
  static fromInt(n: number | bigint): Fixed {
    if (typeof n === 'number' && !Number.isInteger(n)) {
      throw new TypeError(`Fixed.fromInt: expected an integer, got ${show(n)}`);
    }
    const big = BigInt(n);
    if (big < -(1n << 31n) || big >= 1n << 31n) {
      throw new RangeError(`Fixed.fromInt: ${big} is outside -2147483648..=2147483647`);
    }
    return new Fixed(big << FRAC_BITS);
  }

  /**
   * Parses a decimal exactly, like the server's `Fixed::parse_decimal`: optional
   * sign, digits, optional `.` and digits; rounds to the nearest value, ties
   * away from zero. Throws on anything else or out of range.
   */
  static parse(text: string): Fixed {
    const match = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/.exec(text);
    if (!match) {
      throw new RangeError(
        `invalid decimal ${JSON.stringify(text)}: expected digits, one '.', and a leading sign`,
      );
    }
    const [, sign, int = '', frac = ''] = match;
    const scale = 10n ** BigInt(frac.length);
    const scaled = BigInt(int + frac) << FRAC_BITS;
    let magnitude = scaled / scale;
    if ((scaled % scale) * 2n >= scale) magnitude += 1n;
    const negative = sign === '-';
    if (magnitude > (negative ? -I64_MIN : I64_MAX)) {
      throw new RangeError(`invalid decimal ${JSON.stringify(text)}: out of range`);
    }
    return new Fixed(negative ? -magnitude : magnitude);
  }

  /** The largest integer less than or equal to this value. */
  floor(): number {
    return Number(this.bits >> FRAC_BITS);
  }

  /** -1, 0, or 1 as this value is less than, equal to, or greater than `other`. */
  compare(other: Fixed): -1 | 0 | 1 {
    return this.bits < other.bits ? -1 : this.bits > other.bits ? 1 : 0;
  }

  /** Whether both are the same value. */
  equals(other: Fixed): boolean {
    return this.bits === other.bits;
  }

  /** The nearest double; for display only. */
  toNumber(): number {
    return Number(this.bits) / 2 ** 32;
  }

  /** The exact decimal without trailing zeros (`1`, `-0.25`), as Rust's `Display` writes it. */
  toString(): string {
    const negative = this.bits < 0n;
    const magnitude = negative ? -this.bits : this.bits;
    let out = `${negative ? '-' : ''}${magnitude >> FRAC_BITS}`;
    let frac = magnitude & FRAC_MASK;
    if (frac !== 0n) out += '.';
    while (frac !== 0n) {
      frac *= 10n;
      out += String(frac >> FRAC_BITS);
      frac &= FRAC_MASK;
    }
    return out;
  }

  /** `JSON.stringify` writes the exact decimal (bigints can't be serialized). */
  toJSON(): string {
    return this.toString();
  }
}

/** Encodes values into a growing byte buffer. */
export class Writer {
  #buf = new Uint8Array(64);
  #len = 0;

  /** The bytes written so far. */
  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }

  bool(value: boolean): void {
    if (typeof value !== 'boolean') {
      throw new TypeError(`bool: expected a boolean, got ${show(value)}`);
    }
    this.#byte(value ? 1 : 0);
  }

  u8(value: number): void {
    checkInt('u8', value, 0, 0xff);
    this.#byte(value);
  }

  u16(value: number): void {
    checkInt('u16', value, 0, 0xffff);
    this.#varint(value);
  }

  u32(value: number): void {
    checkInt('u32', value, 0, U32_MAX);
    this.#varint(value);
  }

  /** Throws unless `value` is a safe, non-negative integer. */
  u64(value: number): void {
    checkInt('u64', value, 0, MAX_SAFE);
    this.#varint(value);
  }

  i32(value: number): void {
    checkInt('i32', value, -0x8000_0000, 0x7fff_ffff);
    this.#varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  /** Throws unless `value` is a safe integer. */
  i64(value: number): void {
    checkInt('i64', value, -MAX_SAFE, MAX_SAFE);
    const v = BigInt(value);
    let zigzag = v >= 0n ? v << 1n : (-v << 1n) - 1n;
    while (zigzag >= 0x80n) {
      this.#byte(Number(zigzag & 0x7fn) | 0x80);
      zigzag >>= 7n;
    }
    this.#byte(Number(zigzag));
  }

  fixed(value: Fixed): void {
    if (!(value instanceof Fixed)) {
      throw new TypeError(`Fixed: expected a Fixed, got ${show(value)}`);
    }
    const v = value.bits;
    let zigzag = v >= 0n ? v << 1n : (-v << 1n) - 1n;
    while (zigzag >= 0x80n) {
      this.#byte(Number(zigzag & 0x7fn) | 0x80);
      zigzag >>= 7n;
    }
    this.#byte(Number(zigzag));
  }

  /** Throws if `value` contains a lone surrogate (it has no UTF-8 encoding). */
  string(value: string): void {
    if (typeof value !== 'string') {
      throw new TypeError(`String: expected a string, got ${show(value)}`);
    }
    if (!value.isWellFormed()) {
      throw new TypeError(`String: contains a lone surrogate: ${JSON.stringify(value)}`);
    }
    const bytes = textEncoder.encode(value);
    this.#varint(bytes.length);
    this.#reserve(bytes.length);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.length;
  }

  vec<T>(items: readonly T[], item: (value: T) => void): void {
    if (!Array.isArray(items)) {
      throw new TypeError(`Vec: expected an array, got ${show(items)}`);
    }
    this.#varint(items.length);
    for (const value of items) {
      item(value);
    }
  }

  /** Writes the entries in ascending key order (see `compareKeys`). */
  map<K extends MapKey, V>(
    map: ReadonlyMap<K, V>,
    key: (key: K) => void,
    value: (value: V) => void,
  ): void {
    if (!(map instanceof Map)) {
      throw new TypeError(`Map: expected a Map, got ${show(map)}`);
    }
    const entries = [...map.entries()].sort((a, b) => compareKeys(a[0], b[0]));
    for (let i = 1; i < entries.length; i++) {
      if (compareKeys(entries[i - 1]![0], entries[i]![0]) === 0) {
        throw new TypeError(`Map: duplicate key ${show(entries[i]![0])}`);
      }
    }
    this.#varint(entries.length);
    for (const [k, v] of entries) {
      key(k);
      value(v);
    }
  }

  /** Writes a varint byte length, then the bytes. */
  bytes(value: Uint8Array): void {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(`Bytes: expected a Uint8Array, got ${show(value)}`);
    }
    this.#varint(value.length);
    this.raw(value);
  }

  /** Appends already-encoded bytes as they are. */
  raw(value: Uint8Array): void {
    this.#reserve(value.length);
    this.#buf.set(value, this.#len);
    this.#len += value.length;
  }

  option<T>(value: T | null, some: (value: T) => void): void {
    if (value === null) {
      this.#byte(0);
    } else if (value === undefined) {
      throw new TypeError('Option: expected a value or null, got undefined');
    } else {
      this.#byte(1);
      some(value);
    }
  }

  /** Writes an enum variant index. */
  variant(index: number): void {
    this.#varint(index);
  }

  #varint(value: number): void {
    while (value >= 0x80) {
      this.#byte((value % 0x80) | 0x80);
      value = Math.floor(value / 0x80);
    }
    this.#byte(value);
  }

  #byte(value: number): void {
    this.#reserve(1);
    this.#buf[this.#len++] = value;
  }

  #reserve(extra: number): void {
    const needed = this.#len + extra;
    if (needed <= this.#buf.length) return;
    const grown = new Uint8Array(Math.max(needed, this.#buf.length * 2));
    grown.set(this.#buf.subarray(0, this.#len));
    this.#buf = grown;
  }
}

/** Decodes values from a received message. */
export class Reader {
  readonly #bytes: Uint8Array;
  #pos = 0;
  #variantAt = 0;

  constructor(bytes: Uint8Array | ArrayBuffer) {
    this.#bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  /** Offset of the next byte to read. */
  get position(): number {
    return this.#pos;
  }

  /** Number of bytes not yet read. */
  get remaining(): number {
    return this.#bytes.length - this.#pos;
  }

  /** Throws unless every byte has been read. */
  finish(): void {
    if (this.remaining > 0) {
      throw new DecodeError(this.#pos, `${this.remaining} trailing bytes after message`);
    }
  }

  bool(): boolean {
    const at = this.#pos;
    const byte = this.#byte();
    if (byte > 1) throw new DecodeError(at, `invalid bool byte ${byte}`);
    return byte === 1;
  }

  u8(): number {
    return this.#byte();
  }

  u16(): number {
    return this.#varintMax('u16', 0xffff);
  }

  u32(): number {
    return this.#varintMax('u32', U32_MAX);
  }

  /** Throws if the value is beyond `Number.MAX_SAFE_INTEGER`. */
  u64(): number {
    const at = this.#pos;
    const value = this.#varintBig();
    if (value > MAX_SAFE_BIG) {
      throw new DecodeError(at, `u64 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
  }

  i32(): number {
    const raw = this.#varintMax('i32', U32_MAX);
    return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
  }

  /** Throws if the value is outside the safe integer range. */
  i64(): number {
    const at = this.#pos;
    const raw = this.#varintBig();
    const value = (raw & 1n) === 0n ? raw >> 1n : -((raw + 1n) >> 1n);
    if (value > MAX_SAFE_BIG || value < -MAX_SAFE_BIG) {
      throw new DecodeError(at, `i64 value ${value} is not a safe integer`);
    }
    return Number(value);
  }

  fixed(): Fixed {
    const raw = this.#varintBig();
    return new Fixed((raw & 1n) === 0n ? raw >> 1n : -((raw + 1n) >> 1n));
  }

  string(): string {
    const length = this.#length();
    const at = this.#pos;
    this.#pos += length;
    const bytes = this.#bytes.subarray(at, at + length);
    try {
      return textDecoder.decode(bytes);
    } catch {
      throw new DecodeError(at + validUtf8Prefix(bytes), 'invalid UTF-8');
    }
  }

  vec<T>(item: () => T): T[] {
    const length = this.#length();
    const items: T[] = [];
    for (let i = 0; i < length; i++) {
      items.push(item());
    }
    return items;
  }

  /** Reads a map; its keys must be strictly ascending (see `compareKeys`). */
  map<K extends MapKey, V>(key: () => K, value: () => V): Map<K, V> {
    const length = this.#length();
    const map = new Map<K, V>();
    let last: K | undefined;
    for (let i = 0; i < length; i++) {
      const at = this.#pos;
      const k = key();
      if (last !== undefined && compareKeys(last, k) >= 0) {
        throw new DecodeError(at, 'map key not greater than the key before it');
      }
      last = k;
      map.set(k, value());
    }
    return map;
  }

  /** Reads a varint byte length, then that many bytes (a copy). */
  bytes(): Uint8Array {
    const length = this.#length();
    const at = this.#pos;
    this.#pos += length;
    return this.#bytes.slice(at, at + length);
  }

  /** Reads a length or count prefix: at most the bytes left. */
  count(): number {
    return this.#length();
  }

  option<T>(some: () => T): T | null {
    const at = this.#pos;
    const tag = this.#byte();
    if (tag === 0) return null;
    if (tag === 1) return some();
    throw new DecodeError(at, `invalid option tag ${tag}`);
  }

  /** Reads an enum variant index. */
  variant(): number {
    this.#variantAt = this.#pos;
    return this.#varint();
  }

  /** The error for an unknown index just read by `variant()`. */
  unknownVariant(typeName: string): DecodeError {
    const index = this.#exactVarintAt(this.#variantAt);
    return new DecodeError(this.#variantAt, `unknown variant ${index} for ${typeName}`);
  }

  #byte(): number {
    const byte = this.#bytes[this.#pos];
    if (byte === undefined) {
      throw new DecodeError(this.#pos, 'unexpected end of message');
    }
    this.#pos++;
    return byte;
  }

  // Every encoded value takes at least one byte, so a length or count larger
  // than the bytes left is rejected before anything is allocated.
  #length(): number {
    const at = this.#pos;
    const length = this.#varint();
    if (length > this.remaining) {
      const exact = this.#exactVarintAt(at);
      throw new DecodeError(at, `length ${exact} exceeds the ${this.remaining} bytes left`);
    }
    return length;
  }

  #varintMax(typeName: string, max: number): number {
    const at = this.#pos;
    const value = this.#varint();
    if (value > max) {
      const exact = this.#exactVarintAt(at);
      throw new DecodeError(at, `value ${exact} out of range for ${typeName}`);
    }
    return value;
  }

  // Reads a canonical varint of at most 64 bits as a number. Values above
  // 2^53 lose precision, which is fine: every caller rejects them, and the
  // error message re-reads the exact value with #exactVarintAt.
  #varint(): number {
    const at = this.#pos;
    let value = 0;
    let scale = 1;
    for (let shift = 0; ; shift += 7) {
      const byte = this.#byte();
      if (shift === 63 && byte > 1) throw new DecodeError(at, 'varint exceeds 64 bits');
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (byte === 0 && shift > 0) throw new DecodeError(at, 'overlong varint');
        return value;
      }
      scale *= 0x80;
    }
  }

  // The exact value of the valid varint already read at `at`.
  #exactVarintAt(at: number): bigint {
    const end = this.#pos;
    this.#pos = at;
    try {
      return this.#varintBig();
    } finally {
      this.#pos = end;
    }
  }

  #varintBig(): bigint {
    const at = this.#pos;
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = this.#byte();
      if (shift === 63n && byte > 1) throw new DecodeError(at, 'varint exceeds 64 bits');
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (byte === 0 && shift > 0n) throw new DecodeError(at, 'overlong varint');
        return value;
      }
    }
  }
}

/** A map key: maps are keyed by integers or strings. */
export type MapKey = number | string;

/**
 * The order of map keys, the same as Rust's: numeric for integers, by code
 * point for strings (which is UTF-8 byte order, not UTF-16 order).
 */
export function compareKeys(a: MapKey, b: MapKey): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') {
    const ai = a[Symbol.iterator]();
    const bi = b[Symbol.iterator]();
    for (;;) {
      const x = ai.next();
      const y = bi.next();
      if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
      const cx = x.value.codePointAt(0)!;
      const cy = y.value.codePointAt(0)!;
      if (cx !== cy) return cx < cy ? -1 : 1;
    }
  }
  throw new TypeError(`map keys must be all numbers or all strings, got ${show(a)} and ${show(b)}`);
}

/** The error for an enum value whose `type` matches no variant. */
export function invalidVariant(typeName: string, value: never): TypeError {
  const tag: unknown = (value as { type?: unknown } | null)?.type;
  return new TypeError(`${typeName}: unknown variant type ${show(tag)}`);
}

// The length of the longest valid UTF-8 prefix of `bytes`, which is where
// Rust's `Utf8Error::valid_up_to` puts the error. Only called on bytes the
// strict TextDecoder rejected; it accepts exactly what it accepts.
function validUtf8Prefix(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i] as number;
    let width: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (lead < 0x80) width = 1;
    else if (lead >= 0xc2 && lead <= 0xdf) width = 2;
    else if (lead >= 0xe0 && lead <= 0xef) {
      width = 3;
      if (lead === 0xe0) lo = 0xa0;
      if (lead === 0xed) hi = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      width = 4;
      if (lead === 0xf0) lo = 0x90;
      if (lead === 0xf4) hi = 0x8f;
    } else return i;
    for (let k = 1; k < width; k++) {
      const next = bytes[i + k];
      if (next === undefined || next < (k === 1 ? lo : 0x80) || next > (k === 1 ? hi : 0xbf)) {
        return i;
      }
    }
    i += width;
  }
  return i;
}

function checkInt(typeName: string, value: number, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${typeName}: expected an integer, got ${show(value)}`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${typeName}: ${value} is outside ${min}..=${max}`);
  }
}

function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
