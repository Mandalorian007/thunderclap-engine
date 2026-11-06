/**
 * Gyro aim (ws/input-5): the device's rotation rate (`devicemotion`'s `rotationRate`) turned into
 * a look delta, so a phone aims by turning it. Feature-detected; `Look` adds it to the pointer
 * and stick delta each tick when given one (`LookOptions.gyro`). iOS asks the player first:
 * call `requestPermission()` from a tap.
 */

/** `GyroSource.requestPermission` result; `'prompt'` is `permission` before it is asked. */
export type GyroPermission = 'granted' | 'denied' | 'unavailable';

/** The slice of `DeviceMotionEvent` the source reads. */
export interface GyroMotionEvent {
  /** Degrees per second about the device's z (`alpha`), x (`beta`) and y (`gamma`) axes. */
  rotationRate?: { alpha?: number | null; beta?: number | null; gamma?: number | null } | null;
  /** Ms between events, as the browser reports it. */
  interval?: number;
  timeStamp?: number;
}

/** Where the source listens (tests and the harness pass a fake). Default: the page's window. */
export interface GyroEnv {
  /** Fires `devicemotion`. `null`: no API. */
  target: {
    addEventListener(type: 'devicemotion', fn: (e: GyroMotionEvent) => void): void;
    removeEventListener(type: 'devicemotion', fn: (e: GyroMotionEvent) => void): void;
  } | null;
  /** `DeviceMotionEvent.requestPermission` where the platform has it (iOS 13+). */
  requestPermission?: () => Promise<string>;
  /** Screen rotation in degrees (`screen.orientation.angle`): 0, 90, 180 or 270. */
  screenAngle?: () => number;
}

export interface GyroSourceOptions {
  /** Look radians per radian the device turns. Default 1. */
  sensitivity?: number;
  /** Flip the pitch (the gyro's own; `Look.invertY` does not apply to it). Default false. */
  invertY?: boolean;
  /** 0..1 low-pass on each tick's delta: 0 none, 0.5 halves a jolt. Default 0. */
  smoothing?: number;
  /** The event source. Default the page's `window` and `DeviceMotionEvent`. */
  env?: GyroEnv;
}

export interface GyroSource {
  /** While false the rotation is dropped and `take` reads zero. Default true. */
  enabled: boolean;
  sensitivity: number;
  invertY: boolean;
  smoothing: number;
  /** True when the platform has the motion API at all. */
  readonly available: boolean;
  /** True once a motion event with a rotation rate arrived (desktops have the API, no sensor). */
  readonly receiving: boolean;
  /** `'prompt'` until `requestPermission` settles. */
  readonly permission: GyroPermission | 'prompt';
  /**
   * Ask for the sensor: `'unavailable'` without the API, the player's answer where the platform
   * asks (iOS; call it from a tap), `'granted'` where it does not. Never rejects.
   */
  requestPermission(): Promise<GyroPermission>;
  /**
   * The turn since the last `take`, radians (`dx` > 0 turns right, `dy` > 0 looks up, as
   * `Look.look`), smoothed; resets the accumulator. Writes `out` and returns it. `Look` calls it.
   */
  take(out: { dx: number; dy: number }): { dx: number; dy: number };
  /**
   * Add a rotation rate (degrees per second about the device's z, x and y axes, as
   * `rotationRate.alpha/beta/gamma`) held for `ms`. The event listener calls it; tests and the
   * harness feed it directly.
   */
  feed(alpha: number, beta: number, gamma: number, ms: number): void;
  /** Stop listening. */
  dispose(): void;
}

/** Longest gap one event integrates over, ms (a stalled sensor must not jump the view). */
const MAX_EVENT_MS = 100;
const DEG = Math.PI / 180;

function defaultEnv(): GyroEnv {
  if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
    return { target: null };
  }
  const ctor = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
  return {
    target: window as unknown as GyroEnv['target'],
    requestPermission:
      typeof ctor.requestPermission === 'function' ? () => ctor.requestPermission!() : undefined,
    screenAngle: () =>
      (typeof screen !== 'undefined' && screen.orientation?.angle) ||
      // Old iOS Safari.
      Number((window as unknown as { orientation?: number }).orientation ?? 0),
  };
}

/**
 * Build a gyro source. It listens at once (where the platform needs permission, events start
 * after `requestPermission` is granted). Rotation about the screen's vertical axis yaws, about
 * its horizontal axis pitches, following `screen.orientation.angle`.
 */
export function createGyroSource(opts: GyroSourceOptions = {}): GyroSource {
  const env = opts.env ?? defaultEnv();
  const target = env.target;
  let yaw = 0;
  let pitch = 0;
  let sx = 0;
  let sy = 0;
  let lastStamp = Number.NaN;
  let receiving = false;
  let permission: GyroPermission | 'prompt' = target ? 'prompt' : 'unavailable';

  const onMotion = (e: GyroMotionEvent): void => {
    const r = e.rotationRate;
    if (!r) return;
    receiving = true;
    let ms: number;
    const stamp = e.timeStamp;
    if (stamp !== undefined && !Number.isNaN(lastStamp)) ms = stamp - lastStamp;
    else {
      // Some browsers have reported `interval` in seconds.
      const iv = e.interval ?? 16;
      ms = iv > 0 && iv < 1 ? iv * 1000 : iv;
    }
    if (stamp !== undefined) lastStamp = stamp;
    src.feed(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0, ms);
  };

  const src: GyroSource = {
    enabled: true,
    sensitivity: opts.sensitivity ?? 1,
    invertY: opts.invertY ?? false,
    smoothing: opts.smoothing ?? 0,
    get available() {
      return target !== null;
    },
    get receiving() {
      return receiving;
    },
    get permission() {
      return permission;
    },
    async requestPermission() {
      if (!target) {
        permission = 'unavailable';
        return permission;
      }
      if (!env.requestPermission) {
        permission = 'granted';
        return permission;
      }
      try {
        const r = await env.requestPermission();
        permission = r === 'granted' ? 'granted' : 'denied';
      } catch {
        // Not inside a user gesture, or refused.
        permission = 'denied';
      }
      return permission;
    },
    feed(_alpha, beta, gamma, ms) {
      if (!src.enabled) return;
      const s = Math.min(MAX_EVENT_MS, Math.max(0, ms)) / 1000;
      // Device axes: x right, y up, z out of the screen. Turning to aim right is a negative turn
      // about the screen's up axis; tilting the top away (aim up) a positive one about its right.
      const angle = (((env.screenAngle?.() ?? 0) % 360) + 360) % 360;
      let up: number;
      let right: number;
      if (angle === 90) {
        up = beta;
        right = -gamma;
      } else if (angle === 180) {
        up = -gamma;
        right = -beta;
      } else if (angle === 270) {
        up = -beta;
        right = gamma;
      } else {
        up = gamma;
        right = beta;
      }
      yaw += 0 - up * s * DEG;
      pitch += right * s * DEG;
    },
    take(out) {
      const k = src.sensitivity;
      let dx = src.enabled ? yaw * k : 0;
      let dy = src.enabled ? pitch * k * (src.invertY ? -1 : 1) : 0;
      yaw = pitch = 0;
      const a = Math.min(1, Math.max(0, src.smoothing));
      if (a > 0) {
        dx = sx * a + dx * (1 - a);
        dy = sy * a + dy * (1 - a);
      }
      sx = dx;
      sy = dy;
      // `+ 0` keeps a still gyro at +0 under invertY.
      out.dx = dx + 0;
      out.dy = dy + 0;
      return out;
    },
    dispose() {
      target?.removeEventListener('devicemotion', onMotion);
    },
  };
  target?.addEventListener('devicemotion', onMotion);
  return src;
}
