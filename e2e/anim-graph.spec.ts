/**
 * The animation graph demo (harness/anim-graph.html) on every matrix row: a three-joint figure
 * driven by `createAnimGraph` over a 1D `speed` blend space plus a `jump` state.
 *
 * - the page boots WebGPU with no error and draws the figure (ground + three bones);
 * - the graph enters `jump` on the boolean parameter and returns to `move` at the exit time;
 * - with the page's own motion parked (E-017), at a blended speed the two nearest clips share
 *   the weight and the weights sum to 1 once the fade has settled.
 * Every assertion on a moving value polls.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessAnimGraphState } from '../harness/anim-graph-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}anim-graph.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('anim-graph.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`anim graph demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessAnimGraphState> {
  return frame.evaluate(() => {
    const s = window.__harnessAnimGraph?.state;
    if (!s) throw new Error('window.__harnessAnimGraph missing');
    return JSON.parse(JSON.stringify(s)) as HarnessAnimGraphState;
  });
}

function setAuto(on: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessAnimGraph?.setAuto(v), on);
}

function setSpeed(speed: number): Promise<void> {
  return frame.evaluate((v) => window.__harnessAnimGraph?.setSpeed(v), speed);
}

function jump(): Promise<void> {
  return frame.evaluate(() => window.__harnessAnimGraph?.jump());
}

test('boots the figure with no GPU error', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await expect.poll(async () => (await read()).instances).toBe(4);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(s.state).toMatch(/^(move|jump)$/);
  expect(errors).toEqual([]);
});

test('the graph enters jump on the parameter and comes back to move at the exit time', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await setAuto(false);
  await expect.poll(async () => (await read()).state).toBe('move');
  const before = await read();
  await jump();
  // The jump lasts well under a second; a loaded machine can miss it between two reads, so the
  // visit is proven by the enter counters (E-017), not by catching `state === 'jump'`.
  await expect.poll(async () => (await read()).jumps).toBe(before.jumps + 1);
  await expect.poll(async () => (await read()).returns).toBe(before.returns + 1);
  await expect.poll(async () => (await read()).state).toBe('move');
  // The fade back finishes: move takes the whole pose again.
  await expect.poll(async () => (await read()).jumpWeight).toBe(0);
  expect((await read()).jumps).toBe(before.jumps + 1);
  expect(errors).toEqual([]);
});

test('at a blended speed the two nearest clips share the weight and the weights sum to 1', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await setAuto(false);
  await setSpeed(0.25);
  await expect.poll(async () => (await read()).state).toBe('move');
  await expect
    .poll(async () => {
      const { weights, speed } = await read();
      if (speed !== 0.25) return 'speed not set';
      const sum = weights[0] + weights[1] + weights[2];
      if (Math.abs(sum - 1) > 1e-3) return `sum ${sum}`;
      if (Math.abs(weights[0] - 0.5) > 1e-3 || Math.abs(weights[1] - 0.5) > 1e-3)
        return `split ${weights.join(',')}`;
      if (weights[2] !== 0) return `run ${weights[2]}`;
      return 'ok';
    })
    .toBe('ok');
  // Phase sync: the blend space's phase advances.
  const p0 = (await read()).phase;
  await expect.poll(async () => (await read()).phase).not.toBe(p0);
  expect(errors).toEqual([]);
});
