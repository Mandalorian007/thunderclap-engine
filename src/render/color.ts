/**
 * Colour helpers. The renderer works in **linear** RGB (HDR allowed, values > 1 glow).
 * Author colours as sRGB hex and convert with `hex()`.
 */

export type RGBA = [number, number, number, number];

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Parse `#rgb`, `#rrggbb` or `#rrggbbaa` (sRGB) into linear RGBA, optionally scaled by
 * `intensity` (HDR multiplier on RGB, alpha untouched).
 */
export function hex(value: string, intensity = 1): RGBA {
  let h = value.startsWith('#') ? value.slice(1) : value;
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error(`hex(): bad colour ${value}`);
  const a = h.length === 8 ? n(6) : 1;
  return [
    srgbToLinear(n(0)) * intensity,
    srgbToLinear(n(2)) * intensity,
    srgbToLinear(n(4)) * intensity,
    a,
  ];
}

/** Linear RGBA from components (no conversion). */
export function rgba(r: number, g: number, b: number, a = 1): RGBA {
  return [r, g, b, a];
}

/** Scale RGB by `k` (alpha untouched). Returns a new array. */
export function scaleRgb(c: ArrayLike<number>, k: number): RGBA {
  return [c[0]! * k, c[1]! * k, c[2]! * k, c[3] ?? 1];
}
