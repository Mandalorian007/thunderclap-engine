/**
 * The reference scenes' bookkeeping (E-041 A4): what keeps the six scenes, their pages, their
 * rungs and docs/BENCH.md ("Reference scenes") one thing.
 *
 * - harness/ref-scenes.ts (the pages) and src/render/ref-scenes.test-util.ts (the budget tests)
 *   carry the same scene code below their shared marker (the src tree cannot import the harness).
 * - harness/bench-state.ts's `REF_RUNGS` names a rung for every row the budget tests keep.
 * - The "Reference scenes" section of docs/BENCH.md, up to its `### Timings`, is rendered from the
 *   six `ref-*.budget.json`; `TC_REF=write` writes it again (before "Counted work, 1.3 baseline").
 *   The timings under it are e2e/ref-scenes.spec.ts's (`TC_REF_TIMES=<file>`), kept by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd, env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { REF_KEYS, type RefBudget, type RefRow } from './ref-budget.test-util';

const root = cwd();
const REF_WRITE = env.TC_REF === 'write';
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const MARKER =
  '// ---- shared: identical in harness/ref-scenes.ts and src/render/ref-scenes.test-util.ts ----';
const SECTION = '## Reference scenes';
const TIMINGS = '### Timings';
const BASELINE = '## Counted work, 1.3 baseline';
const DOC = 'docs/BENCH.md';

/** The kept JSONs in scene order (S1–S6). */
const BOOKS = [
  'src/render/ref-board.budget.json',
  'src/anim/ref-characters.budget.json',
  'src/render/ref-arena.budget.json',
  'src/voxel/ref-voxel.budget.json',
  'src/render/ref-stereo.budget.json',
  'src/ui/ref-hud.budget.json',
];
/** Each kept row's rung in `REF_RUNGS` (a row without one is the mono comparison of S5). */
const RUNG_OF: Record<string, string | null> = {
  'ref-board': 'ref-board',
  'ref-characters-64': 'ref-characters',
  'ref-characters-256': 'ref-characters-256',
  'ref-arena': 'ref-arena',
  'ref-voxel-8': 'ref-voxel',
  'ref-voxel-16': 'ref-voxel-16',
  'ref-stereo': 'ref-stereo',
  'ref-stereo-mono': null,
  'ref-hud': 'ref-hud',
};

const n = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
const books = (): RefBudget[] => BOOKS.map((b) => JSON.parse(read(b)) as RefBudget);

function section(bs: RefBudget[]): string {
  const head = [
    'Row',
    'Commands',
    'Draws',
    'Pipelines',
    'Bind groups',
    'Passes',
    'Submits',
    'Writes',
    'Bytes written',
    'Creates',
    'Typed arrays',
    'Clock reads',
  ];
  const cells = (name: string, r: RefRow) => [
    name,
    n(r.commands),
    n(r.draw + r.drawIndexed),
    n(r.setPipeline),
    n(r.setBindGroup),
    n(r.beginRenderPass + r.beginComputePass),
    n(r.submit),
    n(r.writeBuffer + r.writeTexture),
    n(r.writeBufferBytes),
    n(r.createBuffer + r.createTexture + r.createBindGroup + r.createOther),
    n(r.typedArrays + r.arrayBuffers),
    n(r.clockReads),
  ];
  const rows: string[][] = [];
  const stats: string[] = [];
  const notes: string[] = [];
  for (const b of bs) {
    for (const [name, r] of Object.entries(b.rows)) {
      rows.push(cells(`\`${name}\``, r));
      for (const [part, p] of Object.entries(b.parts[name] ?? {}))
        rows.push(cells(`↳ \`${part}\``, p));
    }
    for (const [name, s] of Object.entries(b.stats))
      stats.push(
        `| \`${name}\` | ${[s.drawCalls, s.triangles, s.instances, s.culled, s.shadowDraws, s.passes].map(n).join(' | ')} |`,
      );
    for (const [name, v] of Object.entries(b.notes)) notes.push(`- ${name}: ${n(v)}`);
  }
  const table = [
    `| ${head.join(' | ')} |`,
    `| ${head.map((_h, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
  return `${SECTION}

Six scenes every engine change is measured on (E-041 A4): \`harness/ref-<scene>.html\` in a browser, the same code counted on the fake device by \`src/<module>/ref-<scene>.budget.test.ts\`. Each is deterministic: a fixed seed, frame \`i\` at \`i / 60\` s, a fixed camera path, procedural art only, a 1920×1080 logical view on a 1280×720 backbuffer.

- \`ref-board\` (S1, 2D): a 48×27 tile layer, a flipbook walker and 4,000 sprites drifting on circles under the \`ortho2d\` camera.
- \`ref-characters\` (S2): 64 (and 256) seven-joint figures, each its own \`AnimationMixer\` on a walk clip, skinned through one \`SkinPalette\`, under a sun shadow; the camera orbits.
- \`ref-arena\` (S3): standard-material spheres and pillars on a floor, a sun shadow, 8 moving point lights and 2 spots, bloom and vignette (\`PostStack\`).
- \`ref-voxel\` (S4): an 8×2×8 (and 16×2×16) chunk world of 16³ chunks, meshed before frame 0 (in a Worker on the page), flown over.
- \`ref-stereo\` (S5): S2's figures (32) seen by two eyes a frame (\`viewIndex\` 0 and 1, half the target each); \`ref-stereo-mono\` is the same frame through one view.
- \`ref-hud\` (S6): an idle overlay (reticle, two meters, six slots, a heading) over a still scene; every frame sets the widgets to the values they hold.

Counted per frame (40 measured after 10 warm-up), as in "Counted work, 1.3 baseline" below; a row must stay at or under these, counter by counter. \`↳\` rows split the frame by \`meter.view\`: \`update\` is the scene's own work (animation, skinning), \`view\`/\`left\`/\`right\` a \`renderer.render\`, \`hud\` the overlay's \`set\` calls, \`present\` \`endFrame\`. Written by \`TC_REF=write pnpm vitest run /ref-\`; this part of the section is checked against the JSONs by \`src/render/ref-scenes.budget.test.ts\`.

${table}

\`renderer.stats\` at frame 30, pinned exactly; e2e/ref-scenes.spec.ts checks each page draws the same:

| Row | Draw calls | Triangles | Instances | Culled | Shadow draws | Views |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${stats.join('\n')}

Other pinned numbers:

${notes.join('\n')}
`;
}

describe('reference scenes', () => {
  it('harness and src carry the same scene code', () => {
    const page = read('harness/ref-scenes.ts');
    const util = read('src/render/ref-scenes.test-util.ts');
    expect(page.indexOf(MARKER)).toBeGreaterThan(0);
    expect(util.indexOf(MARKER)).toBeGreaterThan(0);
    expect(util.slice(util.indexOf(MARKER))).toBe(page.slice(page.indexOf(MARKER)));
  });

  it('REF_RUNGS has a rung for every kept row', () => {
    const src = read('harness/bench-state.ts');
    const list = src.slice(src.indexOf('REF_RUNGS'));
    const ids = [...list.slice(0, list.indexOf('];')).matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
    const rows = books().flatMap((b) => Object.keys(b.rows));
    expect(rows.sort()).toEqual(Object.keys(RUNG_OF).sort());
    for (const row of rows) if (RUNG_OF[row]) expect(ids, row).toContain(RUNG_OF[row]);
    for (const k of REF_KEYS)
      for (const b of books())
        for (const r of Object.values(b.rows)) expect(r[k]).toBeTypeOf('number');
  });

  it('docs/BENCH.md carries the counted budgets', () => {
    const doc = read(DOC);
    const want = section(books());
    const at = doc.indexOf(`\n${SECTION}\n`);
    if (REF_WRITE) {
      const end = at < 0 ? -1 : doc.indexOf(`\n${TIMINGS}\n`, at);
      const base = doc.indexOf(`\n${BASELINE}\n`);
      const out =
        at >= 0 && end >= 0
          ? `${doc.slice(0, at + 1)}${want}${doc.slice(end)}`
          : `${doc.slice(0, base + 1)}${want}\n${TIMINGS}\n\n(none yet)\n\n${doc.slice(base + 1)}`;
      writeFileSync(join(root, DOC), out);
      return;
    }
    expect(at, `${DOC} has no "${SECTION}"; run with TC_REF=write`).toBeGreaterThan(0);
    const end = doc.indexOf(`\n${TIMINGS}\n`, at);
    expect(end, `${DOC}: "${SECTION}" has no "${TIMINGS}"`).toBeGreaterThan(at);
    expect(doc.slice(at + 1, end)).toBe(want);
  });
});
