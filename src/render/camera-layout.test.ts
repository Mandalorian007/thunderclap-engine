/**
 * The WGSL `EngineCamera` struct against the JS block `Camera.writeBlock` fills: every field's
 * WGSL offset (by the uniform layout rules) must be the float offset the CPU writes it at. A
 * `vec3u` pad after `view_index` once aligned to 16 bytes and shifted every later field by four
 * floats; this parses `WGSL_GLOBALS` so a field appended to either side fails here first.
 */
import { describe, expect, it } from 'vitest';
import {
  CAMERA_BLOCK_FLOATS,
  CAMERA_INV_VIEW_PROJ_OFFSET,
  CAMERA_JITTER_OFFSET,
  CAMERA_PREV_VIEW_OFFSET,
  CAMERA_PREV_VIEW_PROJ_OFFSET,
} from './camera';
import { WGSL_GLOBALS } from './wgsl';

/** Byte alignment and size of the WGSL types the engine blocks use (uniform address space). */
const TYPES: Record<string, { align: number; size: number }> = {
  f32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  vec2f: { align: 8, size: 8 },
  vec2u: { align: 8, size: 8 },
  vec3f: { align: 16, size: 12 },
  vec3u: { align: 16, size: 12 },
  vec4f: { align: 16, size: 16 },
  vec4u: { align: 16, size: 16 },
  mat4x4f: { align: 16, size: 64 },
};

/** Field name → float offset of struct `name` in `wgsl`, plus its size in floats. */
function structLayout(
  wgsl: string,
  name: string,
): { offsets: Map<string, number>; floats: number } {
  const body = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(wgsl)?.[1];
  if (!body) throw new Error(`no struct ${name}`);
  const offsets = new Map<string, number>();
  let at = 0;
  let maxAlign = 4;
  for (const m of body.matchAll(/(\w+)\s*:\s*(\w+)/g)) {
    const t = TYPES[m[2]!];
    if (!t) throw new Error(`unknown WGSL type ${m[2]}`);
    at = Math.ceil(at / t.align) * t.align;
    offsets.set(m[1]!, at / 4);
    at += t.size;
    maxAlign = Math.max(maxAlign, t.align);
  }
  return { offsets, floats: (Math.ceil(at / maxAlign) * maxAlign) / 4 };
}

describe('camera block layout', () => {
  const { offsets, floats } = structLayout(WGSL_GLOBALS, 'EngineCamera');

  it('every WGSL field sits where Camera.writeBlock writes it', () => {
    expect(Object.fromEntries(offsets)).toMatchObject({
      view: 0,
      proj: 16,
      view_proj: 32,
      camera_pos: 48,
      viewport: 52,
      view_index: 56,
      inv_view_proj: CAMERA_INV_VIEW_PROJ_OFFSET,
      prev_view_proj: CAMERA_PREV_VIEW_PROJ_OFFSET,
      prev_view: CAMERA_PREV_VIEW_OFFSET,
      jitter: CAMERA_JITTER_OFFSET,
    });
  });

  it('the struct fits the block and the last field is jitter', () => {
    expect(floats).toBeLessThanOrEqual(CAMERA_BLOCK_FLOATS);
    expect(floats).toBe(CAMERA_JITTER_OFFSET + 4);
    expect([...offsets.keys()].at(-1)).toBe('jitter');
  });

  it('the globals block is 32 bytes', () => {
    expect(structLayout(WGSL_GLOBALS, 'EngineGlobals').floats).toBe(8);
  });
});
