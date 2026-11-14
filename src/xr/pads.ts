/**
 * A session's controllers by hand (ws/xr-merge): each hand's gamepad (`XrPad`) and its
 * profiles, read from `session.inputSources` into a reused object. A tracked hand (no gamepad)
 * and a side with no controller are null. Allocation-free after the first frame.
 */
import type { XrPad } from './sticks';

/** The part of an `XRInputSource` read here. */
export interface PadSource {
  readonly handedness: string;
  readonly gamepad?: XrPad | null;
  readonly profiles?: readonly string[];
}

/** Each hand's pad and profiles this frame. */
export interface XrPads {
  left: XrPad | null;
  right: XrPad | null;
  leftProfiles: readonly string[] | null;
  rightProfiles: readonly string[] | null;
}

/** Fresh, empty pads (both null). */
export function createPads(): XrPads {
  return { left: null, right: null, leftProfiles: null, rightProfiles: null };
}

/** Reads `sources` (a session's `inputSources`) into `out`. */
export function readPads(sources: ArrayLike<PadSource> | null | undefined, out: XrPads): XrPads {
  out.left = null;
  out.right = null;
  out.leftProfiles = null;
  out.rightProfiles = null;
  if (!sources) return out;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    const pad = s.gamepad ?? null;
    if (!pad) continue;
    if (s.handedness === 'left') {
      out.left = pad;
      out.leftProfiles = s.profiles ?? null;
    } else if (s.handedness === 'right') {
      out.right = pad;
      out.rightProfiles = s.profiles ?? null;
    }
  }
  return out;
}
