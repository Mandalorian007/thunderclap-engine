/**
 * Save envelope, the typed-array JSON codec and the export/import string codec.
 *
 * Stored value: JSON `{ "v": <version>, "t": <savedAt ms>, "d": <data> }`.
 * Export string: `TC1.<game>.<checksum>.<base64url(envelope JSON)>`. The checksum
 * (FNV-1a, hex) catches truncated copy-paste; it is not tamper protection.
 *
 * Typed arrays inside the data are stored as `{ "$b": <base64url bytes>, "$t"?: <kind> }`
 * (`$t` omitted for `Uint8Array`) by `saveReplacer` and turned back by `saveReviver`, so a
 * tilemap or a voxel chunk never goes through a JSON number array. Bytes are in platform byte
 * order (little-endian everywhere WebGPU runs). A plain object of the player's data that has
 * its own `$b` key is escaped as `$$b` (one more `$` per level) and unescaped on load.
 */

export interface Envelope {
  v: number;
  t: number;
  d: unknown;
}

export function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return typeof e.v === 'number' && Number.isInteger(e.v) && typeof e.t === 'number' && 'd' in e;
}

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex chars. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---- base64url over bytes ----

const CHUNK = 0x2000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function fromBase64Url(b64: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(b64));
}

// ---- typed arrays ----

/** Element kinds a typed array can be tagged with in stored JSON. */
export type TypedKind = 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'f32' | 'f64';

export type TypedArrayOf<K extends TypedKind> = K extends 'u8'
  ? Uint8Array
  : K extends 'u16'
    ? Uint16Array
    : K extends 'u32'
      ? Uint32Array
      : K extends 'i8'
        ? Int8Array
        : K extends 'i16'
          ? Int16Array
          : K extends 'i32'
            ? Int32Array
            : K extends 'f32'
              ? Float32Array
              : Float64Array;

type TypedCtor = {
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): ArrayBufferView;
  readonly BYTES_PER_ELEMENT: number;
};

/** Typed-array kind → constructor. Internal: `schema.ts` and the tests import it from here. */
export const TYPED_KIND_CTORS: Record<TypedKind, TypedCtor> = {
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

/** @deprecated (ws/api-rest, E-036) An internal table; removed next minor. */
export const TYPED_CTORS: Record<TypedKind, TypedCtor> = TYPED_KIND_CTORS;

const KIND_OF = new Map<unknown, TypedKind>(
  (Object.keys(TYPED_KIND_CTORS) as TypedKind[]).map((k) => [TYPED_KIND_CTORS[k], k]),
);

/** The tag kind for `value` if it is one of the eight supported typed arrays, else null. */
export function typedKindOf(value: unknown): TypedKind | null {
  if (!ArrayBuffer.isView(value)) return null;
  return KIND_OF.get(value.constructor) ?? null;
}

const ESCAPED_KEY = /^\$+b$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * `JSON.stringify` replacer: typed arrays become `{ $b, $t? }`; a plain object with a key
 * matching `/^\$+b$/` gets that key prefixed with one more `$`.
 */
export function saveReplacer(_key: string, value: unknown): unknown {
  const kind = typedKindOf(value);
  if (kind !== null) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const b = bytesToBase64Url(bytes);
    return kind === 'u8' ? { $b: b } : { $b: b, $t: kind };
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.some((k) => ESCAPED_KEY.test(k))) {
      const out: Record<string, unknown> = {};
      for (const k of keys) out[ESCAPED_KEY.test(k) ? `$${k}` : k] = value[k];
      return out;
    }
  }
  return value;
}

function isTag(v: Record<string, unknown>): v is { $b: string; $t?: TypedKind } {
  if (typeof v.$b !== 'string') return false;
  const keys = Object.keys(v);
  if (keys.length === 1) return true;
  return keys.length === 2 && typeof v.$t === 'string' && v.$t in TYPED_KIND_CTORS;
}

/** `JSON.parse` reviver undoing `saveReplacer`. Bad tags (damaged base64) are left as objects. */
export function saveReviver(_key: string, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if (isTag(value)) {
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(value.$b);
    } catch {
      return value;
    }
    const kind = value.$t ?? 'u8';
    const Ctor = TYPED_KIND_CTORS[kind];
    if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) return value;
    if (kind === 'u8') return bytes;
    return new Ctor(bytes.buffer as ArrayBuffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
  }
  const keys = Object.keys(value);
  if (keys.some((k) => k.length > 2 && ESCAPED_KEY.test(k))) {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k.length > 2 && ESCAPED_KEY.test(k) ? k.slice(1) : k] = value[k];
    return out;
  }
  return value;
}

// ---- export string ----

const PREFIX = 'TC1';

export function encodeExport(game: string, env: Envelope): string {
  const json = JSON.stringify(env, saveReplacer);
  return `${PREFIX}.${game}.${fnv1a(json)}.${toBase64Url(json)}`;
}

export type DecodeResult = { ok: true; envelope: Envelope } | { ok: false; error: string };

export function decodeExport(game: string, text: string): DecodeResult {
  const parts = text.trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return { ok: false, error: 'not a save string' };
  const [, g, sum, body] = parts as [string, string, string, string];
  if (g !== game) return { ok: false, error: `save belongs to "${g}", not "${game}"` };
  let json: string;
  try {
    json = fromBase64Url(body);
  } catch {
    return { ok: false, error: 'save string is damaged (bad encoding)' };
  }
  if (fnv1a(json) !== sum) return { ok: false, error: 'save string is damaged (checksum)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json, saveReviver);
  } catch {
    return { ok: false, error: 'save string is damaged (bad JSON)' };
  }
  if (!isEnvelope(parsed)) return { ok: false, error: 'save string has no version envelope' };
  return { ok: true, envelope: parsed };
}
