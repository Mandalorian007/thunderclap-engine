import { describe, expect, it } from 'vitest';
import { createGyroSource, type GyroEnv, type GyroMotionEvent } from './gyro';
import { Look } from './look';

const DEG = Math.PI / 180;

function fakeEnv(extra: Partial<GyroEnv> = {}) {
  let fn: ((e: GyroMotionEvent) => void) | null = null;
  const env: GyroEnv = {
    target: {
      addEventListener: (_t, f) => {
        fn = f;
      },
      removeEventListener: (_t, f) => {
        if (fn === f) fn = null;
      },
    },
    ...extra,
  };
  return { env, fire: (e: GyroMotionEvent) => fn?.(e), listening: () => fn !== null };
}

describe('createGyroSource (ws/input-5)', () => {
  it('a rotation rate at a sensitivity gives the expected yaw and pitch', () => {
    const { env, fire } = fakeEnv();
    const g = createGyroSource({ env, sensitivity: 2 });
    expect(g.receiving).toBe(false);
    // 90 deg/s about the device's y (turning left) for 100 ms, then 45 deg/s tilting back.
    fire({ rotationRate: { alpha: 0, beta: 0, gamma: 90 }, interval: 100 });
    fire({ rotationRate: { alpha: 0, beta: 45, gamma: 0 }, interval: 100 });
    expect(g.receiving).toBe(true);
    const o = g.take({ dx: 0, dy: 0 });
    expect(o.dx).toBeCloseTo(-9 * DEG * 2);
    expect(o.dy).toBeCloseTo(4.5 * DEG * 2);
    expect(g.take({ dx: 0, dy: 0 })).toEqual({ dx: 0, dy: 0 });
  });

  it('uses event timestamps, reads interval in seconds, clamps a stall', () => {
    const { env, fire } = fakeEnv();
    const g = createGyroSource({ env });
    fire({ rotationRate: { gamma: -100 }, interval: 0.02 });
    expect(g.take({ dx: 0, dy: 0 }).dx).toBeCloseTo(2 * DEG);
    fire({ rotationRate: { gamma: -100 }, timeStamp: 1000 });
    fire({ rotationRate: { gamma: -100 }, timeStamp: 1010 });
    fire({ rotationRate: { gamma: -100 }, timeStamp: 6010 });
    // 16 ms default + 10 ms + a 5 s stall clamped to 100 ms.
    expect(g.take({ dx: 0, dy: 0 }).dx).toBeCloseTo(12.6 * DEG);
  });

  it('follows the screen angle; invertY, enabled and smoothing', () => {
    let angle = 90;
    const { env } = fakeEnv({ screenAngle: () => angle });
    const g = createGyroSource({ env });
    g.feed(0, 100, 0, 100);
    expect(g.take({ dx: 0, dy: 0 }).dx).toBeCloseTo(-10 * DEG);
    angle = 270;
    g.feed(0, 100, 0, 100);
    expect(g.take({ dx: 0, dy: 0 }).dx).toBeCloseTo(10 * DEG);
    angle = 180;
    g.feed(0, 100, 0, 100);
    expect(g.take({ dx: 0, dy: 0 }).dy).toBeCloseTo(-10 * DEG);
    g.invertY = true;
    g.feed(0, 100, 0, 100);
    expect(g.take({ dx: 0, dy: 0 }).dy).toBeCloseTo(10 * DEG);
    g.enabled = false;
    g.feed(0, 100, 0, 100);
    g.enabled = true;
    expect(g.take({ dx: 0, dy: 0 }).dy).toBe(0);
    g.invertY = false;
    angle = 0;
    g.smoothing = 0.5;
    g.feed(0, 100, 0, 100);
    expect(g.take({ dx: 0, dy: 0 }).dy).toBeCloseTo(5 * DEG);
    expect(g.take({ dx: 0, dy: 0 }).dy).toBeCloseTo(2.5 * DEG);
  });

  it("is 'unavailable' without the API; maps the iOS permission answer", async () => {
    const none = createGyroSource({ env: { target: null } });
    expect(none.available).toBe(false);
    expect(none.permission).toBe('unavailable');
    expect(await none.requestPermission()).toBe('unavailable');
    expect(await createGyroSource({ env: fakeEnv().env }).requestPermission()).toBe('granted');
    const yes = createGyroSource({
      env: fakeEnv({ requestPermission: async () => 'granted' }).env,
    });
    expect(yes.permission).toBe('prompt');
    expect(await yes.requestPermission()).toBe('granted');
    const no = createGyroSource({ env: fakeEnv({ requestPermission: async () => 'denied' }).env });
    expect(await no.requestPermission()).toBe('denied');
    const err = createGyroSource({
      env: fakeEnv({ requestPermission: () => Promise.reject(new Error('gesture')) }).env,
    });
    expect(await err.requestPermission()).toBe('denied');
    expect(err.permission).toBe('denied');
  });

  it('dispose stops listening; headless default env has no target', () => {
    const f = fakeEnv();
    const g = createGyroSource({ env: f.env });
    expect(f.listening()).toBe(true);
    g.dispose();
    expect(f.listening()).toBe(false);
    expect(createGyroSource().available).toBe(false);
  });

  it('Look adds the gyro to the stick and mouse look; blocked drops it', () => {
    let t = 1000;
    let blocked = false;
    const gyro = createGyroSource({ env: fakeEnv().env });
    const look = new Look({
      now: () => t,
      sensitivity: 0.01,
      gyro,
      blocked: () => blocked,
      getGamepads: () => [{ axes: [0, 0, 1, 0], buttons: [] }],
    });
    look.update();
    t += 100;
    gyro.feed(0, 0, -100, 100);
    look.mouseMove(10, 0);
    look.update();
    // Mouse 0.1 + gyro 10 deg + the right stick at full for 0.1 s.
    const stick = look.look.dx - 0.1 - 10 * DEG;
    expect(stick).toBeGreaterThan(0);
    t += 100;
    look.update();
    expect(look.look.dx).toBeCloseTo(stick);
    blocked = true;
    gyro.feed(0, 0, -100, 100);
    look.update();
    blocked = false;
    t += 100;
    look.update();
    expect(look.look.dx).toBeCloseTo(stick);
  });
});
