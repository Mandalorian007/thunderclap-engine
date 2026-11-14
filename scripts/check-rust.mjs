// `pnpm check:rust`: the Rust workspace (crates/) formatted, lint-clean and
// tested. Skipped with a notice where cargo is not installed, so a
// JavaScript-only checkout still runs `pnpm check`.
import { spawnSync } from 'node:child_process';

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
for (const args of [
  ['fmt', '--all', '--check'],
  ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
  ['test', '--workspace'],
]) {
  const r = run(args);
  if (r.status !== 0) {
    console.error(`check:rust: cargo ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
}
