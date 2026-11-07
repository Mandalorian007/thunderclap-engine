#!/usr/bin/env node
// Cut a @thunderclap/engine release.
//
//   pnpm release <version>          bump package.json, date the CHANGELOG, commit (no tag)
//   pnpm release <version> --tag    also create the annotated tag v<version>
//   pnpm release <version> --dry    print what would happen, change nothing
//   --skip-checks                   skip `pnpm check` and `pnpm test:e2e` before the bump
//
// This is the only way the repo gets tags. It never pushes: the printed push command is yours to run.
// Pushing a v* tag publishes the npm packages (.github/workflows/publish.yml, docs/releasing.md).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const logPath = join(root, 'CHANGELOG.md');

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const tag = args.includes('--tag');
const dry = args.includes('--dry');
const skipChecks = args.includes('--skip-checks');

const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const run = (cmd, ...a) => execFileSync(cmd, a, { cwd: root, stdio: 'inherit' });

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  fail('usage: pnpm release <semver> [--tag] [--dry] [--skip-checks]');
}
const tagName = `v${version}`;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const log = readFileSync(logPath, 'utf8');
// The first "## Unreleased" heading (or an older "## <x> (unreleased)") becomes
// "## <version> (<date>)", under a fresh empty "## Unreleased" (the section `check:api` reads).
const head = /^## (?:Unreleased[ \t]*|[^\n]*\(unreleased\)[^\n]*)$/m;
if (!head.test(log)) fail('CHANGELOG.md has no "## Unreleased" section to release');
const date = new Date().toISOString().slice(0, 10);
const nextLog = log.replace(head, `## Unreleased\n\n## ${version} (${date})`);

const problems = [];
if (git('status', '--porcelain')) problems.push('working tree is not clean');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main')
  problems.push('releases are cut from main');
if (tag && git('tag', '--list', tagName)) problems.push(`tag ${tagName} already exists`);

console.log(`release: ${pkg.version} -> ${version}${tag ? `, tag ${tagName}` : ', no tag'}`);
console.log(`release: CHANGELOG "${log.match(head)[0]}" -> "## ${version} (${date})"`);
if (dry) {
  for (const p of problems) console.log(`release: (a real run would stop: ${p})`);
  process.exit(0);
}
if (problems.length) fail(problems.join('; '));

if (!skipChecks) {
  run('pnpm', 'check');
  run('pnpm', 'test:e2e');
}

pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(logPath, nextLog);
git('add', pkgPath, logPath);
git('commit', '-q', '-m', `release: ${version}`);
if (tag) git('tag', '-a', tagName, '-m', `@thunderclap/engine ${version}`);

console.log(`release: committed${tag ? ` and tagged ${tagName}` : ''}. Push with:`);
console.log(`  git push origin main${tag ? ` ${tagName}` : ''}`);
if (tag) {
  console.log(`release: pushing ${tagName} publishes to npm (publish.yml, docs/releasing.md).`);
}
