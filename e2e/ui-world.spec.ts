/**
 * The world presenter (ws/ui-world) against harness/ui-world.html: one spec panel on the page
 * (the DOM presenter) and on a quad in the room (the world presenter), plus a HUD and a modal on
 * the head-following screen.
 *
 * - parity: the same presses through the page's copy (clicks and keys on the DOM) and through
 *   rays at the quad (mouse or touch, keys to the quad) say the same events and leave the same
 *   model;
 * - an idle quad paints nothing;
 * - the screen's `Menu` (a ray) opens the modal; Escape closes it, and so does its `Resume`;
 * - `?stereo`: both eyes draw the quad, each in its half.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { UiWorldPoint, UiWorldState } from '../harness/ui-world-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
type Rgb = [number, number, number];

const LOGICAL = { width: 1920, height: 1080 };
let frame: Frame;
let touch = false;
let cdp: CDPSession | null = null;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  // Touch through CDP (Chromium only); WebKit's rows press with the mouse.
  const use = test.info().project.use;
  touch = use.hasTouch === true && use.browserName !== 'webkit';
  cdp = null;
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const name = `ui-world.html${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${name}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(name)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`ui-world demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<UiWorldState> {
  return frame.evaluate(() => {
    const api = window.__harnessUiWorld;
    if (!api) throw new Error('window.__harnessUiWorld missing');
    return JSON.parse(JSON.stringify(api.state())) as UiWorldState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** World point → page px through camera `cam`'s matrix and screen. */
async function project(s: UiWorldState, w: UiWorldPoint, cam = 0): Promise<Pt> {
  const m = s.viewProjections[cam]!;
  const c = [0, 1, 2, 3].map(
    (r) => m[r]! * w[0] + m[4 + r]! * w[1] + m[8 + r]! * w[2] + m[12 + r]!,
  );
  const cw = c[3]!;
  if (cw <= 0) throw new Error('behind the camera');
  let sc = s.screens[cam]!;
  // A screen in logical units (the page camera) or in the unit square (the eyes).
  if (sc.width > 1.5)
    sc = {
      x: sc.x / LOGICAL.width,
      y: sc.y / LOGICAL.height,
      width: sc.width / LOGICAL.width,
      height: sc.height / LOGICAL.height,
    };
  const fx = sc.x + ((c[0]! / cw + 1) / 2) * sc.width;
  const fy = sc.y + ((1 - c[1]! / cw) / 2) * sc.height;
  const box = await canvasBox();
  return { x: box.x + fx * box.width, y: box.y + fy * box.height };
}

async function quadAt(id: string): Promise<Pt> {
  const s = await read();
  const w = s.quad[id];
  if (!w) throw new Error(`no word ${id} on the quad`);
  return project(s, w);
}

async function screenAt(id: string): Promise<Pt> {
  const s = await read();
  const w = s.screen[id];
  if (!w) throw new Error(`no word ${id} on the screen`);
  return project(s, w);
}

/** A press and release at `p` (touch through CDP, else the mouse). */
async function tap(page: Page, p: Pt): Promise<void> {
  if (touch) {
    cdp ??= await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: p.x, y: p.y, id: 1 }],
    });
    await frames(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(p.x, p.y);
    await frames(1);
    await page.mouse.down();
    await frames(1);
    await page.mouse.up();
  }
  await frames(2);
}

/** Hides the page's copy: on a narrow phone it covers the quad and the screen. */
async function hidePage(): Promise<void> {
  await frame.evaluate(() => {
    const el = document.getElementById('page');
    if (el) el.style.display = 'none';
  });
}

const word = (id: string) => frame.locator(`[data-tc-id="kit/${id}"]`);
const quiet = (e: string) => !e.includes(':focus:') && !e.includes(':blur:');

test('the same presses through the page and through rays: the same events and model', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  // The page's copy.
  await word('use').click();
  await word('mute').click();
  await frame.locator('[data-tc-id="kit/tab:two"]').click();
  await word('vol').focus();
  await page.keyboard.press('ArrowRight');
  await word('say').focus();
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  await frames(2);
  const dom = await read();
  expect(dom.events.filter(quiet)).toEqual([
    'use::tap:null',
    'mute::toggle:true',
    'tab:two:pick:two',
    // A range says input as it moves and change once let go (a key is both at once).
    'vol::input:4',
    'vol::change:4',
    'say::input:h',
    'say::input:hi',
    'say::enter:hi',
    // A submit carries its field's text.
    'send::tap:hi',
  ]);

  await frame.evaluate(() => window.__harnessUiWorld?.reset());
  await hidePage();
  await frames(2);
  // The quad, by rays; its keys once a ray focused it.
  await tap(page, await quadAt('use'));
  await tap(page, await quadAt('mute'));
  await tap(page, await quadAt('tab:two'));
  await tap(page, await quadAt('say'));
  expect((await read()).quadFocus).toBe('say');
  await page.keyboard.press('Shift+Tab');
  expect((await read()).quadFocus).toBe('vol');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  await frames(2);
  const world = await read();
  expect(world.events.filter(quiet)).toEqual(dom.events.filter(quiet));
  expect(world.model).toEqual(dom.model);
  expect(world.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('an idle quad paints nothing', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await frames(3);
  const a = await read();
  await frames(5);
  const b = await read();
  expect(b.paints).toBe(a.paints);
  expect(b.uploads).toBe(a.uploads);
  expect(errors).toEqual([]);
});

test('the head screen: Menu opens the modal, Escape and Resume close it', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await hidePage();
  await tap(page, await screenAt('open'));
  await expect.poll(async () => (await read()).modalOpen).toBe(true);
  expect((await read()).events).toContain('menu/open::tap:null');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read()).modalOpen).toBe(false);
  expect((await read()).events).toContain('dialog/closed:escape');
  await tap(page, await screenAt('open'));
  await expect.poll(async () => (await read()).modalOpen).toBe(true);
  await tap(page, await screenAt('resume'));
  await expect.poll(async () => (await read()).modalOpen).toBe(false);
  const s = await read();
  expect(s.events).toContain('dialog/resume::tap:null');
  expect(s.events).toContain('dialog/closed:close');
  expect(errors).toEqual([]);
});

/** Average colour of the 3×3 CSS px around each page point, from a page screenshot. */
async function sample(page: Page, points: Pt[]): Promise<Rgb[]> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      return pts.map((p) => {
        const d = g.getImageData(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3).data;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          out[0] += d[i]! / 9;
          out[1] += d[i + 1]! / 9;
          out[2] += d[i + 2]! / 9;
        }
        return out;
      });
    },
    [png.toString('base64'), points] as const,
  );
}

test('stereo: both eyes draw the quad, each in its half', async ({ page, wrapper }) => {
  await open(page, wrapper, '?stereo');
  const s = await read();
  expect(s.stereo).toBe(true);
  expect(s.viewProjections.length).toBe(2);
  const box = await canvasBox();
  const mid = box.x + box.width / 2;
  const l = await project(s, s.quad.use!, 0);
  const r = await project(s, s.quad.use!, 1);
  expect(l.x).toBeLessThan(mid);
  expect(r.x).toBeGreaterThan(mid);
  // The page's copy is hidden: a headset has no page.
  await expect(word('use')).toBeHidden();
  // The quad's empty `say` field (a flat fill) looks the same in both halves, and unlike the wall
  // beside the quad.
  const fl = await project(s, s.quad.say!, 0);
  const fr = await project(s, s.quad.say!, 1);
  const lw = await project(s, [-0.9, 1.4, 0], 0);
  const [cl, cr, wall] = await sample(page, [fl, fr, lw]);
  const diff = (a: Rgb, b: Rgb) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  expect(diff(cl!, cr!), `${cl} vs ${cr}`).toBeLessThan(40);
  expect(diff(cl!, wall!), `${cl} vs wall ${wall}`).toBeGreaterThan(40);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
