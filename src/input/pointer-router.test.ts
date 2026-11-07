import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { Gestures } from './gestures';
import { Input } from './input';
import { createPointerRouter, type PointerHitEvent } from './pointer-router';
import { createSample, PadCursor, type PointerSample, type PointerSource } from './pointer-sources';
import { aabbTester, planeTester, type RayBox } from './rays';
import type { GamepadLike } from './types';

/** Two 2D quads (100 px squares) and the plane z = 0 behind them. */
function setup() {
  const camera = Camera.ortho2d(800, 600);
  const quads: RayBox<string>[] = [
    { min: [100, 100, 0], max: [200, 200, 0], target: 'a' },
    { min: [300, 100, 0], max: [400, 200, 0], target: 'b' },
  ];
  const router = createPointerRouter<string | null>({
    camera,
    testers: [aabbTester(quads)],
  });
  const log: string[] = [];
  const rec = (kind: string) => (e: PointerHitEvent<string | null>) =>
    log.push(`${kind}:${e.pointer.device}:${e.hit?.target ?? '-'}`);
  router.on('hit', rec('hit'));
  router.on('hitEnd', rec('hitEnd'));
  router.on('select', rec('select'));
  router.on('secondary', rec('secondary'));
  return { camera, quads, router, log };
}

describe('PointerRouter: mouse', () => {
  it('hovers: hit on enter, hitEnd on leave, nothing while it stays', () => {
    const { router, log } = setup();
    router.screen.pointerMove(1, 150, 150);
    router.update();
    expect(log).toEqual(['hit:mouse:a']);
    expect(router.hit?.target).toBe('a');
    expect(router.hit?.point[0]).toBeCloseTo(150);
    router.screen.pointerMove(1, 160, 150);
    router.update();
    expect(log).toEqual(['hit:mouse:a']);
    expect(router.hit?.point[0]).toBeCloseTo(160);
    router.screen.pointerMove(1, 350, 150);
    router.update();
    expect(log).toEqual(['hit:mouse:a', 'hitEnd:mouse:a', 'hit:mouse:b']);
    router.screen.pointerMove(1, 250, 150);
    router.update();
    expect(log.at(-1)).toBe('hitEnd:mouse:b');
    expect(router.hit).toBeNull();
    expect(router.pointers.length).toBe(1);
    router.screen.pointerLeave(1);
    router.update();
    router.update();
    expect(router.pointers.length).toBe(0);
  });

  it('select fires on the button edge (unlinked), with the hit', () => {
    const { router, log } = setup();
    router.screen.pointerMove(1, 150, 150);
    router.update();
    router.screen.pointerDown(1, 150, 150, 'mouse', 0);
    router.update();
    expect(log.at(-1)).toBe('select:mouse:a');
    expect(router.held('select')).toBe(true);
    router.update();
    expect(log.filter((l) => l.startsWith('select'))).toHaveLength(1);
    router.screen.pointerUp(1, 150, 150, 0);
    router.screen.pointerDown(1, 150, 150, 'mouse', 2);
    router.update();
    expect(log.at(-1)).toBe('secondary:mouse:a');
    expect(router.held('select')).toBe(false);
  });

  it('a click between two ticks still selects', () => {
    const { router, log } = setup();
    router.screen.pointerDown(1, 350, 150);
    router.screen.pointerUp(1, 350, 150);
    router.update();
    expect(log).toEqual(['hit:mouse:b', 'select:mouse:b']);
  });

  it('select on nothing reports a null hit', () => {
    const { router, log } = setup();
    router.screen.pointerDown(1, 600, 500);
    router.update();
    expect(log).toEqual(['select:mouse:-']);
  });

  it('the plane tester under the quads catches everything else; the nearest wins', () => {
    const { router, log } = setup();
    // A plane behind the quads (z = 1 is further along +z in ortho2d).
    router.addTester(planeTester(1, null));
    router.screen.pointerMove(1, 600, 500);
    router.update();
    expect(router.hit?.target).toBeNull();
    expect(router.hit?.point).toEqual([600, 500, 1]);
    router.screen.pointerMove(1, 150, 150);
    router.update();
    expect(router.hit?.target).toBe('a');
    expect(log).toEqual(['hit:mouse:-', 'hitEnd:mouse:-', 'hit:mouse:a']);
  });

  it('the transform maps client px to screen units; null is off screen', () => {
    const { router } = setup();
    router.setPointerTransform((x, y) => (x < 0 ? null : { x: x / 2, y: y / 2 }));
    router.screen.pointerMove(1, 300, 300);
    router.update();
    expect(router.hit?.target).toBe('a');
    router.screen.pointerMove(1, -5, 300);
    router.update();
    expect(router.pointers.length).toBe(0);
  });

  it('removing a tester stops its hits', () => {
    const { camera } = setup();
    const router = createPointerRouter({ camera });
    const off = router.addTester(planeTester());
    router.screen.pointerMove(1, 10, 10);
    router.update();
    expect(router.hit).not.toBeNull();
    off();
    router.update();
    expect(router.hit).toBeNull();
  });

  it('no camera, no screen pointers', () => {
    const router = createPointerRouter({ testers: [planeTester()] });
    router.screen.pointerMove(1, 10, 10);
    router.update();
    expect(router.pointers.length).toBe(0);
    let cam: Camera | null = null;
    router.camera = () => cam;
    router.update();
    expect(router.pointers.length).toBe(0);
    cam = Camera.ortho2d(100, 100);
    router.screen.pointerMove(1, 10, 10);
    router.update();
    expect(router.hit?.point[0]).toBeCloseTo(10);
  });
});

describe('PointerRouter: touch', () => {
  it('a touch is a pointer while down and for one tick after it lifts', () => {
    const { router, log } = setup();
    router.screen.pointerMove(5, 150, 150, 'touch');
    router.update();
    expect(router.pointers.length).toBe(0);
    router.screen.pointerDown(5, 150, 150, 'touch');
    router.update();
    expect(log).toEqual(['hit:touch:a', 'select:touch:a']);
    router.screen.pointerMove(5, 350, 150, 'touch');
    router.update();
    router.screen.pointerUp(5, 350, 150);
    router.update();
    // The lift tick still has the pointer (a tap bound to select sees its hit) …
    expect(router.pointers.length).toBe(1);
    expect(router.held('select')).toBe(false);
    expect(router.hit?.target).toBe('b');
    router.update();
    // … then it ends.
    expect(router.pointers.length).toBe(0);
    expect(log.at(-1)).toBe('hitEnd:touch:b');
  });

  it('a cancelled touch ends without its last tick', () => {
    const { router, log } = setup();
    router.screen.pointerDown(5, 150, 150, 'touch');
    router.update();
    router.screen.pointerCancel(5);
    router.update();
    expect(router.pointers.length).toBe(0);
    expect(log.at(-1)).toBe('hitEnd:touch:a');
  });

  it('two touches are two pointers; primary is the latest to act', () => {
    const { router } = setup();
    router.screen.pointerDown(1, 150, 150, 'touch');
    router.update();
    router.screen.pointerDown(2, 350, 150, 'touch');
    router.update();
    expect(router.pointers.length).toBe(2);
    expect(router.primary?.key).toBe(2);
    expect(router.hit?.target).toBe('b');
    router.screen.pointerMove(1, 160, 150, 'touch');
    router.update();
    expect(router.primary?.key).toBe(1);
  });

  it('with magnify, a single touch points at the snapped aim, not the finger', () => {
    const { router } = setup();
    let t = 0;
    const gestures = new Gestures({
      now: () => t,
      magnify: {
        pitch: () => 20,
        snap: () => ({ x: 350, y: 150, r: 10 }),
      },
    });
    const input = new Input({}, { gestures, getGamepads: () => [] });
    input.setPointers(router);
    gestures.pointerDown(1, 150, 150, 'touch', t);
    router.screen.pointerDown(1, 150, 150, 'touch');
    t += 16;
    input.update();
    expect(gestures.aim).not.toBeNull();
    expect(router.hit?.target).toBe('b');
  });
});

describe('PointerRouter: blocked', () => {
  it('ends every hit, reports nothing, and a press held through the block does not fire', () => {
    const { router, log } = setup();
    let blocked = false;
    router.blocked = () => blocked;
    router.screen.pointerMove(1, 150, 150);
    router.update();
    blocked = true;
    router.screen.pointerDown(1, 150, 150);
    router.update();
    expect(log).toEqual(['hit:mouse:a', 'hitEnd:mouse:a']);
    expect(router.pointers.length).toBe(0);
    expect(router.fired('select')).toBe(false);
    // Raw, like Input's keys: the press is still tracked.
    expect(router.held('select')).toBe(true);
    router.update();
    blocked = false;
    router.update();
    expect(log).toEqual(['hit:mouse:a', 'hitEnd:mouse:a', 'hit:mouse:a']);
    expect(router.fired('select')).toBe(false);
  });
});

describe('PointerRouter linked to Input', () => {
  function linked() {
    const s = setup();
    const input = new Input(
      {
        select: [{ pointer: 'select' }, { key: 'Enter' }],
        alt: [{ pointer: 'secondary' }],
        grip: [{ xr: 'squeeze', hand: 'left' }],
      },
      { getGamepads: () => [] },
    );
    input.setPointers(s.router);
    return { ...s, input };
  }

  it('{ pointer: "select" } presses the action; select fires once on the primary', () => {
    const { router, input, log } = linked();
    router.screen.pointerDown(1, 150, 150);
    input.update();
    expect(input.pressed('select')).toBe(true);
    expect(log).toEqual(['hit:mouse:a', 'select:mouse:a']);
    input.update();
    expect(input.held('select')).toBe(true);
    expect(input.pressed('select')).toBe(false);
    router.screen.pointerUp(1, 150, 150);
    input.update();
    expect(input.released('select')).toBe(true);
  });

  it('a key bound to select selects what the pointer is on', () => {
    const { router, input, log } = linked();
    router.screen.pointerMove(1, 350, 150);
    input.update();
    input.keyDown('Enter');
    input.update();
    expect(log).toEqual(['hit:mouse:b', 'select:mouse:b']);
  });

  it('secondary is unbound as an action here, so it follows the button edge', () => {
    const { router, input, log } = linked();
    router.screen.pointerDown(1, 150, 150, 'mouse', 2);
    input.update();
    expect(input.pressed('alt')).toBe(true);
    expect(log.at(-1)).toBe('secondary:mouse:a');
  });

  it('shares blocked()', () => {
    const { router, input, log } = linked();
    let blocked = true;
    input.blocked = () => blocked;
    input.setPointers(null);
    input.setPointers(router);
    router.screen.pointerDown(1, 150, 150);
    input.update();
    expect(log).toEqual([]);
    blocked = false;
    input.update();
    expect(input.pressed('select')).toBe(false);
  });

  it('{ xr } bindings read XR samples from a source (the seam)', () => {
    const { router, input } = linked();
    const sample: PointerSample = createSample(0, 'xr');
    sample.hand = 'left';
    sample.xr = { trigger: false, squeeze: false, pinch: false };
    sample.ray.origin[0] = 150;
    sample.ray.origin[1] = 150;
    sample.ray.origin[2] = -5;
    const xr: PointerSource = { poll: () => [sample] };
    router.addSource(xr);
    input.update();
    expect(router.hit?.target).toBe('a');
    expect(router.primary?.device).toBe('xr');
    sample.xr.squeeze = true;
    input.update();
    expect(input.pressed('grip')).toBe(true);
    input.update();
    expect(input.held('grip')).toBe(true);
    expect(input.pressed('grip')).toBe(false);
    sample.hand = 'right';
    input.update();
    expect(input.held('grip')).toBe(false);
  });
});

describe('PadCursor', () => {
  function pad(axes: number[], pressed: number[] = []): GamepadLike {
    return {
      axes,
      buttons: Array.from({ length: 4 }, (_, i) => ({
        pressed: pressed.includes(i),
        value: pressed.includes(i) ? 1 : 0,
      })),
    };
  }

  it('appears at the screen centre on deflection and moves with the stick', () => {
    const { router, quads } = setup();
    let pads: GamepadLike[] = [pad([0, 0])];
    const cursor = new PadCursor({ getGamepads: () => pads, speed: 0.1 });
    router.addSource(cursor);
    router.update();
    expect(router.pointers.length).toBe(0);
    pads = [pad([1, 0])];
    router.update();
    // Centre (400, 300) plus one step of 0.1 × 600.
    expect(cursor.x).toBeCloseTo(460);
    expect(cursor.y).toBeCloseTo(300);
    expect(router.primary?.device).toBe('gamepad');
    // Clamped to the screen.
    for (let i = 0; i < 20; i++) router.update();
    expect(cursor.x).toBe(800);
    cursor.moveTo(150, 150);
    pads = [pad([0.1, 0])];
    router.update();
    expect(router.hit?.target).toBe('a');
    expect(quads.length).toBe(2);
  });

  it('its select button selects the hit; hide() ends it', () => {
    const { router, log } = setup();
    let pads: GamepadLike[] = [pad([0, 0])];
    const cursor = new PadCursor({ getGamepads: () => pads });
    router.addSource(cursor);
    cursor.moveTo(350, 150);
    router.update();
    pads = [pad([0, 0], [0])];
    router.update();
    expect(log).toEqual(['hit:gamepad:b', 'select:gamepad:b']);
    cursor.hide();
    pads = [pad([0, 0])];
    router.update();
    expect(router.pointers.length).toBe(0);
    expect(log.at(-1)).toBe('hitEnd:gamepad:b');
  });
});

describe('PointerRouter: perspective', () => {
  it('picks the nearest box through a perspective camera', () => {
    const camera = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
    camera.lookAt([0, 0, 10], [0, 0, 0]);
    camera.screen.width = 800;
    camera.screen.height = 800;
    const router = createPointerRouter({
      camera,
      testers: [
        aabbTester([
          { min: [-1, -1, -1], max: [1, 1, 1], target: 'front' },
          { min: [-3, -3, -9], max: [3, 3, -7], target: 'back' },
        ]),
      ],
    });
    router.screen.pointerMove(1, 400, 400);
    router.update();
    expect(router.hit?.target).toBe('front');
    expect(router.hit?.normal).toEqual([0, 0, 1]);
    // Off the front box but still on the bigger back one.
    router.screen.pointerMove(1, 400 + 120, 400);
    router.update();
    expect(router.hit?.target).toBe('back');
  });
});
