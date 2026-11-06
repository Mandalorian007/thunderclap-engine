/**
 * The manifest `pnpm bake` (`scripts/bake.mjs`) writes next to its baked bytes: what was baked
 * from which sources, with a hash of the inputs. A game reads it to know which `.navm` and
 * `.coll` files exist (and to decide whether to fall back to a runtime bake).
 */

/** What one baked file is. */
export type BakeKind = 'nav' | 'collider';

export interface BakeManifestEntry {
  /** The config entry's `name`: the file is `<name>.navm` or `<name>.coll` beside the manifest. */
  name: string;
  kind: BakeKind;
  /** The source files, as the config named them. */
  sources: string[];
  /** Hex SHA-256 over the sources' bytes and the entry's options. */
  sha256: string;
  /** Size of the baked file. */
  bytes: number;
  /** Bake time, milliseconds. */
  ms: number;
}

export interface BakeManifest {
  version: number;
  /** ISO 8601. */
  bakedAt: string;
  entries: BakeManifestEntry[];
}

/** The manifest format this reader accepts. */
export const BAKE_MANIFEST_VERSION = 1;

/**
 * Parse `bake-manifest.json` (a string or already-parsed JSON). Throws on another format version
 * or a malformed entry, so a stale manifest fails loudly instead of naming files that are not there.
 */
export function readBakeManifest(json: string | unknown): BakeManifest {
  const raw: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  if (!raw || typeof raw !== 'object') throw new Error('bake-manifest: not an object');
  const m = raw as Record<string, unknown>;
  if (m.version !== BAKE_MANIFEST_VERSION) {
    throw new Error(
      `bake-manifest: version ${String(m.version)}, expected ${BAKE_MANIFEST_VERSION}`,
    );
  }
  if (!Array.isArray(m.entries)) throw new Error('bake-manifest: entries is not an array');
  const entries: BakeManifestEntry[] = m.entries.map((e: unknown, i) => {
    const r = (e ?? {}) as Record<string, unknown>;
    const kind = r.kind;
    if (typeof r.name !== 'string' || (kind !== 'nav' && kind !== 'collider')) {
      throw new Error(`bake-manifest: entry ${i} has no name or an unknown kind`);
    }
    return {
      name: r.name,
      kind,
      sources: Array.isArray(r.sources) ? r.sources.map(String) : [],
      sha256: typeof r.sha256 === 'string' ? r.sha256 : '',
      bytes: typeof r.bytes === 'number' ? r.bytes : 0,
      ms: typeof r.ms === 'number' ? r.ms : 0,
    };
  });
  return { version: BAKE_MANIFEST_VERSION, bakedAt: String(m.bakedAt ?? ''), entries };
}
