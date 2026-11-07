// Tests for scripts/create-game.mjs. Run by `pnpm check:create-game` (node --test), which
// `pnpm check` runs. Scaffolds into a temp dir, asserts the rewritten manifest and the file set, then
// installs offline (`pnpm install --offline`), then runs `tsc --noEmit` and `pnpm build` against
// this repo through `--engine link:<repo>`. When the offline install cannot be satisfied from the
// pnpm store the tsc and build steps are skipped and said so; the manifest and file-set assertions
// always run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  ENGINE,
  engineSpec,
  listTemplates,
  PUBLISHED,
  parseArgs,
  rewriteManifest,
  root,
  templateFiles,
  UsageError,
} from './create-game.mjs';

const script = join(root, 'scripts', 'create-game.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'create-game-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: tmp });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('parseArgs: positional dir, valued options, flags, misuse', () => {
  assert.deepEqual(parseArgs(['g', '--template', 'puzzle', '--force', '--dry-run']), {
    dir: 'g',
    template: 'puzzle',
    name: null,
    engine: null,
    force: true,
    dryRun: true,
    list: false,
  });
  assert.equal(parseArgs(['--list']).list, true);
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(['g', '--name']), UsageError);
  assert.throws(() => parseArgs(['g', '--bogus']), UsageError);
  assert.throws(() => parseArgs(['g', 'h']), UsageError);
});

/** The directory a `link:` spec written for a project in `dest` points at. */
const linkTarget = (spec, dest) => resolve(dest, spec.slice('link:'.length));

test('engineSpec: default links this clone until published, then a caret range', () => {
  assert.equal(PUBLISHED, false);
  const d = engineSpec(null, join(tmp, 'game'), '0.2.0-alpha.1');
  assert.match(d, /^link:/);
  assert.equal(linkTarget(d, join(tmp, 'game')), resolve(root));
  assert.equal(engineSpec(null, tmp, '0.2.0-alpha.1', true), '^0.2.0-alpha.1');
});

test('engineSpec: specs kept, directories become link:', () => {
  for (const s of ['^0.3.0', '0.3.0', '*', 'github:a/b', 'link:../e', 'file:../e.tgz', 'npm:x@1']) {
    assert.equal(engineSpec(s, tmp, '0'), s);
  }
  mkdirSync(join(tmp, 'engine'));
  assert.equal(engineSpec(join(tmp, 'engine'), join(tmp, 'game'), '0'), 'link:../engine');
  assert.throws(() => engineSpec(join(tmp, 'missing'), tmp, '0'), UsageError);
});

test('rewriteManifest: name, private, engine spec, monorepo scripts dropped, key order kept', () => {
  const next = rewriteManifest(
    {
      name: '@thunderclap/template-x',
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'vite', check: 'pnpm typecheck && pnpm test', root: 'pnpm --filter a check' },
      devDependencies: { vite: '^8', [ENGINE]: 'workspace:*', typescript: '^7' },
    },
    { name: 'my-game', engine: '^0.2.0' },
  );
  assert.deepEqual(Object.keys(next), [
    'name',
    'version',
    'type',
    'scripts',
    'devDependencies',
    'private',
  ]);
  assert.equal(next.name, 'my-game');
  assert.equal(next.private, true);
  assert.deepEqual(next.scripts, { dev: 'vite', check: 'pnpm typecheck && pnpm test' });
  assert.deepEqual(Object.keys(next.devDependencies), ['vite', ENGINE, 'typescript']);
  assert.equal(next.devDependencies[ENGINE], '^0.2.0');
});

test('--list prints every template with its description', () => {
  const templates = listTemplates();
  assert.ok(templates.some((t) => t.name === 'puzzle'));
  const r = run('--list');
  assert.equal(r.status, 0, r.stderr);
  for (const t of templates) {
    assert.match(r.stdout, new RegExp(`^${t.name}\\s`, 'm'));
    assert.ok(r.stdout.includes(t.description), `description of ${t.name}`);
  }
});

test('misuse exits 1 with usage; a missing template names the ones that exist', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: pnpm create-game/);
  const t = run('g', '--template', 'nope');
  assert.equal(t.status, 1);
  assert.match(t.stderr, /no template "nope" \(have: .*puzzle/);
});

test('--dry-run prints the plan and writes nothing', () => {
  const r = run('dry', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would write \d+ files/);
  assert.match(r.stdout, /package\.json {2}\(generated\)/);
  assert.match(r.stdout, /src\/main\.ts/);
  assert.equal(existsSync(join(tmp, 'dry')), false);
});

test('a non-empty target is refused without --force and written with it', () => {
  const dir = join(tmp, 'busy');
  mkdirSync(dir);
  writeFileSync(join(dir, 'keep.txt'), 'mine');
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not empty/);
  assert.equal(existsSync(join(dir, 'package.json')), false);
  const f = run(dir, '--force');
  assert.equal(f.status, 0, f.stderr);
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'mine');
  assert.equal(readJson(join(dir, 'package.json')).name, 'busy');
});

for (const { name: template } of listTemplates()) {
  test(`scaffolds ${template}: file set, manifest, generated files, then tsc against link:<repo>`, () => {
    const dir = join(tmp, `${template}-game`);
    const r = run(dir, '--template', template, '--name', 'my-game', '--engine', `link:${root}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /create-game: done/);

    // File set: every template file minus the skipped entries, plus the generated ones.
    const expected = templateFiles(join(root, 'templates', template));
    for (const f of expected) assert.ok(existsSync(join(dir, f)), `missing ${f}`);
    for (const f of ['.gitignore', 'README.md', 'biome.json', 'CLAUDE.md', 'package.json']) {
      assert.ok(existsSync(join(dir, f)), `missing ${f}`);
    }
    for (const f of ['node_modules', 'dist', 'pnpm-lock.yaml'])
      assert.equal(existsSync(join(dir, f)), false);

    // Manifest.
    const src = readJson(join(root, 'templates', template, 'package.json'));
    const pkg = readJson(join(dir, 'package.json'));
    assert.equal(pkg.name, 'my-game');
    assert.equal(pkg.private, true);
    assert.equal(pkg.devDependencies[ENGINE], `link:${root}`);
    assert.deepEqual(Object.keys(pkg), [...new Set([...Object.keys(src), 'private'])]);
    for (const [k, v] of Object.entries(src.devDependencies)) {
      if (k !== ENGINE) assert.equal(pkg.devDependencies[k], v);
    }
    assert.ok(!Object.values(pkg.scripts).some((c) => /--filter/.test(c)));

    // Every template builds; the default engine spec links this clone (not on npm yet).
    assert.equal(pkg.scripts.build, 'vite build');
    assert.doesNotMatch(pkg.description, /Copy the folder/);
    const d = run(join(tmp, `${template}-default`), '--template', template, '--dry-run');
    assert.match(d.stdout, new RegExp(`${ENGINE.replace('/', '\\/')} "link:`));

    // CLAUDE.md no longer points at this repo's root scripts.
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.doesNotMatch(claude, /from the repo root|check:template-|repo's `biome\.json`/);
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /pnpm dev/);

    // Typecheck against the linked engine. Offline install only; skip (and say so) when the store
    // cannot satisfy it.
    const install = spawnSync(
      'pnpm',
      ['install', '--offline', '--ignore-scripts', '--reporter=silent'],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    if (install.status !== 0) {
      console.log(
        `create-game.test: offline install unavailable for ${template}; tsc step skipped (manifest asserted instead)`,
      );
      return;
    }
    assert.ok(existsSync(join(dir, 'node_modules', ENGINE, 'package.json')), 'engine not linked');
    execFileSync('pnpm', ['exec', 'tsc', '--noEmit'], {
      cwd: dir,
      stdio: 'inherit',
      timeout: 180_000,
    });
    // And the static bundle builds: dist/index.html and at least one script.
    execFileSync('pnpm', ['run', 'build', '--logLevel', 'warn'], {
      cwd: dir,
      stdio: 'inherit',
      timeout: 180_000,
    });
    assert.ok(existsSync(join(dir, 'dist', 'index.html')), 'no dist/index.html');
    assert.ok(
      readdirSync(join(dir, 'dist', 'assets')).some((f) => f.endsWith('.js')),
      'no script in dist/assets',
    );
  });
}
