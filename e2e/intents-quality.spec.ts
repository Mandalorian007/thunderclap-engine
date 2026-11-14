/**
 * Intents and the frame governor (ws/intents-quality) on every matrix row.
 *
 * Intents, against harness/intents.html (no WebGPU): real CDP touches on the touch rows, the real
 * mouse and keys on desktop and in the itch-style iframe.
 * - a tap aims at its own point, once, whatever the scheme;
 * - a still press held becomes a hold that starts, follows the pointer and ends (a still finger on
 *   touch rows, a held key aimed by the free mouse elsewhere);
 * - the move stick's thumb never taps, and holds only where the game's `stickSideHold` says;
 * - presses, selects, cycles (keys and the wheel), and the centre aim.
 * The intents' clock is pinned (`setClock`): the spec decides how long a press lasts.
 *
 * The governor, against harness/quality.html: under a synthetic GPU load it steps dynamic
 * resolution down to the scale that fits, and back up once the load clears.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessIntentsState, IntentLogEntry } from '../harness/intents-state';
import type { HarnessQualityState } from '../harness/quality-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}

let frame: Frame;
let touch = false;
const touchRow = () => test.info().project.use.hasTouch === true;

async function open(page: Page, wrapper: 'top' | 'itch-iframe', name: string): Promise<Frame> {
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${name}`);
    return page.mainFrame();
  }
  await page.goto(`${WRAPPER_URL}?page=${name}`);
  return harnessFrame(page);
}

function read(): Promise<HarnessIntentsState> {
  return frame.evaluate(() => {
    const s = window.__harnessIntents?.state;
    if (!s) throw new Error('window.__harnessIntents missing');
    return JSON.parse(JSON.stringify(s)) as HarnessIntentsState;
  });
}
const logOf = async (intent: string): Promise<IntentLogEntry[]> =>
  (await read()).log.filter((e) => e.intent === intent);
const clear = () => frame.evaluate(() => window.__harnessIntents?.clear());
const setClock = (ms: number) => frame.evaluate((v) => window.__harnessIntents?.setClock(v), ms);
const setCentred = (on: boolean) =>
  frame.evaluate((v) => window.__harnessIntents?.setCentred(v), on);

async function frames(n = 2): Promise<void> {
  await frame.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let left = count;
        const step = () => (--left <= 0 ? done() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** Game space (800×600) to page CSS px. */
async function mapper(): Promise<(x: number, y: number) => Pt> {
  const box = await frame.locator('#stage').boundingBox();
  if (!box) throw new Error('no stage');
  const s = box.width / 800;
  return (x, y) => ({ x: box.x + x * s, y: box.y + y * s });
}

class Touch {
  private cdp: CDPSession | null = null;
  constructor(private readonly page: Page) {}
  async send(type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]): Promise<void> {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: 1 })),
    });
  }
  /** A quick tap: the clock is pinned, so however many frames pass between them it lasts 0 ms. */
  async tap(p: Pt): Promise<void> {
    await this.send('touchStart', [p]);
    await this.send('touchEnd', []);
  }
}

const near = (a: number | undefined, b: number, tol = 3) => Math.abs((a ?? -1e9) - b) <= tol;

test.describe('intents', () => {
  test.beforeEach(async ({ page, wrapper }) => {
    touch = touchRow();
    frame = await open(page, wrapper, 'intents.html');
    await expect.poll(() => read().then((s) => s.ready && s.ticks > 2)).toBe(true);
    await setClock(0);
  });

  test('a tap aims at its own point, once', async ({ page }) => {
    const at = await mapper();
    const p = at(600, 300);
    if (touch) await new Touch(page).tap(p);
    else await page.mouse.click(p.x, p.y);
    await expect.poll(async () => (await logOf('use')).length).toBe(1);
    await frames(3);
    const [use] = await logOf('use');
    expect(near(use?.x, 600) && near(use?.y, 300)).toBe(true);
    expect((await logOf('use')).length).toBe(1);
  });

  test('a still press held is a hold that follows the pointer and ends', async ({ page }) => {
    const at = await mapper();
    const a = at(600, 300);
    const b = at(660, 320);
    const t = new Touch(page);
    if (touch) {
      await t.send('touchStart', [a]);
      await frames(2);
      expect(await logOf('act')).toEqual([]);
      await setClock(400);
    } else {
      await page.mouse.move(a.x, a.y);
      await frames(2);
      await page.keyboard.down('KeyF');
    }
    await expect.poll(async () => (await read()).holding).toBe('act');
    const [start] = await logOf('act');
    expect(start?.phase).toBe('start');
    expect(near(start?.x, 600) && near(start?.y, 300)).toBe(true);
    if (touch) await t.send('touchMove', [b]);
    else await page.mouse.move(b.x, b.y);
    await expect
      .poll(async () => (await logOf('act')).some((e) => e.phase === 'aim' && near(e.x, 660)))
      .toBe(true);
    if (touch) await t.send('touchEnd', []);
    else await page.keyboard.up('KeyF');
    await expect.poll(async () => (await logOf('act')).at(-1)?.phase).toBe('end');
    expect(await logOf('use')).toEqual([]);
  });

  test("the move stick's thumb never taps; it holds only where the game says", async ({ page }) => {
    test.skip(!touchRow(), 'touch rows only');
    const at = await mapper();
    const t = new Touch(page);
    // A quick tap on the stick: nothing.
    await t.tap(at(200, 450));
    await frames(4);
    expect((await read()).log).toEqual([]);
    // Held still in the stick's bottom half: it only walks.
    await t.send('touchStart', [at(200, 450)]);
    await frames(2);
    await setClock(400);
    await frames(4);
    await t.send('touchEnd', []);
    await frames(3);
    expect((await read()).log).toEqual([]);
    // Held still in its top half: a stick-side hold.
    await setClock(1000);
    await t.send('touchStart', [at(200, 150)]);
    await frames(2);
    await setClock(1400);
    await expect.poll(async () => (await read()).holding).toBe('gather');
    await t.send('touchEnd', []);
    await expect
      .poll(async () => (await logOf('gather')).map((e) => e.phase))
      .toEqual(['start', 'end']);
    expect(await logOf('use')).toEqual([]);
    expect(await logOf('act')).toEqual([]);
  });

  test('presses, selects and cycles; the centre aim is null', async ({ page }) => {
    // Keys go to the focused frame: focus the stage with a press first.
    const at = await mapper();
    const p = at(600, 300);
    if (touch) await new Touch(page).tap(p);
    else await page.mouse.click(p.x, p.y);
    await expect.poll(async () => (await logOf('use')).length).toBe(1);
    await clear();
    if (touch) await frame.locator('#stage').evaluate(() => window.focus());
    // One key a tick: next and prev in the same tick cancel out.
    for (const key of ['Space', 'Digit2', 'KeyR', 'KeyQ']) {
      await page.keyboard.press(key);
      await frames(2);
    }
    await expect.poll(async () => (await read()).log.length).toBeGreaterThanOrEqual(4);
    const s = await read();
    expect(s.log.filter((e) => e.intent === 'jump').length).toBe(1);
    expect(s.log.filter((e) => e.intent === 'slot').map((e) => e.n)).toEqual([1]);
    expect(s.log.filter((e) => e.intent === 'cycle').map((e) => e.n)).toEqual([1, -1]);
    await setCentred(true);
    await page.keyboard.press('KeyE');
    await expect.poll(async () => (await logOf('use')).at(-1)?.centre).toBe(true);
    await setCentred(false);
    if (!touch) {
      await clear();
      await page.mouse.move(p.x, p.y);
      await page.mouse.wheel(0, 120);
      await expect.poll(async () => (await logOf('cycle')).map((e) => e.n)).toEqual([1]);
    }
  });
});

test.describe('quality', () => {
  function readQ(): Promise<HarnessQualityState> {
    return frame.evaluate(() => {
      const s = window.__harnessQuality?.state;
      if (!s) throw new Error('window.__harnessQuality missing');
      return JSON.parse(JSON.stringify(s)) as HarnessQualityState;
    });
  }

  test('the governor steps resolution down under a synthetic load and back when it clears', async ({
    page,
    wrapper,
  }) => {
    frame = await open(page, wrapper, 'quality.html');
    await expect.poll(() => readQ().then((s) => s.ready && s.seconds > 1)).toBe(true);
    const first = await readQ();
    expect(['low', 'medium', 'high']).toContain(first.tier);
    expect(first.reason.length).toBeGreaterThan(0);
    expect(first.shed).toBe(0);
    await frame.evaluate(() => window.__harnessQuality?.setLoad(30));
    // 0.7² × 30 ms fits a 16.7 ms frame: three steps of resolution, the glow kept.
    await expect.poll(async () => (await readQ()).scale, { timeout: 20_000 }).toBe(0.7);
    const shed = await readQ();
    expect(shed.glowShed).toBe(false);
    expect(shed.changes.map((c) => `${c.dir} ${c.knob}`).slice(0, 3)).toEqual([
      'down resolution',
      'down resolution',
      'down resolution',
    ]);
    await frame.evaluate(() => window.__harnessQuality?.setLoad(8));
    await expect
      .poll(
        async () => {
          const s = await readQ();
          return s.shed === 0 && s.scale === 1;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    expect((await readQ()).line).toBe('governor: full quality');
  });
});
