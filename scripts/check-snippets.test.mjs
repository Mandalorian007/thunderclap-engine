// Tests for scripts/check-snippets.mjs: the extraction rules, and a broken snippet failing at its
// Markdown line where the fixed one passes. Run by `pnpm check:snippets`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkSnippets, extractSnippets, MARKER } from './check-snippets.mjs';

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
