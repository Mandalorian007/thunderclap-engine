// `pnpm check:rust`: the Rust workspace (crates/) formatted, lint-clean and
// tested, then each template's server crate (templates/<name>/server, its own
// workspace on the engine's crates by path) the same way. Skipped with a notice where cargo is not installed, so a
// JavaScript-only checkout still runs `pnpm check`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const run = (args) =>
  spawnSync('cargo', args, { stdio: 'inherit', shell: process.platform === 'win32' });

const probe = spawnSync('cargo', ['--version'], {
  stdio: 'ignore',
  shell: process.platform === 'win32',
});
if (probe.error || probe.status !== 0) {
  console.log(
    'check:rust: cargo not found, skipping the Rust crates (install rustup to check them)',
  );
  process.exit(0);
}
/** The template server crates: templates/<name>/server/Cargo.toml. */
const servers = readdirSync(join(root, 'templates'))
  .map((name) => join(root, 'templates', name, 'server', 'Cargo.toml'))
  .filter((p) => existsSync(p));

const steps = [
  ['fmt', '--all', '--check'],
  ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
  ['test', '--workspace'],
];
for (const manifest of [null, ...servers]) {
  for (const step of steps) {
    // A template's server builds into its own target/ (gitignored), as a game's would.
    const args = manifest ? [step[0], '--manifest-path', manifest, ...step.slice(1)] : step;
    const r = run(args);
    if (r.status !== 0) {
      console.error(`check:rust: cargo ${args.join(' ')} failed`);
      process.exit(r.status ?? 1);
    }
  }
}
