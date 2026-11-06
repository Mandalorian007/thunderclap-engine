/**
 * The audio zones demo (harness/zones.html) on every matrix row. Audio is locked in a headless
 * run (no gesture), so this asserts the bookkeeping `audio.update(dt)` keeps, not sound:
 *
 * - the camera's own orbit carries the listener through the sphere room and the box corridor:
 *   each zone's weight reaches 1 and falls back to 0 (polled, E-017);
 * - the effective reverb sends follow the max rule: per bus, `max(base, max over zones of
 *   weight × send)`, read in the same frame as the weights;
 * - the ambient loop of a zone the listener is inside has ramped up;
 * - the voice following the orbiting mesh reads its position from the mesh's world matrix.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessZonesState } from '../harness/zones-state';
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
    await page.goto(`${HARNESS_URL}zones.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('zones.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`zones demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessZonesState> {
  return frame.evaluate(() => {
    const s = window.__harnessZones?.state;
    if (!s) throw new Error('window.__harnessZones missing');
    return JSON.parse(JSON.stringify(s)) as HarnessZonesState;
  });
}

/** What the max rule says the effective send of `bus` should be for this snapshot. */
function expectedSend(
  s: HarnessZonesState,
  snap: { weights: number[]; baseSends: { music: number; sfx: number; ui: number } },
  bus: 'music' | 'sfx' | 'ui',
): number {
  let v = snap.baseSends[bus];
  s.zones.forEach((z, i) => {
    v = Math.max(v, snap.weights[i]! * z.reverbSend[bus]);
  });
  return v;
}

test('the orbit carries the listener into and out of both zones', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.zones.map((z) => z.kind)).toEqual(['sphere', 'box']);
  expect(s.weights).toHaveLength(2);
  // Six meshes, the shells among them; the camera orbits, so the frustum culls a varying few.
  expect(s.stats.instances).toBeGreaterThanOrEqual(3);
  expect(s.stats.instances).toBeLessThanOrEqual(6);
  expect(s.gpuErrors).toBe(0);
  // Each zone is entered fully within one orbit (~6.3 s).
  await expect.poll(async () => (await read()).peaks[0]).toBeGreaterThan(0.99);
  await expect.poll(async () => (await read()).peaks[1]).toBeGreaterThan(0.99);
  // And left again: the current weight of the room returns to 0.
  await expect.poll(async () => (await read()).weights[0]).toBe(0);
  expect(errors).toEqual([]);
});

test('the effective reverb sends follow the max rule as the weights move', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  // The page keeps the first frame with the room part-way weighted (the feather is crossed in
  // a fraction of a second, too fast to catch from here): the blend is doing work there.
  let s = await read();
  await expect
    .poll(async () => {
      s = await read();
      return s.partial !== null;
    })
    .toBe(true);
  const partial = s.partial!;
  for (const bus of ['music', 'sfx', 'ui'] as const) {
    expect(s.sends[bus] >= 0).toBe(true);
    expect(partial.sends[bus], `${bus} at weights ${partial.weights}`).toBeCloseTo(
      expectedSend(s, partial, bus),
      2,
    );
  }
  // Fully inside the room (the orbit starts there): the room's sends win over the base.
  await expect
    .poll(async () => {
      s = await read();
      return s.inside !== null;
    })
    .toBe(true);
  const inside = s.inside!;
  expect(inside.sends.sfx).toBeCloseTo(s.zones[0]!.reverbSend.sfx, 2);
  expect(inside.sends.music).toBeCloseTo(s.zones[0]!.reverbSend.music, 2);
  expect(inside.sends.ui).toBeCloseTo(inside.baseSends.ui, 2);
  // The ambient loop of the room has (started to) come up; nothing is heard while locked.
  await expect.poll(async () => (await read()).ambientPeaks[0]).toBeGreaterThan(0.3);
  // Out of every zone: back to the base.
  await expect
    .poll(async () => {
      s = await read();
      return Math.max(...s.weights);
    })
    .toBe(0);
  expect(s.sends).toEqual(s.baseSends);
  expect(s.audioState).toBe('locked');
  expect(errors).toEqual([]);
});

test('a following voice reads its position from the orbiting mesh', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const a = await read();
  for (let i = 0; i < 3; i++) expect(a.followPos[i]).toBeCloseTo(a.moverPos[i]!, 4);
  await expect
    .poll(async () => {
      const b = await read();
      return Math.hypot(b.moverPos[0] - a.moverPos[0], b.moverPos[2] - a.moverPos[2]);
    })
    .toBeGreaterThan(0.5);
  const b = await read();
  for (let i = 0; i < 3; i++) expect(b.followPos[i]).toBeCloseTo(b.moverPos[i]!, 4);
  expect(errors).toEqual([]);
});
