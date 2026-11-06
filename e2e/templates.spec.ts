/**
 * Template smoke (ws/template-sweep): every game under `templates/` boots on the device matrix.
 * Each template's `index.html` is served by its own Vite dev server (playwright.config.ts,
 * `TEMPLATE_PORTS`); the page sets `window.__template = { scene, frames, ...state }` in its
 * `main.ts`, updated after every rendered frame. The spec asserts a clean console for three
 * seconds, more than ten frames, and that one key press changes the scene or a state field.
 */
import { expect, type Page, test } from '@playwright/test';
import { type TemplateName, templateUrl } from './ports';

interface Probe {
  scene: string;
  frames: number;
  [field: string]: unknown;
}

interface TemplateCase {
  name: TemplateName;
  /** The scene the page starts on. */
  scene: string;
  /** `KeyboardEvent.code` pressed (held while polling). */
  key: string;
  /** The state field the key changes, or `'scene'` for the top scene's name. */
  field: 'scene' | string;
}

const CASES: TemplateCase[] = [
  // Enter activates the title panel's focused first button: the first level replaces the title.
  { name: 'platformer', scene: 'title', key: 'Enter', field: 'scene' },
  // The arrow moves the keyboard cursor one cell.
  { name: 'puzzle', scene: 'board', key: 'ArrowRight', field: 'cursor' },
  // W walks forward: the player's x or z moves.
  { name: 'first-person', scene: 'world', key: 'KeyW', field: 'z' },
  { name: 'third-person', scene: 'arena', key: 'KeyW', field: 'z' },
];

/** Read the probe after a `requestAnimationFrame` settle, so it is a whole frame's values. */
const readProbe = async (page: Page): Promise<Probe | null> =>
  JSON.parse(
    await page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() => resolve(JSON.stringify(window.__template ?? null))),
        ),
    ),
  ) as Probe | null;

test.describe('templates', () => {
  for (const c of CASES) {
    test(`${c.name}: boots, renders, answers a key, no console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
      });
      await page.goto(templateUrl(c.name));
      await expect
        .poll(async () => (await readProbe(page))?.frames ?? 0, { timeout: 30_000 })
        .toBeGreaterThan(10);
      const before = (await readProbe(page))!;
      expect(before.scene).toBe(c.scene);

      // Three seconds of running with a clean console.
      await page.waitForTimeout(3000);
      expect(errors).toEqual([]);
      const later = (await readProbe(page))!;
      expect(later.frames).toBeGreaterThan(before.frames);

      // One key: the scene or a state field changes.
      const read = async () => (await readProbe(page))?.[c.field];
      const start = await read();
      await page.keyboard.down(c.key);
      await expect.poll(read, { timeout: 15_000 }).not.toBe(start);
      await page.keyboard.up(c.key);
      expect(errors).toEqual([]);
    });
  }
});

declare global {
  interface Window {
    __template?: Probe;
  }
}
