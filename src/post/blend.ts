import { type Ease, ease } from '../tween/ease';
import type { PostSettings, PostSettingsPatch } from './settings';

// The easing functions live in `@thunderclap/engine/tween`; these names stay as aliases.
export type { Ease };
export const easeLinear: Ease = ease.linear;
/** Smoothstep: gentle start and end. The default for `blendTo`. */
export const easeInOut: Ease = ease.smoothstep;
export const easeOut: Ease = ease.quadOut;
export const easeIn: Ease = ease.quadIn;

type Section = keyof PostSettings;
type Value = number | number[];

interface Track {
  section: Section;
  key: string;
  from: Value;
  to: Value;
  /** Non-numeric values (booleans, tonemap, integer `levels`) applied when the track ends. */
  snap: boolean;
  elapsed: number;
  seconds: number;
  ease: Ease;
}

/**
 * Fields that only make sense as whole values, by `section.key`: `bloom.levels` would resize
 * mid-blend, `lut.texture` is a handle and `lut.size` must match it, `motionBlur.mode` is a
 * choice. They switch when the blend ends (any other non-number does too).
 */
const SNAP_KEYS = new Set(['bloom.levels', 'lut.texture', 'lut.size', 'motionBlur.mode']);

/**
 * Interpolates post settings over time. Numbers and RGB triples ease from their value when
 * `blendTo` is called; everything else switches at once (`enabled: true`, so a pass can fade
 * in) or at the end (`enabled: false`, `tonemap`, `dither`, `levels`, so a pass can fade out).
 * Pure: no GPU, no clock. `PostStack` advances it with the frame time.
 */
export class PostBlender {
  private tracks: Track[] = [];

  /** True while any value is still moving. */
  get active(): boolean {
    return this.tracks.length > 0;
  }

  blendTo(target: PostSettings, patch: PostSettingsPatch, seconds: number, ease: Ease): void {
    const dur = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    for (const name of Object.keys(patch) as Section[]) {
      const src = patch[name] as Record<string, unknown> | undefined;
      if (!src) continue;
      const section = name;
      const cur = target[section] as unknown as Record<string, unknown>;
      for (const key of Object.keys(src)) {
        const to = src[key];
        if (to === undefined) continue;
        this.drop(section, key);
        const from = cur[key];
        const numeric =
          !SNAP_KEYS.has(`${section}.${key}`) &&
          ((typeof to === 'number' && typeof from === 'number') ||
            (Array.isArray(to) && Array.isArray(from) && to.length === from.length));
        if (!numeric) {
          // Turning something on happens first so its values can ease in; the rest waits.
          if (to === true || dur === 0) {
            cur[key] = to;
            continue;
          }
        }
        if (dur === 0) {
          cur[key] = Array.isArray(to) ? [...to] : to;
          continue;
        }
        // Own the array we animate in place (it may be a preset object shared via `set`).
        if (numeric && Array.isArray(from)) cur[key] = [...from];
        this.tracks.push({
          section,
          key,
          from: Array.isArray(from) ? [...(from as number[])] : (from as Value),
          to: Array.isArray(to) ? [...(to as number[])] : (to as Value),
          snap: !numeric,
          elapsed: 0,
          seconds: dur,
          ease,
        });
      }
    }
  }

  /** Stop blending the given keys (e.g. after `set` overwrote them). */
  cancel(patch: PostSettingsPatch): void {
    if (!this.tracks.length) return;
    for (const name of Object.keys(patch) as Section[]) {
      const src = patch[name];
      if (!src) continue;
      for (const key of Object.keys(src)) this.drop(name, key);
    }
  }

  /** Jump every track to its end value. */
  finish(target: PostSettings): void {
    for (const t of this.tracks) t.elapsed = t.seconds;
    this.advance(target, 0);
  }

  /** Move every track forward by `dt` seconds and write the values into `target`. */
  advance(target: PostSettings, dt: number): void {
    const tracks = this.tracks;
    let w = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]!;
      t.elapsed += Math.max(0, dt);
      const p = Math.min(1, t.elapsed / t.seconds);
      const cur = target[t.section] as unknown as Record<string, unknown>;
      if (t.snap) {
        if (p >= 1) cur[t.key] = t.to;
      } else {
        const k = t.ease(p);
        if (typeof t.to === 'number') {
          const a = t.from as number;
          cur[t.key] = p >= 1 ? t.to : a + (t.to - a) * k;
        } else {
          const out = cur[t.key] as number[];
          const a = t.from as number[];
          const b = t.to;
          for (let j = 0; j < b.length; j++) out[j] = p >= 1 ? b[j]! : a[j]! + (b[j]! - a[j]!) * k;
        }
      }
      if (p < 1) tracks[w++] = t;
    }
    tracks.length = w;
  }

  private drop(section: Section, key: string): void {
    const tracks = this.tracks;
    let w = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]!;
      if (t.section !== section || t.key !== key) tracks[w++] = t;
    }
    tracks.length = w;
  }
}
