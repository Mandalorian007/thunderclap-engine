/**
 * The actors page (harness/actors.html, ws/actors): a crowd of rigid and skinned actors in one
 * pose pass and one bundle of indirect draws. A frame costs the same GPU calls at 100 and at
 * 1,000 actors, the bundle is recorded once, the GPU's skin matrices match `poseCpu`, the pose
 * pass draws actors at both LODs, and the device reports no error. ws/actor-fit: empty models
 * draw nothing, a pose hook matches its CPU twin, and a shared set draws a shadow per actor.
 * ws/actor-post-fit: the crowd fit (an async pipeline, a game table, two `'actor'` sets of
 * their own vertex counts, per-model LODs, an LOD scale, a vertex cap, cull radii, the pose
 * pass timed) compiles and draws, its counts agree, and a cap and a scale move actors to LOD 1.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessActorsState } from '../harness/actors-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<HarnessActorsState> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `actors.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${url}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`actors page: ${s.gpu}`);
      return s?.ready && (!s.crowd || s.pipelineReady) ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(10);
  // Ask for a readback and wait for it, in one evaluate per poll.
  const checks = await frame.evaluate(() => {
    const h = window.__harnessActors!;
    h.check();
    return h.state.checks;
  });
  await expect.poll(async () => (await read()).checks).toBeGreaterThan(checks);
  return read();
}

function read(): Promise<HarnessActorsState> {
  return frame.evaluate(() => {
    const s = window.__harnessActors?.state;
    if (!s) throw new Error('window.__harnessActors missing');
    return JSON.parse(JSON.stringify(s)) as HarnessActorsState;
  });
}

test('a crowd costs the same GPU calls at 100 and 1,000 actors, posed as the CPU poses it', async ({
  page,
  wrapper,
}) => {
  const small = await open(page, wrapper, 'n=100');
  const large = await open(page, wrapper, 'n=1000');
  for (const s of [small, large]) {
    expect(s.gpuErrors).toBe(0);
    expect(s.bundles).toBe(1);
    expect(s.dispatched).toBe(s.actors);
    // The GPU pose of rigid and skinned slots matches the CPU mirror.
    expect(s.checkedSlots).toBe(16);
    expect(s.poseError).toBeGreaterThanOrEqual(0);
    expect(s.poseError).toBeLessThan(2e-3);
    expect(s.drawn).toBeGreaterThan(0);
    expect(s.drawn).toBeLessThanOrEqual(s.actors);
  }
  expect(small.actors).toBe(100);
  expect(large.actors).toBe(1000);
  expect(large.calls).toBe(small.calls);
  expect(large.maxCalls).toBe(small.maxCalls);
  // Near robots draw at LOD 0, the far rows at LOD 1, and skinned figures too.
  const [near, far, skinned] = large.drawnPerDraw;
  expect(near).toBeGreaterThan(0);
  expect(far).toBeGreaterThan(0);
  expect(skinned).toBeGreaterThan(0);
  // One target: the bundle is recorded once, however the actors move.
  expect(large.bundleBuilds).toBe(1);
  expect(errors).toEqual([]);
});

/** Open `query` and, with timestamps, wait for 150 GPU samples. */
async function timed(page: Page, wrapper: string, query: string): Promise<HarnessActorsState> {
  const s = await open(page, wrapper, query);
  if (!s.timestamps) return s;
  await expect
    .poll(async () => (await read()).gpuSamples, { timeout: 30_000 })
    .toBeGreaterThan(150);
  return read();
}

test('models no actor shows draw nothing: their empty indirect draws are left out', async ({
  page,
  wrapper,
}) => {
  test.skip(wrapper !== 'top', 'timing on the top page only');
  const bare = await timed(page, wrapper, 'n=16&models=0&timing=1');
  const many = await timed(page, wrapper, 'n=16&models=120&timing=1');
  expect(many.emptyModels).toBe(120);
  for (const s of [bare, many]) {
    expect(s.gpuErrors).toBe(0);
    expect(s.drawn).toBeGreaterThan(0);
  }
  if (many.timestamps) {
    console.log(
      `[actors] 16 actors: GPU ${bare.gpuMs.toFixed(3)} ms with 2 models, ${many.gpuMs.toFixed(3)} ms with 122 (244 mesh draws)`,
    );
    expect(many.gpuMs).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

test('a pose hook nods the heads as poseCpu does, and a shared set lays a shadow under each actor', async ({
  page,
  wrapper,
}) => {
  const s = await open(page, wrapper, 'n=200&fit=1');
  expect(s.fit).toBe(true);
  expect(s.gpuErrors).toBe(0);
  // The hook runs in the pose pass and in its CPU twin alike.
  expect(s.checkedSlots).toBe(16);
  expect(s.poseError).toBeGreaterThanOrEqual(0);
  expect(s.poseError).toBeLessThan(2e-3);
  // One shadow quad per actor drawn, counted by the same pose pass; the bodies and the shadows
  // are two bundles.
  expect(s.drawn).toBeGreaterThan(0);
  expect(s.shadows).toBe(s.drawn);
  expect(s.bundles).toBe(2);
  expect(errors).toEqual([]);
});

test('the crowd fit: async pipeline, game table, two set sizes, per-model LODs, cap and scale', async ({
  page,
  wrapper,
}) => {
  const s = await open(page, wrapper, 'n=1000&crowd=1');
  expect(s.crowd).toBe(true);
  expect(s.pipelineReady).toBe(true);
  expect(s.gpuErrors).toBe(0);
  // The nod's amplitude comes from the table: still the CPU twin's pose.
  expect(s.checkedSlots).toBe(16);
  expect(s.poseError).toBeGreaterThanOrEqual(0);
  expect(s.poseError).toBeLessThan(2e-3);
  // Each set counts its own vertices per actor drawn: one shadow and one marker each.
  expect(s.drawn).toBeGreaterThan(0);
  expect(s.shadows).toBe(s.drawn);
  expect(s.markers).toBe(s.drawn);
  // One record changes a frame: one upload.
  expect(s.recordWrites).toBe(1);
  const [near, far] = s.drawnPerDraw;
  expect(near).toBeGreaterThan(0);
  expect(far).toBeGreaterThan(0);
  // A tight vertex cap moves robots from LOD 0 to LOD 1 (the figures have one mesh) and the
  // actors drawn stay drawn; (the actors walk, so a few cross the view's edge between loads).
  const capped = await open(page, wrapper, 'n=1000&crowd=1&cap=4000');
  expect(capped.gpuErrors).toBe(0);
  expect(capped.drawnPerDraw[0]!).toBeLessThan(near!);
  expect(Math.abs(capped.drawn - s.drawn)).toBeLessThan(s.drawn * 0.05 + 4);
  // A small LOD scale brings every distance in: fewer near robots, and the farthest culled.
  const scaled = await open(page, wrapper, 'n=1000&crowd=1&scale=0.25');
  expect(scaled.gpuErrors).toBe(0);
  expect(scaled.drawnPerDraw[0]!).toBeLessThan(near!);
  expect(scaled.drawn).toBeGreaterThan(0);
  expect(scaled.drawn).toBeLessThan(s.drawn * 0.5);
  if (s.timestamps && wrapper === 'top') {
    await expect.poll(async () => (await read()).poseMs, { timeout: 30_000 }).toBeGreaterThan(0);
    console.log(
      `[actors] crowd fit, 1,000 actors: pose pass ${(await read()).poseMs.toFixed(3)} ms`,
    );
  }
  expect(errors).toEqual([]);
});

test('a churning crowd reads back within 0.01 of its CPU twin (ws/pose-parity-fix)', async ({
  page,
  wrapper,
}) => {
  // 32 actors in slots 13 apart, every record rewritten every frame, two LODs, spawns and
  // despawns: `readBack` poses the CPU twin at the call, so frames run while the copy maps
  // cannot move it (EV FX5: `poseCpu` after the map drifted by a frame's motion, 0.141).
  await open(page, wrapper, 'n=32&parity=1');
  let near = 0;
  let far = 0;
  let worst = 0;
  for (let round = 0; round < 4; round++) {
    const before = await frame.evaluate(() => {
      const h = window.__harnessActors!;
      h.parityCheck();
      return h.state.parity!.checks;
    });
    await expect.poll(async () => (await read()).parity!.checks).toBeGreaterThan(before);
    const s = await read();
    const p = s.parity!;
    expect(s.gpu).toBe('ok');
    expect(p.posed).toBe(p.live);
    expect(p.live).toBeGreaterThanOrEqual(24);
    expect(p.error).toBeGreaterThanOrEqual(0);
    expect(p.error, `worst slot ${p.worstSlot}`).toBeLessThan(0.01);
    near += p.near;
    far += p.far;
    worst = Math.max(worst, p.error);
    console.log(
      `[actors] parity: ${p.posed} posed, worst ${p.error.toFixed(6)} (slot ${p.worstSlot}), LOD 0 ${p.near}, LOD 1 ${p.far}, poseCpu after the map ${p.naiveError.toFixed(4)}`,
    );
    // Sparse: every live slot changed, in runs too far apart to merge.
    expect(s.recordWrites).toBeGreaterThan(1);
  }
  expect(near).toBeGreaterThan(0);
  expect(far).toBeGreaterThan(0);
  expect(worst).toBeLessThan(0.01);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
