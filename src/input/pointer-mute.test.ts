/**
 * `PointerRouter.mute` / `unmute` (ws/input-11): a muted source's pointers are dropped before
 * routing, a pointer held when the mute begins is released (never a stuck press), unmuting
 * restores dispatch without turning a held button into a new press, and synthetic (replayed)
 * samples pass a mute.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeXr,
  FakeXrInputSource,
  type FakeXrSession,
  installFakeXr,
} from '../platform/xr-fake';
import { Camera } from '../render/camera';
import { Input } from './input';
import { createPointerRouter, type PointerHitEvent } from './pointer-router';
import { createSample, type PointerSample, type PointerSource } from './pointer-sources';
import { aabbTester, planeTester, screenRay } from './rays';
import { XrPointerSource } from './xr-source';

let xr: FakeXr | null = null;

afterEach(() => {
  xr?.uninstall();
  xr = null;
});

type Log = string[];
function logAll(router: ReturnType<typeof createPointerRouter<string | null>>, log: Log) {
  const rec = (kind: string) => (e: PointerHitEvent<string | null>) =>
    log.push(`${kind}:${e.pointer.device}:${e.hit?.target ?? '-'}`);
  for (const k of ['hit', 'hitEnd', 'select', 'secondary', 'released'] as const) {
    router.on(k, rec(k));
  }
}

async function xrSetup() {
  xr = installFakeXr();
  const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
  const space = await session.requestReferenceSpace('local-floor');
  let frame: XRFrame | null = null;
  const source = new XrPointerSource(session, space, () => frame);
  const router = createPointerRouter<string | null>({
    camera: Camera.perspective(1, 1, 0.1, 100),
    testers: [planeTester(-2, 'wall')],
  });
  router.addSource(source);
  const input = new Input(
    { select: [{ xr: 'trigger' }] },
    { getGamepads: () => [], pointers: router },
  );
  const log: Log = [];
  logAll(router, log);
  const fx = xr;
  const tick = () => {
    session.requestAnimationFrame((_t, f) => {
      frame = f;
      input.update();
      frame = null;
    });
    fx.step();
  };
  const ctl = new FakeXrInputSource('right');
  session.addInputSource(ctl);
  return { router, input, source, log, tick, ctl };
}

describe('PointerRouter.mute: XR', () => {
  it('a muted XR source does not dispatch its select', async () => {
    const { router, input, source, log, tick, ctl } = await xrSetup();
    router.mute([source]);
    expect(router.isMuted(source)).toBe(true);
    expect(router.isMuted(router.screen)).toBe(false);
    tick();
    ctl.buttons[0]!.pressed = true;
    tick();
    expect(log).toEqual([]);
    expect(router.pointers.length).toBe(0);
    expect(router.xrHeld('trigger')).toBe(false);
    expect(input.pressed('select')).toBe(false);
    expect(input.held('select')).toBe(false);
  });

  it('an XR trigger held when the mute begins releases; unmuting restores dispatch', async () => {
    const { router, input, log, tick, ctl } = await xrSetup();
    tick();
    ctl.buttons[0]!.pressed = true;
    tick();
    expect(input.pressed('select')).toBe(true);
    expect(router.xrHeld('trigger')).toBe(true);
    router.mute();
    tick();
    expect(log).toEqual(['hit:xr:wall', 'select:xr:wall', 'hitEnd:xr:wall', 'released:xr:-']);
    expect(router.xrHeld('trigger')).toBe(false);
    expect(input.held('select')).toBe(false);
    // Still held through the unmute: the pointer is back, but that is no new press.
    router.unmute();
    tick();
    expect(router.pointers.length).toBe(1);
    expect(log.at(-1)).toBe('hit:xr:wall');
    expect(input.pressed('select')).toBe(false);
    expect(input.held('select')).toBe(false);
    expect(router.xrHeld('trigger')).toBe(false);
    ctl.buttons[0]!.pressed = false;
    tick();
    ctl.buttons[0]!.pressed = true;
    tick();
    expect(input.pressed('select')).toBe(true);
    expect(log.at(-1)).toBe('select:xr:wall');
  });
});

/** Two quads, a router and its log. */
function screenSetup() {
  const router = createPointerRouter<string | null>({
    camera: Camera.ortho2d(800, 600),
    testers: [aabbTester([{ min: [100, 100, 0], max: [200, 200, 0], target: 'a' }])],
  });
  const log: Log = [];
  logAll(router, log);
  return { router, log };
}

describe('PointerRouter.mute: screen and synthetic', () => {
  it('a mouse held when the mute begins releases over nothing, then nothing routes', () => {
    const { router, log } = screenSetup();
    router.screen.pointerMove(1, 150, 150);
    router.screen.pointerDown(1, 150, 150, 'mouse', 0);
    router.update();
    expect(router.held('select')).toBe(true);
    router.mute();
    router.update();
    expect(log).toEqual(['hit:mouse:a', 'select:mouse:a', 'hitEnd:mouse:a', 'released:mouse:-']);
    expect(router.held('select')).toBe(false);
    expect(router.pointers.length).toBe(0);
    router.screen.pointerUp(1, 150, 150, 0);
    router.screen.pointerDown(1, 150, 150, 'mouse', 0);
    router.update();
    expect(log).toHaveLength(4);
    router.unmute();
    router.update();
    // Held through the mute: back on its target, reading up, not a new press.
    expect(log.slice(4)).toEqual(['hit:mouse:a']);
    expect(router.held('select')).toBe(false);
    router.screen.pointerUp(1, 150, 150, 0);
    router.update();
    router.screen.pointerDown(1, 150, 150, 'mouse', 0);
    router.update();
    // Its up is no release (it read up already); its next press is a press.
    expect(log.slice(4)).toEqual(['hit:mouse:a', 'select:mouse:a']);
  });

  it('a hovering pointer muted ends with hitEnd and no released', () => {
    const { router, log } = screenSetup();
    router.screen.pointerMove(1, 150, 150);
    router.update();
    router.mute([router.screen]);
    router.update();
    expect(log).toEqual(['hit:mouse:a', 'hitEnd:mouse:a']);
  });

  it('synthetic samples pass a mute of every source, beside a muted live one', () => {
    const { router, log } = screenSetup();
    router.mute();
    router.screen.pointerMove(1, 150, 150);
    router.screen.pointerDown(1, 150, 150, 'mouse', 0);
    router.screen.pointerMove(9, 150, 150, 'mouse', true);
    router.screen.pointerDown(9, 150, 150, 'mouse', 0, true);
    router.update();
    expect(log).toEqual(['hit:mouse:a', 'select:mouse:a']);
    expect(router.pointers.length).toBe(1);
    expect(router.pointers[0]!.key).toBe(9);
  });

  it('a source added while every source is muted is muted too; a custom source can mark synthetic', () => {
    const { router, log } = screenSetup();
    router.mute();
    const s: PointerSample = createSample(0, 'gamepad');
    s.x = 150;
    s.y = 150;
    screenRay(Camera.ortho2d(800, 600), 150, 150, s.ray);
    const src: PointerSource = { poll: () => [s] };
    router.addSource(src);
    router.update();
    expect(log).toEqual([]);
    s.synthetic = true;
    router.update();
    expect(log).toEqual(['hit:gamepad:a']);
  });
});

describe('PointerRouter.mute: removers (ws/api-core)', () => {
  it('a mute remover lifts only its own mute; unmute lifts them all', () => {
    const { router, log } = screenSetup();
    const game = router.mute([router.screen]);
    const replay = router.mute();
    expect(router.isMuted(router.screen)).toBe(true);
    replay();
    // The game's mute survives the other one ending.
    expect(router.isMuted(router.screen)).toBe(true);
    router.screen.pointerMove(1, 150, 150);
    router.update();
    expect(log).toEqual([]);
    replay();
    game();
    game();
    expect(router.isMuted(router.screen)).toBe(false);
    router.update();
    expect(log).toEqual(['hit:mouse:a']);
    router.mute();
    const late = router.mute([router.screen]);
    router.unmute();
    expect(router.isMuted(router.screen)).toBe(false);
    late();
    expect(router.isMuted(router.screen)).toBe(false);
  });

  it('a press held while one of two mutes ends stays read as up', () => {
    const { router, log } = screenSetup();
    router.screen.pointerMove(1, 150, 150);
    router.screen.pointerDown(1, 150, 150, 'mouse', 0);
    router.update();
    const a = router.mute();
    const b = router.mute([router.screen]);
    router.update();
    a();
    router.update();
    expect(log).toEqual(['hit:mouse:a', 'select:mouse:a', 'hitEnd:mouse:a', 'released:mouse:-']);
    b();
    router.update();
    expect(log.slice(4)).toEqual(['hit:mouse:a']);
    expect(router.held('select')).toBe(false);
  });
});
