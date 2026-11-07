// Tests for scripts/check-snippets.mjs: the extraction rules, a broken snippet failing at its
// Markdown line where the fixed one passes, and a deprecated name failing the same way.
// Run by `pnpm check:snippets`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Every export and member name in `api/`, as `module name` (`render Renderer.white`). */
function apiNames(apiDir = join(root, 'api')) {
  const out = new Set();
  for (const f of readdirSync(apiDir)) {
    if (!f.endsWith('.api.txt')) continue;
    const module = f === 'index.api.txt' ? 'engine' : f.slice(0, -'.api.txt'.length);
    let section = '';
    for (const line of readFileSync(join(apiDir, f), 'utf8').split('\n')) {
      const head = /^## (\S+)/.exec(line);
      if (head) {
        section = head[1];
        out.add(`${module} ${section}`);
        continue;
      }
      const member = /^\s+(?:readonly\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)/.exec(line);
      if (member && section) out.add(`${module} ${section}.${member[1]}`);
    }
  }
  return out;
}

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
    "import { Camera } from '@thunderclap-engine/engine/render';\nconst camera = Camera.ortho2d(1920, 1080);";
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
  // engine-v1.0.0 deprecates nothing, so the snippet declares its own deprecated names; the
  // DOM's `execCommand` counts too (snippets show no deprecated name of any origin).
  writeFileSync(
    md,
    doc(
      [
        "import type { AudioPlayOptions } from '@thunderclap-engine/engine/audio';",
        '/** @deprecated use `AudioPlayOptions` */',
        'type PlayOptions = AudioPlayOptions;',
        '/** @deprecated use the getter */',
        'declare function getGestures(): void;',
        'export const opts: PlayOptions = {};',
        'getGestures();',
        "document.execCommand('copy');",
      ].join('\n'),
    ),
  );
  const bad = checkSnippets([[md, true]], cache);
  assert.equal(bad.count, 1);
  // The deprecated type's use, the deprecated call, and the DOM's deprecated call.
  assert.equal(bad.errors.length, 3, bad.errors.join('\n'));
  assert.match(bad.errors[0], /deprecated\.md:11:20 +error TS6385: 'PlayOptions' is deprecated/);
  assert.match(bad.errors[1], /deprecated\.md:12:1 +error TS6387: .*getGestures/);
  assert.match(bad.errors[2], /deprecated\.md:13:10 +error TS6387: .*execCommand/);
  // With the pass off, only real type errors count.
  assert.deepEqual(checkSnippets([[md, true]], cache, { deprecations: false }), {
    count: 1,
    errors: [],
  });

  writeFileSync(
    md,
    doc(
      [
        "import type { AudioPlayOptions } from '@thunderclap-engine/engine/audio';",
        "import type { Input } from '@thunderclap-engine/engine/input';",
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
  writeFileSync(join(sub, 'old.ts'), '/** @deprecated */\nexport type Rect = { w: number };\n');
  writeFileSync(file, "// é → ×\nimport type { Rect } from './old.ts';\nexport type R = Rect;\n");
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

/** The table rows (`` | `mod` | `Type.member()` | … ``) under the guide's getter heading. */
const getterLines = (lines) => {
  const start = lines.findIndex((l) => /^## Reads that became getters\s*$/.test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((l) => /^\|\s*`[^`]+`\s*\|\s*`[^`(]+/.test(l));
};

test('the migration guide lists every @deprecated export in api/, and no row is still exported', () => {
  const key = (r) => `${r.module === '.' ? 'engine' : r.module} ${r.name}`;
  const api = deprecatedApiNames().map(key);
  const guide = readFileSync(join(root, 'docs', 'guide', 'migrating-to-v1.md'), 'utf8');
  const rows = migrationRows(guide);
  // A later deprecation needs its row before it can ship (engine-v1.0.0 has none).
  assert.deepEqual(
    api.filter((k) => !rows.map(key).includes(k)),
    [],
    'deprecated in api/*.api.txt but missing from docs/guide/migrating-to-v1.md',
  );
  // Every row is a 0.x name the 1.0.0 cut removed: none is still on its entry's surface. A row
  // for a retired call signature (`createSpriteMaterial(texture, label?, opts?)`) keeps its name,
  // and so does a row of the *Reads that became getters* table (`AssetCache.stats()` is now the
  // `stats` getter).
  const exported = apiNames();
  const rowKey = (l) => /^\|\s*`([^`]+)`\s*\|\s*`([^`(]+)/.exec(l).slice(1).join(' ');
  const lines = guide.split('\n');
  const overload = new Set(
    lines.filter((l) => /^\|\s*`[^`]+`\s*\|\s*`[^`(]+\([^)`]+\)`/.test(l)).map(rowKey),
  );
  const getter = new Set(getterLines(lines).map(rowKey));
  assert.ok(getter.size > 0, 'the getter table has no rows: is its heading still right?');
  assert.ok(rows.length > 0, 'the migration table has no rows: is the parser still right?');
  assert.deepEqual(
    rows.map(key).filter((k) => exported.has(k) && !overload.has(k) && !getter.has(k)),
    [],
    'a row of docs/guide/migrating-to-v1.md names something api/*.api.txt still exports',
  );
  assert.equal(new Set(rows.map(key)).size, rows.length, 'a row is listed twice');
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
