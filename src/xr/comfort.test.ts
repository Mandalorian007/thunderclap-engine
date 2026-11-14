/**
 * Comfort (ws/xr-merge, from Forge Wilds' XR1 and XR2): corrections eased out of the eye, the
 * vignette and fades, the speed limits, the controller responses, and none of it allocating per
 * frame.
 */
import { describe, expect, it } from 'vitest';
import {
  EASE_TAU_S,
  JUMP_FADE_MS,
  SNAP_BLINK,
  SpeedLimit,
  VIGNETTE_DEFAULT,
  ViewEase,
  Vignette,
} from './comfort';
import { ControllerPose, layoutOf, type ProfileJson } from './controller';
import { HeightCalibration } from './height';
import { createPads, readPads } from './pads';
import { HeadPivot } from './pivot';
import { XrSticks } from './sticks';

describe('ViewEase', () => {
  it('a correction is taken out of the eye and given back over ~tau', () => {
    const e = new ViewEase();
    const body = { corrections: 0, resets: 0 };
    e.frame([0, 1.6, 0], body, 0);
    // The body is pushed 0.2 m in x by a correction.
    const pushed = { corrections: 1, resets: 0 };
    let out = e.frame([0.2, 1.6, 0], pushed, 16);
    expect(out[0]).toBeCloseTo(0, 9);
    expect(e.eased).toBe(1);
    // After one tau, about 1/e of it is left.
    out = e.frame([0.2, 1.6, 0], pushed, 16 + EASE_TAU_S * 1000);
    expect(0.2 - out[0]).toBeCloseTo(0.2 / Math.E, 6);
    for (let t = 200; t < 2000; t += 16) out = e.frame([0.2, 1.6, 0], pushed, t);
    expect(out[0]).toBeCloseTo(0.2, 6);
  });

  it("the body's own moves aren't eased; a teleport or a reset snaps and counts a jump", () => {
    const e = new ViewEase();
    e.frame([0, 0, 0], { corrections: 0, resets: 0 }, 0);
    expect(e.frame([0.1, 0, 0], { corrections: 0, resets: 0 }, 16)[0]).toBe(0.1);
    expect(e.frame([10, 0, 0], { corrections: 1, resets: 0 }, 32)[0]).toBe(10);
    expect(e.jumps).toBe(1);
    expect(e.frame([11, 0, 0], { corrections: 1, resets: 1 }, 48)[0]).toBe(11);
    expect(e.jumps).toBe(2);
    // Free (flying): nothing eased.
    expect(e.frame([11.5, 0, 0], { corrections: 2, resets: 1, free: true }, 64)[0]).toBe(11.5);
  });
});

describe('Vignette', () => {
  it('closes as the body moves, opens after; a snap blinks; a jump fades from black', () => {
    const v = new Vignette();
    for (let i = 0; i < 60; i++) v.frame(1, 0, 1 / 60);
    expect(v.edge).toBeCloseTo(VIGNETTE_DEFAULT, 3);
    for (let i = 0; i < 120; i++) v.frame(0, 0, 1 / 60);
    expect(v.edge).toBe(0);
    v.snapped();
    expect(v.fade).toBe(SNAP_BLINK);
    v.frame(0, 0, 0.2);
    expect(v.fade).toBe(0);
    v.frame(0, 1, 0);
    expect(v.fade).toBe(1);
    v.frame(0, 1, JUMP_FADE_MS / 2000);
    expect(v.fade).toBeCloseTo(0.5, 6);
    // Off: no edge, no blink; a jump still fades.
    v.strength = 0;
    v.reset();
    v.frame(1, 0, 1);
    v.snapped();
    expect(v.edge).toBe(0);
    expect(v.fade).toBe(0);
    v.jumped();
    expect(v.fade).toBe(1);
    v.held = { edge: 0.3, fade: 0.2 };
    v.frame(0, 0, 1);
    expect([v.edge, v.fade]).toEqual([0.3, 0.2]);
  });
});

describe('SpeedLimit', () => {
  it('caps the speed, the acceleration and the turn rate', () => {
    const s = new SpeedLimit({ maxSpeed: 2, maxAccel: 4, maxTurnDegS: 90 });
    let out = s.move(10, 0, 0.25);
    expect(out[0]).toBeCloseTo(1, 9);
    out = s.move(10, 0, 0.25);
    expect(out[0]).toBeCloseTo(2, 9);
    out = s.move(10, 0, 1);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(2, 9);
    out = s.move(0, 0, 0.25);
    expect(out[0]).toBeCloseTo(1, 9);
    expect(s.turn(1, 0.5)).toBeCloseTo(Math.PI / 4, 9);
    expect(s.turn(-1, 0.5)).toBeCloseTo(-Math.PI / 4, 9);
    expect(s.turn(0.1, 0.5)).toBe(0.1);
  });
});

const PROFILE: ProfileJson = {
  profileId: 'generic-trigger-squeeze-thumbstick',
  layouts: {
    right: {
      assetPath: 'right.glb',
      components: {
        'xr-standard-trigger': {
          gamepadIndices: { button: 0 },
          visualResponses: {
            pressed: {
              componentProperty: 'button',
              states: ['default', 'touched', 'pressed'],
              valueNodeProperty: 'transform',
              valueNodeName: 'trigger_value',
              minNodeName: 'trigger_min',
              maxNodeName: 'trigger_max',
            },
          },
        },
        'xr-standard-thumbstick': {
          gamepadIndices: { button: 3, xAxis: 2, yAxis: 3 },
          visualResponses: {
            xaxis: {
              componentProperty: 'xAxis',
              states: ['default', 'touched', 'pressed'],
              valueNodeProperty: 'transform',
              valueNodeName: 'stick_x',
              minNodeName: 'stick_xmin',
              maxNodeName: 'stick_xmax',
            },
            touch: {
              componentProperty: 'state',
              states: ['touched', 'pressed'],
              valueNodeProperty: 'visibility',
              valueNodeName: 'stick_dot',
            },
            missing: {
              componentProperty: 'button',
              states: ['pressed'],
              valueNodeProperty: 'transform',
              valueNodeName: 'nope',
            },
          },
        },
      },
    },
  },
};
const NODES = [
  'root',
  'trigger_value',
  'trigger_min',
  'trigger_max',
  'stick_x',
  'stick_xmin',
  'stick_xmax',
  'stick_dot',
];

describe('controller models', () => {
  it("a profile's layout against the model's nodes, posed by the pad", () => {
    const l = layoutOf(PROFILE, 'right', NODES);
    expect(l.responses).toHaveLength(3);
    expect(l.parts.trigger).toBe(1);
    expect(l.parts.stick).toBe(4);
    expect(l.parts.a).toBe(-1);
    const pose = new ControllerPose(l);
    pose.frame(null);
    expect([...pose.values]).toEqual([0, 0, 0]);
    const buttons = [0, 1, 2, 3].map(() => ({ pressed: false, value: 0 }));
    buttons[0] = { pressed: true, value: 1 };
    pose.frame({ buttons, axes: [0, 0, 1, 0] });
    expect([...pose.values]).toEqual([1, 1, 1]);
    expect(pose.moved).toBe(1);
    expect([...pose.hidden]).toEqual([0, 0, 0]);
    buttons[0] = { pressed: false, value: 0 };
    pose.frame({ buttons, axes: [0, 0, 0, 0] });
    expect([...pose.values]).toEqual([0, 0.5, 0]);
    expect([...pose.hidden]).toEqual([0, 0, 1]);
    expect(() => layoutOf(PROFILE, 'left', NODES)).toThrow();
  });

  it('readPads sorts gamepads by hand; a tracked hand has none', () => {
    const p = { buttons: [], axes: [] };
    const out = createPads();
    readPads(
      [
        { handedness: 'right', gamepad: p, profiles: ['x'] },
        { handedness: 'left', gamepad: null },
      ],
      out,
    );
    expect(out.right).toBe(p);
    expect(out.rightProfiles).toEqual(['x']);
    expect(out.left).toBe(null);
  });
});

describe('allocation', () => {
  it('a frame of every piece allocates nothing', () => {
    const ease = new ViewEase();
    const vig = new Vignette();
    const speed = new SpeedLimit();
    const sticks = new XrSticks({ turn: 'smooth' });
    const height = new HeightCalibration(1.62);
    const pivot = new HeadPivot();
    const pose = new ControllerPose(layoutOf(PROFILE, 'right', NODES));
    const pads = createPads();
    const sources = [{ handedness: 'left', gamepad: null }];
    const eye = new Float64Array([0, 1.6, 0]);
    const body = { corrections: 0, resets: 0 };
    const buttons = [0, 1, 2, 3, 4, 5].map(() => ({ pressed: false, value: 0 }));
    const pad = { buttons, axes: [0, 0, 0.5, -0.7] };
    const blocked = () => false;
    const frame = (i: number) => {
      body.corrections = i >> 3;
      ease.frame(eye, body, i * 16);
      sticks.frame(pad, pad, 1 / 72);
      // Constants here: a double read in the test and passed to a call the VM doesn't inline is
      // boxed by the caller, which isn't the module's allocation.
      vig.frame(0.5, ease.jumps, 1 / 72);
      speed.move(0.3, -0.5, 1 / 72);
      speed.turn(0.02, 1 / 72);
      height.frame(1.5, i * 16);
      pivot.turn(eye, 0, 0.02, 0.1, 0.1, blocked);
      pivot.check(eye, blocked);
      pose.frame(pad);
      readPads(sources, pads);
    };
    const gc = (globalThis as { gc?: () => void }).gc;
    const heapDelta = () => {
      gc?.();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 2000; i++) frame(i);
      return process.memoryUsage().heapUsed - before;
    };
    // Warm up until the frame is optimized (the interpreter boxes numbers), then measure.
    for (let w = 0; w < 20; w++) heapDelta();
    // The least of a few runs: a GC or a deopt mid-run is noise, garbage every frame isn't.
    let least = Number.POSITIVE_INFINITY;
    for (let r = 0; r < 5; r++) least = Math.min(least, heapDelta());
    expect(least).toBeLessThan(16 * 1024);
  });
});
