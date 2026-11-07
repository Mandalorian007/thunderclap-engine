# Testing your game

## What you'll build

In this guide you test a game the way the templates do: pure rules and the save schema in Vitest, input sessions recorded and replayed tick by tick, game logic stepped on a fixed clock against a fake host, the renderer on a fake GPU, and the running page in Playwright through a small state probe.

Everything a unit test needs comes from `@thunderclap/engine/testing`: `createFakeHost`, `createFixedClock` and the fake GPU device. These run in Vitest or plain Node with no browser and no GPU.

The engine tests the platform itself (WebGPU, input devices, layout on every form factor) on its own device matrix. Your tests cover only your product: your rules, your save, your scenes.

## Run the tests a template ships

Every template has a `vitest.config.ts` that picks up `src/**/*.test.ts`:

```sh
pnpm test        # Vitest, once
pnpm check       # tsc, Biome, then Vitest
```

What each template tests:

| Template | Tests |
| --- | --- |
| `puzzle` | `rules/board.test.ts` (dealing and moves), `save/schema.test.ts`, `analytics.test.ts` |
| `platformer` | `physics/physics.test.ts` (collision, coyote time, jump buffer), `levels/format.test.ts`, `save/schema.test.ts` |
| `first-person` | `world/terrain.test.ts`, `world/mesher.test.ts` |
| `third-person` | `character/rig.test.ts`, `character/controller.test.ts`, `character/cosmetics.test.ts`, `world/stones.test.ts`, `enemies/enemies.test.ts` |

None of them needs a browser. That is on purpose: the code worth testing is kept apart from the DOM and the GPU.

## Test pure rules

The templates' first house rule is that rules are pure. A move is a function that takes the old state and returns a new one. It never mutates its input, never reads the clock and never calls `Math.random`. Randomness comes from `createRandom(seed)`, which gives the same sequence in every browser.

Here is a small rules file in that style, `src/rules/dice.ts`:

```ts
import { createRandom } from '@thunderclap/engine/core';

export interface Table {
  readonly dice: readonly number[];
  readonly rolls: number;
}

export function deal(count: number, seed: number): Table {
  const rng = createRandom(seed);
  return { dice: Array.from({ length: count }, () => rng.int(1, 6)), rolls: 0 };
}

export function reroll(t: Table, index: number, seed: number): Table {
  if (index < 0 || index >= t.dice.length) return t; // ignore a bad index: same object
  const dice = [...t.dice];
  dice[index] = createRandom(seed).int(1, 6);
  return { dice, rolls: t.rolls + 1 };
}
```

And its test, `src/rules/dice.test.ts`. This block imports `./dice`, the file above, so the snippet check cannot compile it on its own:

```ts no-check
import { describe, expect, it } from 'vitest';
import { deal, reroll } from './dice';

describe('deal', () => {
  it('is the same table for the same seed', () => {
    expect(deal(5, 42)).toEqual(deal(5, 42));
    expect(deal(5, 42).dice).not.toEqual(deal(5, 43).dice);
  });
});

describe('reroll', () => {
  it('returns a new table and leaves the old one alone', () => {
    const t0 = deal(5, 1);
    const t1 = reroll(t0, 2, 7);
    expect(t1.rolls).toBe(1);
    expect(t0.rolls).toBe(0);
  });

  it('ignores an index off the table', () => {
    const t0 = deal(5, 1);
    expect(reroll(t0, 99, 7)).toBe(t0);
  });
});
```

Three habits from `templates/puzzle/src/rules/board.test.ts` worth copying:

- Check that the same seed gives the same result, and a different seed a different one.
- Check that the input state is untouched after a move.
- For a move that does nothing, check `toBe` (the same object), not `toEqual`. The scene can then skip a redraw.

## Test the save schema

A save has a schema, a version number and one migration per old version. Test it against `MemoryStorage` instead of `localStorage`. Pass `debounceMs: 0` so writes happen at once, `autoFlush: false` so nothing listens for page events, and a fixed `now`:

```ts
import { createSaveStore, MemoryStorage, type Migrations, s, saveKey } from '@thunderclap/engine/save';
import { describe, expect, it } from 'vitest';

const Schema = s.object({
  wins: s.number({ min: 0, int: true }),
  best: s.nullable(s.number({ min: 0, int: true })),
});
const migrations: Migrations = {
  1: (old) => ({ wins: (old as { wins?: number }).wins ?? 0, best: null }),
};

const open = (storage: MemoryStorage) =>
  createSaveStore({
    game: 'my-game',
    slot: 'main',
    version: 2,
    migrations,
    defaults: () => ({ wins: 0, best: null }),
    schema: Schema,
    storage,
    debounceMs: 0,
    autoFlush: false,
    now: () => 1000,
  });

describe('save', () => {
  it('starts fresh from defaults', () => {
    const store = open(new MemoryStorage());
    expect(store.status.loadResult).toBe('fresh');
    expect(store.get()).toEqual({ wins: 0, best: null });
  });

  it('migrates a v1 save', () => {
    const storage = new MemoryStorage();
    storage.setItem(saveKey('my-game', 'main'), JSON.stringify({ v: 1, t: 1, d: { wins: 3 } }));
    const store = open(storage);
    expect(store.status.loadResult).toBe('migrated');
    expect(store.get()).toEqual({ wins: 3, best: null });
  });

  it('rejects an update that breaks the schema', () => {
    const store = open(new MemoryStorage());
    expect(store.update((d) => ({ ...d, wins: -1 }))).toBe(false);
    expect(store.get().wins).toBe(0);
  });

  it('round-trips through storage', () => {
    const storage = new MemoryStorage();
    const a = open(storage);
    a.update((d) => ({ ...d, wins: 2 }));
    a.flush();
    expect(open(storage).get().wins).toBe(2);
  });
});
```

The stored value is `{ v, t, d }`: the version, the save time and the data. Writing one by hand, as the migration test does, is how you pin an old save you shipped. Add one test per old version.

## Replay input deterministically

`Input` can record everything it was fed, tick by tick, and play it back into another `Input` with the same `pressed`, `held` and `value` answers on every tick. Use it to turn a bug report or a scripted session into a test.

The feed methods (`keyDown`, `keyUp`, `buttonDown`, `buttonUp`, `pointerAt`, `wheel`) are public, so a test drives `Input` without a DOM. One `input.update()` is one tick. Record a session, then replay it into a fresh `Input` and check that your game logic sees the same thing:

```ts
import {
  type Bindings,
  createInputPlayback,
  createInputRecorder,
  Input,
  type InputRecording,
} from '@thunderclap/engine/input';
import { expect, it } from 'vitest';

type Action = 'left' | 'right' | 'jump';
const bindings: Bindings<Action> = {
  left: [{ key: 'ArrowLeft' }],
  right: [{ key: 'ArrowRight' }],
  jump: [{ key: 'Space' }],
};

/** The game's step: pure, reads only actions. */
function step(x: number, input: Input<Action>): number {
  return x + input.axis('left', 'right') * 2 + (input.pressed('jump') ? 100 : 0);
}

it('a replayed session ends in the same place', () => {
  const live = new Input<Action>(bindings, { getGamepads: () => [] });
  const rec = createInputRecorder(live);
  const script: ((i: Input<Action>) => void)[] = [
    (i) => i.keyDown('ArrowRight'),
    () => {},
    (i) => i.keyDown('Space'),
    (i) => i.keyUp('Space'),
    (i) => i.keyUp('ArrowRight'),
  ];
  let x = 0;
  const liveTrace: number[] = [];
  for (const feed of script) {
    feed(live);
    live.update();
    x = step(x, live);
    liveTrace.push(x);
  }
  const recording: InputRecording = rec.stop();

  const again = new Input<Action>(bindings, { getGamepads: () => [] });
  const pb = createInputPlayback(again, recording);
  let y = 0;
  const replayTrace: number[] = [];
  while (pb.step()) {
    again.update();
    y = step(y, again);
    replayTrace.push(y);
  }
  expect(replayTrace).toEqual(liveTrace);
});
```

The order matters: in a replay, call `pb.step()` before each `update()`. `step()` returns `false` when the recording is done.

A recording is plain JSON. `serializeRecording(rec)` writes it and `parseRecording(json)` reads it back and validates it, so you can check one into `src/fixtures/` and load it with `readFileSync` in a test.

### Record and replay a running game

`createGame` wires the same thing into the loop. `input: { record: true }` records from the first tick into `ctx.input.recorder`. The recorder lives on `ctx.input`; to replay mid-session, call `ctx.replay(rec)` (see the [input guide](input.md#record-and-replay-a-session)). A debug key that copies the session so a tester can paste it into a bug report:

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { serializeRecording } from '@thunderclap/engine/input';

export async function copySession(ctx: EngineCtx<string, null>): Promise<void> {
  const rec = ctx.input.recorder;
  if (!rec) return; // the game was not created with input.record
  const json = serializeRecording(rec.stop());
  const result = await ctx.host.copyText(json); // 'copied' or 'manual'
  if (result === 'manual') console.log(json);
}
```

To play it back, boot the same game with `input: { replay }`. The input then ignores the real keyboard, mouse and pads, and the loop feeds one recorded tick before each fixed step:

```ts
import { createGame } from '@thunderclap/engine';
import { parseRecording } from '@thunderclap/engine/input';

const json = new URLSearchParams(location.search).get('replay');
const ctx = await createGame({
  root: document.getElementById('app')!,
  input: {
    bindings: { jump: [{ key: 'Space' }] },
    replay: json ? parseRecording(json) : undefined,
  },
});
ctx?.loop.start();
```

A replay gives the same result only on the same game: the same bindings, the same fixed step, the same layout (pointer positions are recorded in CSS pixels) and the same seeds. Anything your game reads from `Date.now()` or `Math.random()` breaks it, which is one more reason to keep rules pure. Gestures run on `ctx.clock`, which is game time, so a long-press lands on the same tick in a replay. `ctx.input.playback.speed = 4` fast-forwards.

## Step a game on a fixed clock

`createFixedClock(stepMs?)` is a `TickClock`, the same type as `ctx.clock`. It moves only when the test calls `step(n)` (whole fixed steps) or `advance(ms)`, and N steps read exactly N × `stepMs`. Give it to the gestures (or a `Look`, or a playback) and run each tick in the order `createGame`'s loop does: step the clock, then `input.update()`, then your update. Timers such as long-press then run on game time:

```ts
import { type Bindings, createGestures, Input } from '@thunderclap/engine/input';
import { createFixedClock } from '@thunderclap/engine/testing';
import { expect, it } from 'vitest';

type Action = 'right' | 'info';
const bindings: Bindings<Action> = {
  right: [{ key: 'ArrowRight' }],
  info: [{ gesture: 'longPress' }],
};

it('walks while held and opens info on a long-press', () => {
  const clock = createFixedClock(10); // 10 ms steps
  const gestures = createGestures({ clock });
  const input = new Input<Action>(bindings, { getGamepads: () => [], gestures });
  const player = { x: 0, infoAt: -1 };
  const tick = () => {
    clock.step();
    input.update();
    if (input.held('right')) player.x += 2;
    if (input.pressed('info') && player.infoAt < 0) player.infoAt = clock.ticks;
  };

  input.keyDown('ArrowRight');
  for (let i = 0; i < 10; i++) tick();
  input.keyUp('ArrowRight');
  expect(player.x).toBe(20);

  gestures.pointerDown(1, 50, 50, 'touch', clock.now());
  for (let i = 0; i < 60; i++) tick();
  expect(player.infoAt).toBe(10 + 45); // 450 ms is 45 steps of 10 ms
});
```

The same tick function, fed by `createInputPlayback(input, recording)` instead of by hand, replays a recorded session to the same state (see the previous section).

## Fake the host

`createFakeHost(opts?)` returns a full `Host`: storage in memory, a lifecycle you move with `setState`, haptics, links and copies written down, a safe area you set, fullscreen and wake-lock stubs that record their calls, and frames that run only when you call `runFrame()`. Use it to test the code that reacts to the platform, such as autosaving when the app goes to the background:

```ts
import { createSaveStore, s } from '@thunderclap/engine/save';
import { createFakeHost } from '@thunderclap/engine/testing';
import { expect, it } from 'vitest';

it('saves when the app is backgrounded and buzzes once', () => {
  const host = createFakeHost();
  const open = () =>
    createSaveStore({
      game: 'my-game',
      slot: 'main',
      version: 1,
      defaults: () => ({ coins: 0 }),
      schema: s.object({ coins: s.number({ min: 0, int: true }) }),
      storage: host.storage.open()!,
      debounceMs: 60_000, // nothing is written until a flush
      autoFlush: false,
    });
  const save = open();
  host.lifecycle.watch((state) => {
    if (state === 'background') {
      save.flush();
      host.haptics.impact('light');
    }
  });

  save.update((d) => ({ coins: d.coins + 5 }));
  expect(open().get().coins).toBe(0);
  host.setState('background');
  expect(open().get().coins).toBe(5);
  expect(host.hapticCalls).toEqual([{ op: 'impact', style: 'light' }]);
});
```

`host.runFrame()` runs the frames requested so far, one display frame per call, so a `GameLoop` built with `{ frames: host }` advances only when the test says. `createGame({ gpu, clock })` runs headless: given a GPU context and a clock it skips the canvas and WebGPU, and `createTestGame` in `./testing` wraps it with the fake GPU, a fake host and a fixed clock, so a whole game runs in a unit test ([testing README](../../src/testing/README.md)). Test the page itself with the Playwright tests below.

### A whole game with no DOM, and device loss

`createTestGame` builds the engine's DOM overlay, so by default the test file needs happy-dom (`// @vitest-environment happy-dom`). If the test never touches the overlay, pass `overlay: false` and leave that line out. The game then runs in plain Node in the engine's no-DOM mode (`createGame({ overlay: false })`): nothing touches `document` or `window`, so nothing stands in for them. There is no overlay, and reading `ctx.ui` throws an error that says so. Drive the game through `input` (pointer positions are design px unless you pass a `viewport`) and assert on its state. Keep happy-dom for tests that click overlay buttons.

A real GPU can be lost at any time, for example by a driver reset or a tab sent to the background on mobile. `g.loseDevice(reason?, message?)` does that to the fake one and resolves once the engine has handled it, so a test can check that the game reacts the way it does on a page. The loop halts for good, `hooks.deviceLost(info)` runs, audio halts, the save flushes, and then each `ctx.onDeviceLost` listener runs. A loss with reason `'destroyed'` (the game destroyed the device itself) is ignored, as on a page.

```ts
import { createTestGame } from '@thunderclap/engine/testing';
import { expect, it } from 'vitest';

it('stops and reports when the GPU is lost', async () => {
  const g = await createTestGame({ overlay: false, input: { bindings: { jump: [{ key: 'Space' }] } } });
  const seen: string[] = [];
  g.ctx.onDeviceLost((info) => seen.push(info.reason));
  g.step(3);
  await g.loseDevice('unknown', 'driver reset');
  expect(seen).toEqual(['unknown']);
  expect(g.ctx.loop.halted).toBe(true);
  expect(g.clock.ticks).toBe(3);
  g.step(5); // halted: runs nothing
  expect(g.clock.ticks).toBe(3);
});
```

## Test rendering on the fake GPU

Most games never need this. If you build your own draw code (a batch of props, a custom material, a mesh builder), `@thunderclap/engine/testing` gives you a fake WebGPU device that runs in Node. It records every buffer, texture, pass and draw, and flags mistakes a real device would reject, such as writing to a buffer without `COPY_DST`.

```ts
import { Renderer } from '@thunderclap/engine/render';
import { createFakeDevice, fakeRendererGpu } from '@thunderclap/engine/testing';
import { expect, it } from 'vitest';

/** The game's code under test: one row of crates. */
function drawCrates(r: Renderer, count: number): void {
  const frame = r.beginFrame(0, 1 / 60);
  for (let i = 0; i < count; i++) frame.sprite(null, { x: i * 64, y: 0, w: 60, h: 60 });
  r.endFrame();
}

it('draws a row of crates in one call, with no device errors', () => {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  drawCrates(r, 20);
  expect(fake.errors).toEqual([]);
  expect(r.stats.drawCalls).toBe(1);
  const scene = fake.passes.find((p) => p.label === 'scene');
  expect(scene?.commands.some((c) => c.op === 'draw' || c.op === 'drawIndexed')).toBe(true);
});
```

The fake does not compile WGSL or produce pixels. For "does it look right", use the page tests below.

## Expose state to Playwright: the harness pattern

To test the running game in a real browser, the page publishes a small probe object on `window`, and a Playwright spec reads it. The templates do this in `main.ts` with `window.__template`, updated after every rendered frame:

```ts
import type { EngineCtx } from '@thunderclap/engine';

interface Probe {
  scene: string;
  frames: number;
  x: number;
}

declare global {
  interface Window {
    __template?: Probe;
  }
}

export function publishProbe(ctx: EngineCtx, player: { x: number }): void {
  const probe: Probe = { scene: '', frames: 0, x: 0 };
  window.__template = probe;
  ctx.hooks.afterRender = () => {
    probe.scene = ctx.stack.top?.name ?? '';
    probe.frames++;
    probe.x = player.x;
  };
}
```

Keep the probe to a few plain fields: the top scene's name, a frame counter and the values a test needs. It is cheap enough to leave in a shipped build.

The templates do not ship a Playwright setup of their own. In the engine repo, `e2e/templates.spec.ts` boots each template and reads its probe. To do the same in your game, add `@playwright/test` (`pnpm add -D @playwright/test`, then `pnpm exec playwright install chromium`) and a `playwright.config.ts` that starts your dev server:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
```

Point your Vitest config at `src/**/*.test.ts` (the templates already do), so Vitest never picks up the Playwright specs in `e2e/`. Headless Chromium may not expose WebGPU on every machine. If `createGame` resolves `null`, the probe never appears, and the test times out on the first poll.

## Wait for values that move: `expect.poll`

A game changes over time, so a test cannot read a value once and compare. `expect.poll` calls a function until its result passes, or the timeout runs out. This spec is shaped like `e2e/templates.spec.ts`:

```ts
import { expect, type Page, test } from '@playwright/test';

interface Probe {
  scene: string;
  frames: number;
  x: number;
}

declare global {
  interface Window {
    __template?: Probe;
  }
}

/** Read the probe after one animation frame, so every field is from the same frame. */
const readProbe = async (page: Page): Promise<Probe | null> =>
  JSON.parse(
    await page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() => resolve(JSON.stringify(window.__template ?? null))),
        ),
    ),
  ) as Probe | null;

test('boots, renders and walks right', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await expect.poll(async () => (await readProbe(page))?.frames ?? 0, { timeout: 30_000 }).toBeGreaterThan(10);
  expect((await readProbe(page))?.scene).toBe('level');

  const start = (await readProbe(page))!.x;
  await page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await readProbe(page))?.x ?? start, { timeout: 15_000 }).toBeGreaterThan(start);
  await page.keyboard.up('ArrowRight');
  expect(errors).toEqual([]);
});
```

Some rules that keep these tests stable:

- Poll for the condition you need (`frames > 10`, `x > start`), never a fixed `waitForTimeout` before a read.
- Hold a key with `keyboard.down` while you poll, and release it after. A single `press` can fall between two fixed steps.
- Give the first poll a long timeout. Booting WebGPU and compiling pipelines can take seconds on a cold browser.
- Collect `pageerror` and `console.error` from the start, and assert the list is empty at the end.
- No retries. If a test flakes, the timing assumption is wrong; fix the poll.

## Next

- [Testing reference](../../src/testing/README.md): the `./testing` kit, every fake and option
- [Input reference](../../src/input/README.md): see "Recording and replay" for the format and the clock rules
- [Save reference](../../src/save/README.md): schemas, migrations, slots and settings
- [Core reference](../../src/core/README.md): `createRandom`, the loop and `tickOnce`
- [Render reference](../../src/render/README.md): the fake GPU and what it records
- [Getting started](getting-started.md)
- [Input](input.md)
- [Migrating to v1](migrating-to-v1.md): the deprecated names your tests should not use
