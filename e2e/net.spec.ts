/**
 * Networking (`@thunderclap-engine/engine/net`) on every top-level matrix row, against
 * harness/net.html (no WebGPU): two clients and an in-page authority over `inPageHub`. Handshake
 * with the schema hash, prediction that agrees with the authority, the other player drawn through
 * the snapshot buffer, a live query both clients agree on, under latency, jitter and loss, a dropped
 * link that both clients recover from, and a command round trip.
 *
 * The itch-iframe row is skipped: the wrapper embeds the WebGPU harness page, and the protocol
 * does not depend on the frame.
 */
import type { Page } from '@playwright/test';
import type { HarnessNetState } from '../harness/net-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'net harness runs top-level only');
  await page.goto(`${HARNESS_URL}net.html`);
  await expect.poll(() => read(page).then((s) => s.ready), { timeout: 10_000 }).toBe(true);
});

function read(page: Page): Promise<HarnessNetState> {
  return page.evaluate(() => {
    const s = window.__harnessNet?.state;
    if (!s) throw new Error('window.__harnessNet missing');
    return JSON.parse(JSON.stringify(s)) as HarnessNetState;
  });
}

const call = <A extends unknown[]>(page: Page, fn: string, ...args: A) =>
  page.evaluate(
    ([f, a]) =>
      (window.__harnessNet as unknown as Record<string, (...x: unknown[]) => unknown>)[
        f as string
      ]!(...(a as unknown[])),
    [fn, args] as const,
  );

test('handshake: both clients welcomed with the same schema, each sees the other', async ({
  page,
}) => {
  const s = await read(page);
  expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
  expect(s.a.status).toBe('open');
  expect(s.b.status).toBe('open');
  expect(new Set([s.a.player, s.b.player])).toEqual(new Set([1, 2]));
  await expect.poll(() => read(page).then((r) => [r.a.others, r.b.others])).toEqual([1, 1]);
  await expect.poll(() => read(page).then((r) => r.frames)).toBeGreaterThan(2);
});

test('prediction agrees with the authority; the other player converges through snapshots', async ({
  page,
}) => {
  await call(page, 'auto', false);
  await call(page, 'setLink', { latencyMs: 80, jitterMs: 20, loss: 0 });
  await call(page, 'hold', 'a', 1, 0);
  await page.waitForTimeout(800);
  await call(page, 'hold', 'a', 0, 0);
  // Settled: a's prediction is the authority's, and b draws a where the authority has it.
  await expect
    .poll(async () => {
      const r = await read(page);
      return r.a.pending === 0 && r.a.x === r.server.a.x && r.a.y === r.server.a.y;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const r = await read(page);
      return Math.hypot(r.b.otherX - r.server.a.x, r.b.otherY - r.server.a.y);
    })
    .toBeLessThan(0.5);
  const s = await read(page);
  expect(s.server.a.x).toBeGreaterThan(40);
  expect(s.a.corrections).toBe(0);
  expect(s.b.delayMs).toBeGreaterThanOrEqual(100);
});

test('under latency, jitter and loss the score is shared and nothing mispredicts', async ({
  page,
}) => {
  await call(page, 'setLink', { latencyMs: 120, jitterMs: 40, loss: 0.05 });
  await call(page, 'auto', true);
  await expect.poll(() => read(page).then((r) => r.score), { timeout: 15_000 }).toBeGreaterThan(1);
  await call(page, 'auto', false);
  await expect
    .poll(async () => {
      const r = await read(page);
      return r.a.score === r.score && r.b.score === r.score;
    })
    .toBe(true);
  const s = await read(page);
  expect(s.a.corrections + s.b.corrections).toBe(0);
  expect(s.a.clock).toBeGreaterThan(0);
});

test('a dropped link: both reconnect, resume the query and reset their prediction', async ({
  page,
}) => {
  await call(page, 'auto', false);
  await call(page, 'setLink', { latencyMs: 30, jitterMs: 0, loss: 0 });
  await call(page, 'hold', 'b', 0, 1);
  await page.waitForTimeout(300);
  await call(page, 'drop');
  await expect
    .poll(async () => {
      const r = await read(page);
      return (
        r.a.welcomes >= 2 && r.b.welcomes >= 2 && r.a.status === 'open' && r.b.status === 'open'
      );
    })
    .toBe(true);
  await call(page, 'hold', 'b', 0, 0);
  await expect
    .poll(async () => {
      const r = await read(page);
      return r.b.pending === 0 && r.b.x === r.server.b.x && r.b.y === r.server.b.y;
    })
    .toBe(true);
  const s = await read(page);
  expect(s.a.player).not.toBe(0);
  expect(s.a.score).toBe(s.score);
  expect(s.b.score).toBe(s.score);
  expect(s.b.resets).toBeGreaterThanOrEqual(2);
  await expect.poll(() => read(page).then((r) => [r.a.others, r.b.others])).toEqual([1, 1]);
});

test('a command round trip resets the shared score for both clients', async ({ page }) => {
  await call(page, 'auto', false);
  await call(page, 'setLink', { latencyMs: 60, jitterMs: 10, loss: 0 });
  expect(await call(page, 'reset')).toBe(0);
  await expect
    .poll(async () => {
      const r = await read(page);
      return [r.a.score, r.b.score];
    })
    .toEqual([0, 0]);
});
