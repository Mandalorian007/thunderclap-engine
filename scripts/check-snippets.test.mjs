// Tests for scripts/check-snippets.mjs: the extraction rules, a broken snippet failing at its
// Markdown line where the fixed one passes, and a deprecated name failing the same way.
// Run by `pnpm check:snippets`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  checkSnippets,
  deprecatedApiNames,
  extractSnippets,
  findDeprecatedUses,
  MARKER,
  migrationRows,
  root,
} from './check-snippets.mjs';

const dir = mkdtempSync(join(tmpdir(), 'check-snippets-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const fence = '```';
const doc = (body) => `# Guide\n\nSome prose.\n\n${fence}ts\n${body}\n${fence}\n`;

test('extracts ts blocks with the line of their first code line', () => {
  const text = `a\n\n${fence}ts\nconst x = 1;\n${fence}\n\n${fence}sh\nls\n${fence}\n`;
  assert.deepEqual(extractSnippets(text, true), [{ line: 4, code: 'const x = 1;' }]);
});

test('skips ts no-check blocks', () => {
  const text = `${fence}ts no-check\nfragment(\n${fence}\n${fence}typescript\nlet y = 2;\n${fence}\n`;
  assert.deepEqual(
    extractSnippets(text, true).map((s) => s.code),
    ['let y = 2;'],
  );
});

test('a module README checks only blocks right after the marker', () => {
  const text = `${fence}ts\nunchecked();\n${fence}\n\n${MARKER}\n\n${fence}ts\nchecked();\n${fence}\n`;
  assert.deepEqual(
    extractSnippets(text, false).map((s) => s.code),
    ['checked();'],
  );
  assert.equal(extractSnippets(text, true).length, 2);
});

test('a broken snippet fails at its Markdown line; the fixed one passes', () => {
  const md = join(dir, 'guide.md');
  const cache = join(dir, 'cache');
  const head =
    "import { Camera } from '@thunderclap/engine/render';\nconst camera = Camera.ortho2d(1920, 1080);";
  writeFileSync(md, doc(`${head}\ncamera.notAMethod();`));
  const broken = checkSnippets([[md, true]], cache);
  assert.equal(broken.count, 1);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0], /guide\.md:8:\d+ +error TS2339/);

  writeFileSync(md, doc(`${head}\ncamera.lookAt([0, 0, 5], [0, 0, 0]);`));
  assert.deepEqual(checkSnippets([[md, true]], cache), { count: 1, errors: [] });
});

test('a snippet that uses a deprecated name fails with TS6385/TS6387; the v1 names pass', () => {
  const md = join(dir, 'deprecated.md');
  const cache = join(dir, 'cache-deprecated');
  writeFileSync(
    md,
    doc(
      [
        "import type { PlayOptions } from '@thunderclap/engine/audio';",
        "import type { Input } from '@thunderclap/engine/input';",
        'declare const input: Input<string>;',
        'export const opts: PlayOptions = {};',
        'input.getGestures();',
      ].join('\n'),
    ),
  );
  const bad = checkSnippets([[md, true]], cache);
  assert.equal(bad.count, 1);
  // The import of `PlayOptions`, its use, and the deprecated method signature.
  assert.equal(bad.errors.length, 3, bad.errors.join('\n'));
  assert.match(bad.errors[0], /deprecated\.md:6:15 +error TS6385: 'PlayOptions' is deprecated/);
  assert.match(bad.errors[1], /deprecated\.md:9:20 +error TS6385/);
  assert.match(bad.errors[2], /deprecated\.md:10:7 +error TS6387: .*getGestures/);
  // With the pass off, only real type errors count.
  assert.deepEqual(checkSnippets([[md, true]], cache, { deprecations: false }), {
    count: 1,
    errors: [],
  });

  writeFileSync(
    md,
    doc(
      [
        "import type { AudioPlayOptions } from '@thunderclap/engine/audio';",
        "import type { Input } from '@thunderclap/engine/input';",
        'declare const input: Input<string>;',
        'export const opts: AudioPlayOptions = {};',
        'void input.gestures;',
      ].join('\n'),
    ),
  );
  assert.deepEqual(checkSnippets([[md, true]], cache), { count: 1, errors: [] });
});

test('findDeprecatedUses reports 1-based lines and columns past non-ASCII text', () => {
  const sub = join(dir, 'find');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'a.ts');
  writeFileSync(
    file,
    "// é → ×\nimport type { Rect } from '@thunderclap/engine/platform';\nexport type R = Rect;\n",
  );
  writeFileSync(
    join(sub, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2022',
        lib: ['es2022', 'dom'],
        allowImportingTsExtensions: true,
        noEmit: true,
        types: [],
        paths: { '@thunderclap/engine/platform': [join(root, 'src', 'platform', 'index.ts')] },
      },
      files: [file],
    }),
  );
  assert.deepEqual(
    findDeprecatedUses(join(sub, 'tsconfig.json')).map((u) => [u.line, u.col, u.code]),
    [
      [2, 15, 6385],
      [3, 17, 6385],
    ],
  );
});

test('the migration guide lists every @deprecated export in api/, and nothing else', () => {
  const key = (r) => `${r.module === '.' ? 'engine' : r.module} ${r.name}`;
  const api = deprecatedApiNames().map(key);
  const guide = join(root, 'docs', 'guide', 'migrating-to-v1.md');
  const rows = migrationRows(readFileSync(guide, 'utf8')).map(key);
  assert.ok(api.length > 0, 'api/ has no @deprecated entries: is the parser still right?');
  assert.deepEqual(
    api.filter((k) => !rows.includes(k)),
    [],
    'deprecated in api/*.api.txt but missing from docs/guide/migrating-to-v1.md',
  );
  assert.deepEqual(
    rows.filter((k) => !api.includes(k)),
    [],
    'a row of docs/guide/migrating-to-v1.md names nothing deprecated in api/*.api.txt',
  );
  assert.equal(new Set(rows).size, rows.length, 'a row is listed twice');
});

test('deprecatedApiNames reads top-level and member deprecations', () => {
  const api = join(dir, 'api');
  mkdirSync(api, { recursive: true });
  writeFileSync(
    join(api, 'x.api.txt'),
    [
      '## Fog  (type-only)',
      '@deprecated',
      'type Fog = DistanceFog;',
      '',
      '## Renderer',
      'class Renderer {',
      '    @deprecated',
      '    get white(): Texture;',
      '    @deprecated',
      '    make(a: number): void;',
      '    @deprecated',
      '    make(a: string): void;',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(deprecatedApiNames(api), [
    { module: 'x', name: 'Fog' },
    { module: 'x', name: 'Renderer.make' },
    { module: 'x', name: 'Renderer.white' },
  ]);
  assert.deepEqual(
    migrationRows(
      '| Module | Deprecated | v1 |\n| --- | --- | --- |\n| `x` | `Renderer.make(a)` | b |',
    ),
    [{ module: 'x', name: 'Renderer.make' }],
  );
});
