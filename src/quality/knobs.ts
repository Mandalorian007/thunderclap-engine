/**
 * Ready-made knobs (ws/intents-quality): a feature switched off, a value stepped between limits,
 * and dynamic resolution (the first knob an engine module offers).
 */
import type { DynamicResolution } from '../render/dynamic-resolution';
import type { Knob } from './governor';

/** A knob with one step: `apply(true)` sheds the feature, `apply(false)` brings it back. */
export function toggleKnob(name: string, apply: (shed: boolean) => void, cost?: number): Knob {
  let shed = false;
  return {
    name,
    cost,
    step(down) {
      if (shed === down) return false;
      shed = down;
      apply(down);
      return true;
    },
  };
}

export interface StepKnobOptions {
  name: string;
  /** The value now (read before each step). */
  get(): number;
  /** Applies a new value. */
  set(value: number): void;
  /** Its range; stepping down moves towards `min`. */
  min: number;
  max: number;
  /** Change per step. */
  step: number;
  cost?: number;
}

/** A knob over a number between `min` and `max` (a count, a distance, a scale), `step` at a time. */
export function stepKnob(o: StepKnobOptions): Knob {
  const eps = Math.abs(o.step) * 1e-6;
  return {
    name: o.name,
    cost: o.cost,
    step(down) {
      const v = o.get();
      if (down ? v <= o.min + eps : v >= o.max - eps) return false;
      const next = down ? Math.max(o.min, v - o.step) : Math.min(o.max, v + o.step);
      // Rounded so ten steps of 0.1 land on the limit, not a hair off it.
      o.set(Math.round(next * 1e9) / 1e9);
      return true;
    },
  };
}

export interface DynamicResolutionKnobOptions {
  /** Applies a new scale (`renderer.setResolution({ scale })`). */
  apply?: (scale: number) => void;
  /** Change per step. Default 0.1. */
  step?: number;
  /** Default `'resolution'`. */
  name?: string;
  /** Default 1. */
  cost?: number;
}

/**
 * Dynamic resolution as a governor knob, for a device with no GPU timestamps to feed
 * `DynamicResolution.sample` (WebKit): each step moves its scale one `step` between its
 * `minScale` and `maxScale` (`reset`, so its own history starts over) and applies it.
 */
export function dynamicResolutionKnob(
  dr: Pick<DynamicResolution, 'scale' | 'minScale' | 'maxScale' | 'reset'>,
  opts: DynamicResolutionKnobOptions = {},
): Knob {
  return stepKnob({
    name: opts.name ?? 'resolution',
    cost: opts.cost,
    get: () => dr.scale,
    set: (v) => {
      dr.reset(v);
      opts.apply?.(dr.scale);
    },
    min: dr.minScale,
    max: dr.maxScale,
    step: opts.step ?? 0.1,
  });
}
