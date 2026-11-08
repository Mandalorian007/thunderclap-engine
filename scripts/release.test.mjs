// Tests for scripts/release.mjs. Run by `pnpm check:release` (node --test), which `pnpm check`
// runs. The pure checks first, then the script itself in a throwaway git repo: it may cut a
// release on `main` and on a detached HEAD at main's commit (E-039), nowhere else, and its
// commit ends with the attribution line.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTION, headProblem, pushCommand, releaseMessage } from './release.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'release.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('headProblem accepts main and a detached HEAD at main', () => {
  assert.equal(headProblem({ branch: 'main', head: A, main: A }), null);
  assert.equal(headProblem({ branch: 'HEAD', head: A, main: A }), null);
});

test('headProblem refuses another branch, a detached HEAD off main, and no main', () => {
  assert.match(headProblem({ branch: 'ws/x', head: A, main: A }), /not ws\/x/);
  assert.match(headProblem({ branch: 'HEAD', head: A, main: B }), /is not main/);
  assert.match(headProblem({ branch: 'HEAD', head: A, main: null }), /no local main/);
});

test('releaseMessage ends with the attribution line', () => {
  const msg = releaseMessage('1.2.1');
  assert.ok(msg.startsWith('release: 1.2.1\n\n'));
  assert.equal(msg.trimEnd().split('\n').at(-1), ATTRIBUTION);
});

test('pushCommand pushes a detached HEAD to main', () => {
  assert.equal(pushCommand('main', 'v1.2.1'), 'git push origin main v1.2.1');
  assert.equal(pushCommand('HEAD', 'v1.2.1'), 'git push origin HEAD:main v1.2.1');
  assert.equal(pushCommand('HEAD', null), 'git push origin HEAD:main');
});

// The script in a throwaway repo laid out like this one (scripts/release.mjs, package.json,
// CHANGELOG.md).
const repo = mkdtempSync(join(tmpdir(), 'thunderclap-release-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k.endsWith('_DIR')) delete env[k];
delete env.GIT_INDEX_FILE;
const git = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
const release = (...a) =>
  spawnSync('node', [join(repo, 'scripts', 'release.mjs'), ...a], {
    cwd: repo,
    env,
    encoding: 'utf8',
  });

mkdirSync(join(repo, 'scripts'));
copyFileSync(script, join(repo, 'scripts', 'release.mjs'));
writeFileSync(join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- a fix\n');
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-q', '-m', 'init');

test('a dry run on main and on a detached HEAD at main would go ahead', () => {
  for (const at of [
    ['switch', '-q', 'main'],
    ['switch', '-q', '--detach', 'main'],
  ]) {
    git(...at);
    const r = release('1.0.1', '--tag', '--dry');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /would stop/);
  }
});

test('a dry run on another branch or a detached HEAD off main would stop', () => {
  git('switch', '-q', '-c', 'side', 'main');
  assert.match(
    release('1.0.1', '--dry').stdout,
    /would stop: releases are cut from main, not side/,
  );
  git('commit', '-q', '--allow-empty', '-m', 'ahead');
  git('switch', '-q', '--detach', 'side');
  assert.match(release('1.0.1', '--dry').stdout, /would stop: the detached HEAD .* is not main/);
  const r = release('1.0.1', '--skip-checks');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not main/);
});

test('a release from a detached HEAD at main commits with the attribution line and tags', () => {
  git('switch', '-q', '--detach', 'main');
  const r = release('1.0.1', '--tag', '--skip-checks');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /git push origin HEAD:main v1\.0\.1/);
  assert.equal(git('log', '-1', '--format=%B'), `release: 1.0.1\n\n${ATTRIBUTION}`);
  assert.equal(git('rev-parse', 'v1.0.1^{commit}'), git('rev-parse', 'HEAD'));
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, '1.0.1');
  assert.match(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'), /## Unreleased\n\n## 1\.0\.1 \(/);
});

test('a release on main prints a plain push', () => {
  git('switch', '-q', 'main');
  const r = release('1.0.2', '--skip-checks');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /git push origin main\n/);
  assert.equal(git('log', '-1', '--format=%B'), `release: 1.0.2\n\n${ATTRIBUTION}`);
});
