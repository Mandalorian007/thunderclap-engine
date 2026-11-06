#!/usr/bin/env node
// Snapshot gate (ws/snap-gate, E-008): "2D harness pixel-identical" as a command.
//
//   pnpm snap            re-capture the goldens: e2e/golden/<page>.png, one per 2D harness page,
//                        on the desktop-1280 row at a fixed frame (`--update` under the hood)
//   pnpm snap:check      capture again and compare against the goldens; exit 1 on any pixel
//                        outside the E-008 tolerance, diff PNGs under screens/diff/
//
// Both run e2e/golden.spec.ts through Playwright on the desktop-1280 project only; the spec also
// runs inside `pnpm test:e2e`, in check mode. The PNG codec is the one Playwright bundles
// (pngjs, inside playwright-core's utilsBundle): the engine gains no dependency. Node built-ins
// otherwise.
//
//   node scripts/snap.mjs compare <expected.png> <actual.png> [diff.png]
//                        compare two PNGs offline (same output and exit codes as snap:check)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E-008: exact at rotation 0, at most 1/255 per channel otherwise (float-precision noise on
 * rotated sprites). A pixel whose largest channel delta exceeds this fails the page.
 */
export const TOLERANCE = 1;

/** @typedef {{ width: number, height: number, data: Buffer }} Png */

/** pngjs's `PNG` class, resolved through @playwright/test → playwright → playwright-core. */
function pngCodec() {
  const fromHere = createRequire(import.meta.url);
  const fromTest = createRequire(fromHere.resolve('@playwright/test/package.json'));
  const fromPlaywright = createRequire(fromTest.resolve('playwright/package.json'));
  return fromPlaywright('playwright-core/lib/utilsBundle').PNG;
}

/** @param {Buffer} bytes @returns {Png} */
export function decodePng(bytes) {
  const PNG = pngCodec();
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

/** @param {Png} png @returns {Buffer} */
export function encodePng(png) {
  const PNG = pngCodec();
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  return PNG.sync.write(out);
}

/**
 * @typedef {object} CompareResult
 * @property {boolean} pass  Same size and no pixel beyond `tolerance`.
 * @property {boolean} sizeMismatch
 * @property {number} maxDelta  Largest per-channel difference (0..255) over the image.
 * @property {number} differing  Pixels with any channel difference.
 * @property {number} beyond  Pixels with a channel difference above `tolerance`.
 * @property {number} total  Pixels compared.
 * @property {Png | null} diff  Diff image: red beyond tolerance, yellow within it, the actual
 *   image dimmed elsewhere. `null` on a size mismatch.
 */

/**
 * Compare two decoded PNGs channel by channel (RGBA).
 * @param {Png} expected @param {Png} actual @param {number} [tolerance]
 * @returns {CompareResult}
 */
export function comparePng(expected, actual, tolerance = TOLERANCE) {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      pass: false,
      sizeMismatch: true,
      maxDelta: 255,
      differing: 0,
      beyond: 0,
      total: 0,
      diff: null,
    };
  }
  const { width, height } = expected;
  const total = width * height;
  const diff = Buffer.alloc(total * 4);
  let maxDelta = 0;
  let differing = 0;
  let beyond = 0;
  const a = expected.data;
  const b = actual.data;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const dc = Math.abs(a[o + c] - b[o + c]);
      if (dc > d) d = dc;
    }
    if (d > maxDelta) maxDelta = d;
    if (d > 0) differing++;
    if (d > tolerance) {
      beyond++;
      diff[o] = 255;
      diff[o + 1] = 0;
      diff[o + 2] = 0;
    } else if (d > 0) {
      diff[o] = 255;
      diff[o + 1] = 220;
      diff[o + 2] = 0;
    } else {
      diff[o] = b[o] >> 2;
      diff[o + 1] = b[o + 1] >> 2;
      diff[o + 2] = b[o + 2] >> 2;
    }
    diff[o + 3] = 255;
  }
  return {
    pass: beyond === 0,
    sizeMismatch: false,
    maxDelta,
    differing,
    beyond,
    total,
    diff: { width, height, data: diff },
  };
}

/** One line per page, the same in the spec and on the command line. */
export function describeCompare(name, r) {
  if (r.sizeMismatch) return `golden ${name}: size mismatch`;
  return `golden ${name}: max channel delta ${r.maxDelta}, ${r.differing}/${r.total} pixels differ, ${r.beyond} beyond tolerance ${TOLERANCE}`;
}

/** Compare two PNG files; writes `diffPath` when they differ. Returns the result. */
export function compareFiles(expectedPath, actualPath, diffPath, tolerance = TOLERANCE) {
  const r = comparePng(
    decodePng(readFileSync(expectedPath)),
    decodePng(readFileSync(actualPath)),
    tolerance,
  );
  if (diffPath && r.diff && r.differing > 0) {
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, encodePng(r.diff));
  }
  return r;
}

function usage() {
  console.error(
    'usage: node scripts/snap.mjs [--update] [--project <name>]\n' +
      '       node scripts/snap.mjs compare <expected.png> <actual.png> [diff.png]',
  );
  process.exit(2);
}

function main(argv) {
  if (argv[0] === 'compare') {
    const [, expected, actual, diff] = argv;
    if (!expected || !actual) usage();
    if (!existsSync(expected) || !existsSync(actual)) {
      console.error('snap compare: file not found');
      process.exit(2);
    }
    const r = compareFiles(expected, actual, diff);
    console.log(describeCompare(actual, r));
    process.exit(r.pass ? 0 : 1);
  }
  let update = false;
  let project = 'desktop-1280';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') update = true;
    else if (a === '--project') project = argv[++i] ?? usage();
    else usage();
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const res = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', 'e2e/golden.spec.ts', '--project', project],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...(update ? { SNAP_UPDATE: '1' } : {}) },
    },
  );
  process.exit(res.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
