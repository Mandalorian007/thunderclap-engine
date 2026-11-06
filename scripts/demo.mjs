#!/usr/bin/env node
/**
 * `pnpm demo <name>`: serves `demos/<name>/` with Vite on 127.0.0.1 (E-021). Without a name it
 * lists the demos (one folder per demo under `demos/`, each with an `index.html`).
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const demosDir = `${root}demos`;

const demos = existsSync(demosDir)
  ? readdirSync(demosDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(`${demosDir}/${d.name}/index.html`))
      .map((d) => d.name)
      .sort()
  : [];

const name = process.argv[2];
if (!name || !demos.includes(name)) {
  if (name) console.error(`Unknown demo "${name}".`);
  console.log('Usage: pnpm demo <name>\n\nDemos:');
  for (const d of demos) console.log(`  ${d}`);
  process.exit(name ? 1 : 0);
}

const child = spawn(
  'pnpm',
  ['exec', 'vite', `demos/${name}`, '--host', '127.0.0.1', ...process.argv.slice(3)],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
child.on('exit', (code) => process.exit(code ?? 0));
