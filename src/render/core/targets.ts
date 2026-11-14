/**
 * The core's extra colour targets (ws/core-targets, B7): what screen-space post reads beside the
 * scene colour. A core opts in (`RenderCoreOptions.targets`, `core.enableTargets`); one that
 * does not keeps one colour attachment and pays nothing. Each target has a fixed fragment
 * location, so a shader writes the same `@location` whatever else the core has:
 *
 * - `emissive` at `@location(1)`, `rgba16float`: HDR light the surface gives off (bloom's source).
 * - `roughMetal` at `@location(2)`, `rg8unorm`: roughness, metalness (SSR).
 * - `velocity` at `@location(3)`, `rg16float`: screen motion since the last frame in uv units
 *   (+x right, +y down; TAA, motion blur): `core_velocity(view, p)` computes it.
 *
 * A pass with targets attaches `[colour, emissive?, roughMetal?, velocity?]` (a target the core
 * lacks is a null attachment, trailing ones dropped). A pipeline drawing into it declares what
 * it writes; the others get `writeMask: 0` (`coreColorTargets`). A shader may write a location
 * the core lacks: the output is dropped.
 */

/** One of the core's extra colour targets. */
export type CoreTargetName = 'emissive' | 'roughMetal' | 'velocity';

/** Bits of a target mask (`RenderCore.targetMask`, `CoreDrawContext.aux`). */
export const CORE_TARGET = { emissive: 1, roughMetal: 2, velocity: 4 } as const;

/** The targets in attachment order (location 1, 2, 3). */
export const CORE_TARGET_NAMES: readonly CoreTargetName[] = ['emissive', 'roughMetal', 'velocity'];

/** Each target's format, in attachment order. */
export const CORE_TARGET_FORMATS: readonly GPUTextureFormat[] = [
  'rgba16float',
  'rg8unorm',
  'rg16float',
];

/** A mask of `names` (bits of `CORE_TARGET`). */
export function coreTargetMask(names: readonly CoreTargetName[] | undefined | null): number {
  let m = 0;
  if (names) for (const n of names) m |= CORE_TARGET[n];
  return m;
}

/**
 * The colour target states of a pipeline drawing into a pass with targets `aux` (a mask; 0 for
 * none, as after a resolve): `color` at 0, then each target the pass has at its location, null
 * where it has none. Targets in `writes` (a mask or names) are written; emissive takes `color`'s
 * blend (additive glow adds up), roughMetal and velocity are written unblended. The others are
 * masked off (`writeMask: 0`), so the shader need not write them.
 */
export function coreColorTargets(
  color: GPUColorTargetState,
  aux: number,
  writes: number | readonly CoreTargetName[] = 0,
): (GPUColorTargetState | null)[] {
  const w = typeof writes === 'number' ? writes : coreTargetMask(writes);
  const out: (GPUColorTargetState | null)[] = [color];
  const last = aux & 4 ? 3 : aux & 2 ? 2 : aux & 1 ? 1 : 0;
  for (let k = 0; k < last; k++) {
    const bit = 1 << k;
    if (!(aux & bit)) {
      out.push(null);
      continue;
    }
    const on = (w & bit) !== 0;
    const t: GPUColorTargetState = {
      format: CORE_TARGET_FORMATS[k]!,
      writeMask: on ? 0xf : 0,
    };
    if (on && k === 0 && color.blend) t.blend = color.blend;
    out.push(t);
  }
  return out;
}

/** The colour formats of a pass with targets `aux` (a bundle's `colorFormats`). */
export function coreColorFormats(
  color: GPUTextureFormat,
  aux: number,
): (GPUTextureFormat | null)[] {
  const out: (GPUTextureFormat | null)[] = [color];
  const last = aux & 4 ? 3 : aux & 2 ? 2 : aux & 1 ? 1 : 0;
  for (let k = 0; k < last; k++) out.push(aux & (1 << k) ? CORE_TARGET_FORMATS[k]! : null);
  return out;
}
