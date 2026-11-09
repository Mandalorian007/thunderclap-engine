/**
 * Boot and crash hardening (ws/crash, E-040; Last Rune's tests/e2e/hardening.spec.ts is the
 * model), on the puzzle template, which opts in to the crash screen (`createGame({ crash: true })`):
 * - #5: a `getContext('webgpu')` that throws gives the unsupported screen, not a blank page.
 * - #6: a throw while `createGame` builds gives the crash card with Reload only; an uncaught
 *   error after boot gives it with Keep playing, which closes it and the game runs on.
 */
import { expect, type Page, test } from '@playwright/test';
import { templateUrl } from './ports';

const URL = templateUrl('puzzle');

/** Page errors and console errors, for asserting that only the expected ones happened. */
function trackProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

const frames = (page: Page) =>
  page.evaluate(() => (window as { __template?: { frames: number } }).__template?.frames ?? 0);

test.describe('crash and boot hardening', () => {
  test('a getContext that throws shows the unsupported screen (#5)', async ({ page }) => {
    await page.addInitScript(() => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        id: string,
        ...rest: unknown[]
      ) {
        if (id === 'webgpu') throw new Error('test: context creation crashed');
        // biome-ignore lint/suspicious/noExplicitAny: forwarding the overloads
        return (real as any).call(this, id, ...rest);
      } as typeof real;
    });
    const problems = trackProblems(page);
    await page.goto(URL);
    const card = page.locator('.engine-msg');
    await expect(card).toContainText('WebGPU is not available', { timeout: 20_000 });
    await expect(card).toContainText('test: context creation crashed');
    await expect(card).not.toContainText('Something went wrong');
    await expect(card).toHaveCount(1);
    await expect(page.locator('#app canvas')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('a throw inside createGame shows the crash card with Reload only (#6)', async ({ page }) => {
    await page.addInitScript(() => {
      // The renderer's first buffer: WebGPU is up, then the build throws.
      GPUDevice.prototype.createBuffer = () => {
        throw new Error('test: renderer crashed');
      };
    });
    const problems = trackProblems(page);
    await page.goto(URL);
    const card = page.locator('.engine-msg');
    await expect(card).toContainText('Something went wrong', { timeout: 20_000 });
    await expect(card).toContainText('while starting');
    await expect(card.getByRole('button')).toHaveText(['Reload']);
    await expect(card.getByRole('button', { name: 'Reload' })).toBeFocused();
    await expect(card).toHaveCount(1);
    // createGame still rejects (the template's top-level await): only that error reaches the page.
    expect(problems.every((p) => p.includes('test: renderer crashed'))).toBe(true);
  });

  test('an uncaught error after boot shows the card; Keep playing goes on (#6)', async ({
    page,
  }) => {
    const problems = trackProblems(page);
    await page.goto(URL);
    await expect.poll(() => frames(page), { timeout: 30_000 }).toBeGreaterThan(10);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('test fault');
      }, 0);
    });
    const card = page.locator('.engine-msg');
    await expect(card).toContainText('Something went wrong');
    await expect(card).toContainText('Your progress is saved');
    await expect(card.getByRole('button')).toHaveText(['Reload', 'Keep playing']);
    await card.getByRole('button', { name: 'Keep playing' }).click();
    await expect(card).toHaveCount(0);
    const after = await frames(page);
    await expect.poll(() => frames(page)).toBeGreaterThan(after + 5);
    expect(problems).toEqual(['pageerror: test fault']);
  });
});
