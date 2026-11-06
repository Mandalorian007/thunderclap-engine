/**
 * Audio sprites (ws/audio-4): one buffer, many named ranges. `audio.defineSprites(name, sheet)`
 * registers the sheet; `audio.play('name#clip')` then plays one range with the usual `Voice`
 * surface, and `audio.loop('name#clip')` loops it between its `loopPoints` (or the whole
 * range). This file is the pure part: the reference syntax, the range arithmetic and the JSON
 * sidecar shape. Nothing here touches a node.
 */

/** `[startMs, lengthMs]` of one clip inside the sheet's buffer. */
export type SpriteRange = readonly [startMs: number, lengthMs: number];

/** What `audio.defineSprites` takes. */
export interface SpriteSheet {
  /** The decoded buffer every clip is a range of. */
  buffer?: AudioBuffer;
  /**
   * Or a factory that produces it (the game's own fetch and decode, so the engine makes no
   * network call: a bundle `audio` entry, `fetch` + `decodeAudioData`). Rendered lazily, or by
   * `audio.prepare`.
   */
  source?: () => Promise<AudioBuffer>;
  /** Clip name → `[startMs, lengthMs]`. */
  sprites: Readonly<Record<string, SpriteRange>>;
  /**
   * Clip name → `[startMs, endMs]` inside the clip, the section `audio.loop('name#clip')` repeats
   * once it has played into it (an intro before a loop). A clip without one loops its whole range.
   */
  loopPoints?: Readonly<Record<string, readonly [startMs: number, endMs: number]>>;
}

/**
 * The JSON sidecar a sprite packer writes next to its audio file: `src` names the audio file
 * (relative to the sidecar), `sprites` and `loopPoints` are as in `SpriteSheet`. Load it as a
 * bundle `json` entry and the audio as an `audio` entry, then `spriteSheetFrom(sidecar, buffer)`.
 */
export interface SpriteSidecar {
  src: string;
  sprites: Readonly<Record<string, SpriteRange>>;
  loopPoints?: Readonly<Record<string, readonly [number, number]>>;
}

/** A sidecar plus its decoded buffer as a `SpriteSheet` for `audio.defineSprites`. */
export function spriteSheetFrom(sidecar: SpriteSidecar, buffer: AudioBuffer): SpriteSheet {
  return { buffer, sprites: sidecar.sprites, loopPoints: sidecar.loopPoints };
}

/** What a sprite voice schedules: `start(when, offset, duration)` or a loop between two points. */
export interface SpriteSchedule {
  /** Seconds into the buffer the clip starts. */
  offset: number;
  /** Seconds the clip plays (a one-shot). */
  duration: number;
  /** Seconds into the buffer the loop section runs between (a loop). */
  loopStart: number;
  loopEnd: number;
}

/** Splits `name#clip`; null for a plain sound name. */
export function parseSpriteRef(ref: string): { sheet: string; clip: string } | null {
  const i = ref.indexOf('#');
  if (i < 0) return null;
  return { sheet: ref.slice(0, i), clip: ref.slice(i + 1) };
}

/**
 * The schedule of `clip` in `sheet`, in seconds. Throws a readable error for a clip the sheet
 * does not define. Writes `out` and returns it (no allocation when one is passed).
 */
export function spriteSchedule(
  sheet: SpriteSheet,
  sheetName: string,
  clip: string,
  out: SpriteSchedule = { offset: 0, duration: 0, loopStart: 0, loopEnd: 0 },
): SpriteSchedule {
  const range = sheet.sprites[clip];
  if (!range) {
    const known = Object.keys(sheet.sprites).join(', ') || '(none)';
    throw new Error(`[audio] sprite sheet "${sheetName}" has no clip "${clip}" (clips: ${known})`);
  }
  const start = Math.max(0, range[0]) / 1000;
  const length = Math.max(0, range[1]) / 1000;
  out.offset = start;
  out.duration = length;
  const lp = sheet.loopPoints?.[clip];
  if (lp) {
    out.loopStart = start + Math.max(0, lp[0]) / 1000;
    out.loopEnd = start + Math.min(length * 1000, Math.max(lp[0], lp[1])) / 1000;
  } else {
    out.loopStart = start;
    out.loopEnd = start + length;
  }
  return out;
}
