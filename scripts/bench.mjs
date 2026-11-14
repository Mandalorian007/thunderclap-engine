#!/usr/bin/env node
// `pnpm bench`: runs harness/bench.html (`?rung=all`) in headless Chromium at the matrix's
// `desktop-1280` size, prints the ladder as a Markdown table and rewrites docs/BENCH.md (all but its counted-work section).
//
// Non-interactive. Exits non-zero when WebGPU does not come up, a rung throws, the page logs an
// error or the GPU reports errors (`gpuDiagnostics.errorCount`). No dependency beyond Playwright
// (the installed Chromium; nothing is downloaded).
//
// Options: `--frames N` overrides every rung's frame count, `--rung <id,id|tiny>` runs part of
// the ladder (BENCH.md is then not written), `--out <path>` writes elsewhere, `--no-write`
// prints only. `E2E_PORT_OFFSET` moves the Vite port like the e2e ports do; the bench serves
// on 4179 + offset, so it never meets a running `pnpm test:e2e` of the same checkout.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const frames = Number(opt('--frames')) || 0;
const rung = opt('--rung') ?? 'all';
const out = opt('--out') ?? join(root, 'docs', 'BENCH.md');
const write = !args.includes('--no-write') && rung === 'all' && frames === 0;
/** The whole ladder at 140 frames a rung takes well under a minute on a desktop GPU. */
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS) || 10 * 60_000;

// Same per-checkout offset as e2e/ports.ts (which is TypeScript, so it is repeated here).
function portOffset() {
  const env = process.env.E2E_PORT_OFFSET;
  if (env !== undefined && env !== '') return Number(env);
  const cwd = root;
  const marker = '/.claude/worktrees/';
  const i = cwd.indexOf(marker);
  if (i < 0) return 0;
  const name = cwd.slice(i + marker.length).split('/')[0];
  const n = createHash('sha1')
    .update(`${cwd.slice(0, i)}${marker}${name}`)
    .digest()
    .readUInt16BE(0);
  return 10 + (n % 90) * 10;
}
const PORT = 4179 + portOffset();
const URL_BASE = `http://127.0.0.1:${PORT}/`;

// Same WebGPU flags as playwright.config.ts.
function webgpuArgs() {
  const override = process.env.E2E_CHROMIUM_ARGS;
  if (override) return override.split(/\s+/).filter(Boolean);
  const base = ['--enable-unsafe-webgpu'];
  if (process.platform === 'darwin') return [...base, '--use-angle=metal'];
  if (process.platform === 'linux') {
    return [
      ...base,
      '--use-angle=swiftshader',
      '--enable-features=Vulkan',
      '--use-webgpu-adapter=swiftshader',
    ];
  }
  return base;
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    checkServer();
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`bench: ${url} did not come up in ${ms} ms`);
}

/** Vite is spawned directly (not through `pnpm exec`) so `kill()` reaches it. */
let serverExit = null;
function startServer() {
  const vite = join(
    dirname(fileURLToPath(import.meta.resolve('vite/package.json'))),
    'bin',
    'vite.js',
  );
  const child = spawn(
    process.execPath,
    [
      vite,
      '--config',
      'vite.harness.config.ts',
      '--port',
      String(PORT),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  child.on('exit', (code) => {
    serverExit = code ?? 0;
  });
  return child;
}

/** Throws once the server has gone away (a port in use, a crash): nothing to wait for then. */
function checkServer() {
  if (serverExit !== null) throw new Error(`bench: the Vite server exited (code ${serverExit})`);
}

const ms = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(2));
const num = (x) => x.toLocaleString('en-US');

function table(results) {
  const head = [
    'Rung',
    'Count',
    'Frames',
    'CPU ms',
    'GPU ms',
    'Instances',
    'Culled',
    'Shadow draws',
    'Draw calls',
  ];
  const rows = results.map((r) => [
    `\`${r.id}\``,
    num(r.count),
    String(r.frames),
    ms(r.cpuMs),
    ms(r.gpuMs),
    num(r.instances),
    num(r.culled),
    num(r.shadowDraws),
    num(r.drawCalls),
  ]);
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map((_h, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function adapterLine(a) {
  const parts = [a.vendor, a.architecture, a.device, a.description].filter(Boolean);
  return parts.length ? parts.join(', ') : 'adapter info withheld by the browser';
}

function renderDoc(state, date) {
  const gpuNote = state.timestamps
    ? '`GPU ms` is the median `GpuTimer.totalMs` (first to last timestamp of a sampled frame) over the samples that resolved during the measured frames.'
    : '`GPU ms` is `n/a`: the device has no `timestamp-query`, so `renderer.gpuTimer` is null.';
  return `# Bench

Numbers from \`harness/bench.html\`, written by \`pnpm bench\` (\`scripts/bench.mjs\`). Each rung is a fixed scene held for ${state.results[0]?.frames ?? 0} measured frames after a 20-frame warm-up; \`CPU ms\` is the median of \`performance.now()\` around the render callback (\`beginFrame\` to \`endFrame\`). ${gpuNote} \`Count\` is what the rung submits (instances, sprites or live particles); \`Instances\`, \`Culled\` and \`Draw calls\` are \`renderer.stats\` on the rung's last frame (a particle system is a drawable, so it counts 0 there); \`Shadow draws\` is the instances the sun's shadow pass drew (0 without a shadow). Numbers are what this run measured on a shared machine, not the engine's ceiling: other work on the same GPU and CPU moves them, so compare rungs within a run before comparing runs.

- Date: ${date}
- Machine: headless Chromium at 1280×720 (the e2e \`desktop-1280\` row), shared with other processes while this ran.
- Browser: ${state.userAgent}
- Adapter: ${adapterLine(state.adapter)}
- Timestamps: ${state.timestamps ? 'yes (`timestamp-query`)' : 'no'}

${table(state.results)}

## Rungs

- \`instances-*\`: that many cubes (one \`Mesh\`, one lit \`Material\`, one \`Transform\` each) in a 120×14×120 field the camera looks into from one side; \`-cull\` has \`camera.cull\` on, so the cubes outside the frustum are dropped before sorting (\`Culled\`), the other has it off and draws them all.
- \`batch-*\`: the same cubes as one \`frame.meshes\` batch (matrices and params in typed arrays built once, no batch bounds, so \`-cull\` culls per instance over the array); \`list-*\`: the same cubes in one retained \`InstanceList\` (\`frame.list\`), filled when the rung starts and unchanged after, so the frame uploads nothing (\`camera.cull\` off, like the plain \`instances-*\` and \`batch-*\` rungs; a list is culled as one sphere either way).
- \`lights-N\`: 10k culled cubes under a sun and N point lights (\`Lights.points\`).
- \`shadow-on|off\`: 10k culled cubes with \`lights.sun.shadow\` set (2048² map, extent 40) or not.
- \`sprites-N\`: N 24 px sprites through \`frame.sprite\` under the \`ortho2d\` camera (the 2D path).
- \`particles-N\`: a world-space \`ParticleSystem\` of capacity N, every particle alive, hovering in front of the camera.

Rerun with \`pnpm bench\`; \`pnpm bench --rung instances-10k-cull,shadow-on\` prints part of the ladder without writing this file.
`;
}

async function main() {
  const server = startServer();
  let browser = null;
  const errors = [];
  try {
    await waitFor(URL_BASE, 60_000);
    browser = await chromium.launch({ args: webgpuArgs() });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const query = `?rung=${encodeURIComponent(rung)}${frames > 0 ? `&frames=${frames}` : ''}`;
    await page.goto(`${URL_BASE}bench.html${query}`);
    const read = () =>
      page.evaluate(() => {
        const s = window.__harnessBench?.state;
        return s ? JSON.parse(JSON.stringify(s)) : null;
      });
    const until = Date.now() + TIMEOUT_MS;
    let state = null;
    let lastShown = '';
    while (Date.now() < until) {
      checkServer();
      state = await read();
      if (state?.ready && state.gpu !== 'ok') throw new Error(`bench: WebGPU: ${state.gpu}`);
      if (state?.current && state.current !== lastShown) {
        lastShown = state.current;
        process.stderr.write(`bench: ${state.current}\n`);
      }
      if (state?.done) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!state?.done) throw new Error(`bench: not done after ${TIMEOUT_MS} ms`);
    if (state.error) throw new Error(`bench: rung threw: ${state.error}`);
    if (state.gpuErrors > 0) throw new Error(`bench: ${state.gpuErrors} GPU error(s) reported`);
    if (errors.length > 0) throw new Error(`bench: page errors:\n${errors.join('\n')}`);

    console.log(table(state.results));
    console.log(`\nadapter: ${adapterLine(state.adapter)}; timestamps: ${state.timestamps}`);
    if (write) {
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // Keep the reference scenes (E-041 A4) and the counted-work section
      // (src/render/baseline.budget.test.ts writes it, ws/budget): everything from the first.
      const prev = existsSync(out) ? readFileSync(out, 'utf8') : '';
      const ref = prev.indexOf('\n## Reference scenes\n');
      const at = ref >= 0 ? ref : prev.indexOf('\n## Counted work, 1.3 baseline\n');
      writeFileSync(out, renderDoc(state, date) + (at < 0 ? '' : prev.slice(at)));
      console.log(`wrote ${relative(root, out)}`);
    }
  } finally {
    await browser?.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
