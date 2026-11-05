#!/usr/bin/env node
// `pnpm desktop:build`: builds out/ (scripts/build.mjs) and packages it with electron-builder
// into dist/desktop/ at the repo root, for this OS unless told otherwise.
//
//   --mac | --win | --linux   target OS (default: the one this runs on; several allowed)
//   --renderer <dir>          package this built web app instead of the desktop harness page
//                             (its index.html is served at app://bundle/)
//   --dir                     unpacked app only, no installers (fast local check)
//
// Never signs with a certificate: CSC_IDENTITY_AUTO_DISCOVERY is forced off so a developer
// certificate in the local keychain is not picked up.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform } from 'electron-builder';
import config from '../electron-builder.config.mjs';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const renderer = value('--renderer');
if (renderer && !existsSync(join(resolve(renderer), 'index.html'))) {
  console.error(`desktop:build: ${renderer} has no index.html`);
  process.exit(1);
}

const r = spawnSync(
  process.execPath,
  [join(pkg, 'scripts/build.mjs'), ...(renderer ? ['--no-renderer'] : [])],
  { stdio: 'inherit' },
);
if (r.status !== 0) process.exit(r.status ?? 1);
// A game's dist/ may also hold earlier desktop builds (dist/desktop/): never package those.
const outputDir = resolve(pkg, config.directories.output);
if (renderer) {
  cpSync(resolve(renderer), join(pkg, 'out/renderer'), {
    recursive: true,
    filter: (src) => {
      const p = resolve(src);
      return p !== outputDir && !p.startsWith(`${outputDir}${sep}`);
    },
  });
}

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const platforms = [
  flag('--mac') && Platform.MAC,
  flag('--win') && Platform.WINDOWS,
  flag('--linux') && Platform.LINUX,
].filter(Boolean);
if (!platforms.length) platforms.push(Platform.current());

const targets = new Map();
for (const p of platforms) {
  for (const [k, v] of p.createTarget(flag('--dir') ? 'dir' : undefined)) targets.set(k, v);
}

const files = await build({ projectDir: pkg, config, targets, publish: 'never' });
const out = files.filter((f) => !f.endsWith('.blockmap'));
console.log(`desktop:build: ${out.length} artefact(s)\n  ${out.join('\n  ')}`);
