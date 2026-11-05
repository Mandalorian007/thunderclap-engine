#!/usr/bin/env node
// Builds the shell into out/ with Vite:
//   out/main.mjs     the main process (ESM, Node; `electron` and node: builtins external)
//   out/preload.cjs  the preload (one CommonJS file: a sandboxed preload cannot load others)
//   out/renderer/    the desktop harness page, unless --no-renderer
// electron-builder packages out/ and package.json, nothing else (electron-builder.config.mjs).
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(pkg, 'out');
const withRenderer = !process.argv.includes('--no-renderer');

rmSync(out, { recursive: true, force: true });

/** @param {string} entry @param {'es' | 'cjs'} format @param {string} file */
const node = (entry, format, file) =>
  build({
    root: pkg,
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: join(pkg, entry),
      outDir: out,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      sourcemap: false,
      rolldownOptions: {
        external: ['electron', /^node:/],
        output: { format, entryFileNames: file, codeSplitting: false },
      },
    },
  });

await node('src/main/main.ts', 'es', 'main.mjs');
await node('src/preload/preload.ts', 'cjs', 'preload.cjs');

if (withRenderer) {
  await build({
    root: join(pkg, 'harness'),
    configFile: false,
    logLevel: 'warn',
    base: './',
    build: { outDir: join(out, 'renderer'), emptyOutDir: true, target: 'es2022' },
  });
}

console.log(`host-electron: built ${withRenderer ? 'main, preload, renderer' : 'main, preload'}`);
