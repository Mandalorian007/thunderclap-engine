/**
 * Save envelope and the export/import string codec.
 *
 * Stored value: JSON `{ "v": <version>, "t": <savedAt ms>, "d": <data> }`.
 * Export string: `TC1.<game>.<checksum>.<base64url(envelope JSON)>`. The checksum
 * (FNV-1a, hex) catches truncated copy-paste; it is not tamper protection.
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

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64: string): string {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const PREFIX = 'TC1';

export function encodeExport(game: string, env: Envelope): string {
  const json = JSON.stringify(env);
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
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'save string is damaged (bad JSON)' };
  }
  if (!isEnvelope(parsed)) return { ok: false, error: 'save string has no version envelope' };
  return { ok: true, envelope: parsed };
}
