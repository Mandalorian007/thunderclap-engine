#!/usr/bin/env node
// `pnpm desktop:dev`: the shell around a Vite dev server, with hot reload in the window.
//
//   (no args)     serves the desktop harness page (harness/) on 127.0.0.1:5199
//   --url <url>   uses a dev server you already run instead (must be on this machine),
//                 e.g. --url http://localhost:5173 for `pnpm dev` at the repo root
//
// The main process and preload are rebuilt once at start; restart for changes to them.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--url');
let url = i >= 0 ? args[i + 1] : undefined;

const r = spawnSync(process.execPath, [join(pkg, 'scripts/build.mjs'), '--no-renderer'], {
  stdio: 'inherit',
});
if (r.status !== 0) process.exit(r.status ?? 1);

let server = null;
if (!url) {
  server = await createServer({
    root: join(pkg, 'harness'),
    configFile: false,
    clearScreen: false,
    server: { host: '127.0.0.1', port: 5199, strictPort: true },
  });
  await server.listen();
  url = 'http://127.0.0.1:5199/';
}

/** The Electron binary that the `electron` package downloaded. */
const electronBin = createRequire(import.meta.url)('electron');
console.log(`desktop:dev: ${url}`);
const child = spawn(electronBin, [pkg], {
  stdio: 'inherit',
  env: { ...process.env, TC_RENDERER_URL: url },
});
const stop = async (code) => {
  await server?.close();
  process.exit(code ?? 0);
};
child.on('exit', (code) => void stop(code));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
