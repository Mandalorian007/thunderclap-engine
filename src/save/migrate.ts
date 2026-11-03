/**
 * Migrations chain. `migrations[n]` upgrades data from version `n` to `n + 1`.
 * Versions are positive integers; the first shipped version is 1.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations operate on untyped legacy shapes.
export type Migration = (data: any) => unknown;
export type Migrations = Readonly<Record<number, Migration>>;

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly fromVersion: number,
    readonly toVersion: number,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Throws `MigrationError` if a step is missing, the data is from the future, or a step throws. */
export function runMigrations(
  data: unknown,
  fromVersion: number,
  toVersion: number,
  migrations: Migrations,
): unknown {
  if (!Number.isInteger(fromVersion) || fromVersion < 1)
    throw new MigrationError(`invalid save version ${fromVersion}`, fromVersion, toVersion);
  if (fromVersion > toVersion)
    throw new MigrationError(
      `save version ${fromVersion} is newer than this build (${toVersion})`,
      fromVersion,
      toVersion,
    );
  let current = data;
  for (let v = fromVersion; v < toVersion; v++) {
    const step = migrations[v];
    if (!step) throw new MigrationError(`no migration from v${v} to v${v + 1}`, v, toVersion);
    try {
      current = step(current);
    } catch (err) {
      throw new MigrationError(
        `migration v${v} → v${v + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
        v,
        toVersion,
      );
    }
  }
  return current;
}

/** Throws if the chain `1 → version` has gaps. Call once at startup or in a test. */
export function assertMigrationChain(version: number, migrations: Migrations): void {
  for (let v = 1; v < version; v++) {
    if (typeof migrations[v] !== 'function')
      throw new MigrationError(`migration chain gap: v${v} → v${v + 1}`, v, version);
  }
}
