#!/usr/bin/env node
// Cut a @thunderclap-engine/engine release.
//
//   pnpm release <version>          bump package.json, date the CHANGELOG, commit (no tag)
//   pnpm release <version> --tag    also create the annotated tag v<version>
//   pnpm release <version> --dry    print what would happen, change nothing
//   --skip-checks                   skip `pnpm check` and `pnpm test:e2e` before the bump
//
// A prerelease version (`2.0.0-next.0`) is cut the same way; publish.yml puts it on npm under the
// `next` dist-tag, never `latest`. `pnpm test:e2e` includes the webkit-ipad project on macOS.
//
// Run it on `main`, or on a detached HEAD at main's commit (an integrator's worktree, which may
// not check out `main` while the main checkout has it; E-039). This is the only way the repo gets
// tags. It never pushes: the printed push command is yours to run. Pushing a v* tag publishes the
// npm packages (.github/workflows/publish.yml, docs/releasing.md).
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The attribution line every commit in this repo ends with (docs/briefs/common.md). */
export const ATTRIBUTION = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

/** The release commit's message. */
export function releaseMessage(version) {
  return `release: ${version}\n\n${ATTRIBUTION}\n`;
}

/**
 * Why HEAD is no place to cut a release, or null when it is: `branch` is
 * `git rev-parse --abbrev-ref HEAD` ('HEAD' when detached), `head` and `main` the commits of
 * HEAD and of the local `main` (null when there is none).
 */
export function headProblem({ branch, head, main }) {
  if (branch === 'main') return null;
  if (branch !== 'HEAD') return `releases are cut from main, not ${branch}`;
  if (!main) return 'there is no local main branch to compare the detached HEAD with';
  if (head !== main)
    return `the detached HEAD (${head.slice(0, 7)}) is not main (${main.slice(0, 7)})`;
  return null;
}

/** A semver version `pnpm release` accepts: `1.2.3`, or a prerelease such as `2.0.0-next.0`. */
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/**
 * The npm dist-tag a version publishes under (publish.yml): a prerelease (any `-` suffix) goes to
 * `next`, so `npm install` keeps resolving the last stable version; everything else to `latest`.
 */
export function distTag(version) {
  return version.includes('-') ? 'next' : 'latest';
}

/** The push command to print: a detached HEAD pushes itself to main, since main did not move. */
export function pushCommand(branch, tagName) {
  return `git push origin ${branch === 'main' ? 'main' : 'HEAD:main'}${tagName ? ` ${tagName}` : ''}`;
}

function main() {
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
  const tryGit = (...a) => {
    try {
      return git(...a);
    } catch {
      return null;
    }
  };
  const run = (cmd, ...a) => execFileSync(cmd, a, { cwd: root, stdio: 'inherit' });

  if (!version || !VERSION.test(version)) {
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

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const problems = [];
  if (git('status', '--porcelain')) problems.push('working tree is not clean');
  const where = headProblem({
    branch,
    head: git('rev-parse', 'HEAD'),
    main: tryGit('rev-parse', '--verify', '--quiet', 'refs/heads/main'),
  });
  if (where) problems.push(where);
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
  git('commit', '-q', '-m', releaseMessage(version));
  if (tag) git('tag', '-a', tagName, '-m', `@thunderclap-engine/engine ${version}`);

  console.log(`release: committed${tag ? ` and tagged ${tagName}` : ''}. Push with:`);
  console.log(`  ${pushCommand(branch, tag ? tagName : null)}`);
  if (tag) {
    console.log(
      `release: pushing ${tagName} publishes to npm under the dist-tag ${distTag(version)} (publish.yml, docs/releasing.md).`,
    );
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
