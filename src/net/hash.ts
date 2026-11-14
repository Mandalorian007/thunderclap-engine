/**
 * The stable 64-bit hash both sides of the wire agree on: SplitMix64 fed a byte length, then the
 * bytes as little-endian 8-byte words (the last one zero-padded). It hashes query results (an
 * `Update` carries the hash of the value it leads to) and the schema's canonical text.
 */

const M64 = (1n << 64n) - 1n;
const GAMMA = 0x9e37_79b9_7f4a_7c15n;

function mix64(z: bigint): bigint {
  z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & M64;
  return z ^ (z >> 31n);
}

/** The stable hash of `bytes`, bit for bit the server's `StableHasher::write_bytes` then `finish`. */
export function stableHash(bytes: Uint8Array): bigint {
  let state = 0n;
  const write = (v: bigint) => {
    state = mix64(((state + GAMMA) & M64) ^ v);
  };
  write(BigInt(bytes.length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  for (; i + 8 <= bytes.length; i += 8) write(view.getBigUint64(i, true));
  if (i < bytes.length) {
    let word = 0n;
    for (let j = bytes.length - 1; j >= i; j--) word = (word << 8n) | BigInt(bytes[j]!);
    write(word);
  }
  return mix64(state ^ GAMMA);
}

/** A hash as it goes on the wire: 16 lowercase hex digits. */
export function hashHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

/** The wire form of the stable hash of `bytes`: what an `Update` and `Resume` carry. */
export function resultHash(bytes: Uint8Array): string {
  return hashHex(stableHash(bytes));
}
