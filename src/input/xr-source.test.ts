/**
 * `XrPointerSource` on the fake XR session: input sources become pointer samples with rays from
 * their target-ray poses, trigger and squeeze from the gamepad or the session's events, pinch
 * from the hand's joints with hysteresis, nothing outside a frame, and the router routes them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeXr,
  FakeXrInputSource,
  type FakeXrSession,
  installFakeXr,
} from '../platform/xr-fake';
import type { XRFrame, XRReferenceSpace } from '../platform/xr-types';
import { Camera } from '../render/camera';
import { createPointerRouter, type PointerHitEvent } from './pointer-router';
import { planeTester } from './rays';
import { XrPointerSource } from './xr-source';

let xr: FakeXr | null = null;

afterEach(() => {
  xr?.uninstall();
  xr = null;
});

async function setup() {
  xr = installFakeXr();
  const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
  const referenceSpace = await session.requestReferenceSpace('local-floor');
  // The frame running now, as an XR host would hold it; null between frames.
  let frame: XRFrame | null = null;
  const source = new XrPointerSource(session, referenceSpace, () => frame);
  session.requestAnimationFrame(function keep(_t, f) {
    frame = f;
    session.requestAnimationFrame(keep);
  });
  /** Poll inside a frame, as the host would. */
  const poll = () => {
    const f = xr!.step();
    frame = f;
    const out = source.poll(null);
    frame = null;
    return out;
  };
  return { session, referenceSpace, source, poll, xr };
}

describe('XrPointerSource', () => {
  it('reports nothing outside a frame and a pointer per input source inside one', async () => {
    const { session, source, poll } = await setup();
    expect(source.poll(null)).toEqual([]);
    const right = new FakeXrInputSource('right');
    right.position = [0.2, 1.2, -0.3];
    session.addInputSource(right);
    session.addInputSource(new FakeXrInputSource('left'));
    const out = poll();
    expect(out.length).toBe(2);
    const s = out[0]!;
    expect(s.device).toBe('xr');
    expect(s.hand).toBe('right');
    expect(out[1]!.hand).toBe('left');
    expect(s.x).toBeNaN();
    expect(s.y).toBeNaN();
    expect(s.ray.origin[0]).toBeCloseTo(0.2);
    expect(s.ray.origin[1]).toBeCloseTo(1.2);
    expect(s.ray.origin[2]).toBeCloseTo(-0.3);
    expect([...s.ray.dir]).toEqual([-0, -0, -1]);
    expect(s.select).toBe(false);
    expect(s.secondary).toBe(false);
    expect(s.xr).toEqual({ trigger: false, squeeze: false, pinch: false });
    expect(source.poll(null)).toEqual([]);
  });

  it('keys are stable per source and reused, and a removed source stops appearing', async () => {
    const { session, poll } = await setup();
    const a = new FakeXrInputSource('right');
    const b = new FakeXrInputSource('left');
    session.addInputSource(a);
    session.addInputSource(b);
    const first = poll();
    const keyA = first[0]!.key;
    const keyB = first[1]!.key;
    expect(keyA).not.toBe(keyB);
    const again = poll();
    expect(again[0]).toBe(first[0]);
    expect(again[0]!.key).toBe(keyA);
    session.removeInputSource(a);
    const after = poll();
    expect(after.length).toBe(1);
    expect(after[0]!.key).toBe(keyB);
    session.addInputSource(a);
    expect(poll().map((s) => s.key)).not.toContain(keyA);
  });

  it('trigger and squeeze come from the gamepad: select and secondary', async () => {
    const { session, poll } = await setup();
    const src = new FakeXrInputSource('right');
    session.addInputSource(src);
    src.buttons[0]!.pressed = true;
    let s = poll()[0]!;
    expect(s.xr).toEqual({ trigger: true, squeeze: false, pinch: false });
    expect(s.select).toBe(true);
    expect(s.secondary).toBe(false);
    src.buttons[0]!.pressed = false;
    src.buttons[1]!.pressed = true;
    s = poll()[0]!;
    expect(s.xr).toEqual({ trigger: false, squeeze: true, pinch: false });
    expect(s.select).toBe(false);
    expect(s.secondary).toBe(true);
  });

  it('without a gamepad, select and squeeze events drive the buttons', async () => {
    const { session, poll, source } = await setup();
    const src = new FakeXrInputSource('left', { gamepad: false });
    session.addInputSource(src);
    session.fire('select', src, true);
    expect(poll()[0]!.select).toBe(true);
    session.fire('select', src, false);
    session.fire('squeeze', src, true);
    let s = poll()[0]!;
    expect(s.select).toBe(false);
    expect(s.secondary).toBe(true);
    session.fire('squeeze', src, false);
    expect(poll()[0]!.secondary).toBe(false);
    // Detached: events are ignored and the pointer is forgotten.
    source.detach();
    session.fire('select', src, true);
    source.attach();
    s = poll()[0]!;
    expect(s.select).toBe(false);
  });

  it('pinch: index tip to thumb tip under 2 cm starts, over 3.5 cm ends', async () => {
    const { session, poll } = await setup();
    const src = new FakeXrInputSource('right', { hand: true });
    session.addInputSource(src);
    const hand = src.hand!;
    hand.joints.set('thumb-tip', [0, 1, 0]);
    hand.joints.set('index-finger-tip', [0.05, 1, 0]);
    expect(poll()[0]!.xr!.pinch).toBe(false);
    hand.joints.set('index-finger-tip', [0.015, 1, 0]);
    let s = poll()[0]!;
    expect(s.xr!.pinch).toBe(true);
    expect(s.select).toBe(true);
    // Still pinching at 3 cm (hysteresis), released at 4 cm.
    hand.joints.set('index-finger-tip', [0.03, 1, 0]);
    expect(poll()[0]!.xr!.pinch).toBe(true);
    hand.joints.set('index-finger-tip', [0.04, 1, 0]);
    s = poll()[0]!;
    expect(s.xr!.pinch).toBe(false);
    expect(s.select).toBe(false);
  });

  it('a source without a pose this frame is skipped', async () => {
    const { session, poll, xr } = await setup();
    session.addInputSource(new FakeXrInputSource('right'));
    session.tracking = false; // the viewer pose only; rays still resolve
    expect(poll().length).toBe(1);
    // A reference space the session does not know: no poses, no pointers.
    const f = xr.step();
    const strange = new XrPointerSource(session, {} as XRReferenceSpace, () => f);
    expect(strange.poll(null).length).toBe(0);
    strange.detach();
  });

  it('routes through the pointer router: hit and select on a wall at z = -2', async () => {
    const { session, source, xr } = await setup();
    const camera = Camera.perspective(1, 1, 0.1, 100);
    const router = createPointerRouter<string | null>({
      camera,
      testers: [planeTester(-2, 'wall')],
    });
    const log: string[] = [];
    const rec = (kind: string) => (e: PointerHitEvent<string | null>) =>
      log.push(`${kind}:${e.pointer.device}:${e.pointer.hand}:${e.hit?.target ?? '-'}`);
    router.on('hit', rec('hit'));
    router.on('select', rec('select'));
    const off = router.addSource(source);
    const src = new FakeXrInputSource('right');
    session.addInputSource(src);
    // The router polls its sources from inside the frame callback, as the loop does.
    const tick = () => {
      session.requestAnimationFrame(() => router.update());
      xr.step();
    };
    tick();
    expect(log).toEqual(['hit:xr:right:wall']);
    expect(router.hit?.point[2]).toBeCloseTo(-2);
    expect(router.hit?.point[1]).toBeCloseTo(1);
    src.buttons[0]!.pressed = true;
    tick();
    expect(log).toEqual(['hit:xr:right:wall', 'select:xr:right:wall']);
    off();
    tick();
    expect(router.pointers.length).toBe(0);
  });
});
