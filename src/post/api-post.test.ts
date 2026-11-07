// ws/api-render (E-036): post presets, the `mist` section (formerly `fog`) and world-space god rays.
import { describe, expect, it } from 'vitest';
import { mat4 } from '../core/math';
import { easeLinear, PostBlender } from './blend';
import {
  applyPostPatch,
  cinematicPostSettings,
  clonePostSettings,
  godRaySource,
  neutralPostSettings,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
  resolveGodRays,
} from './settings';

describe('presets', () => {
  it('cinematic turns the look on', () => {
    const c = cinematicPostSettings();
    expect(c.bloom.enabled && c.mist.enabled && c.godRays.enabled && c.vignette.enabled).toBe(true);
  });

  it('neutral turns the look off and keeps an identity grade', () => {
    const n = neutralPostSettings();
    expect(n.bloom.enabled || n.mist.enabled || n.godRays.enabled || n.vignette.enabled).toBe(
      false,
    );
    expect(n.grade.saturation).toBe(1);
    expect(n.grade.contrast).toBe(1);
    expect(n.grade.exposure).toBe(1);
    expect(n.grade.lift).toEqual([0, 0, 0]);
    expect(n.grade.gamma).toEqual([1, 1, 1]);
    expect(n.grade.gain).toEqual([1, 1, 1]);
    expect(n.grade.tonemap).toBe('aces');
  });

  it('each call is a fresh object', () => {
    expect(neutralPostSettings().bloom).not.toBe(neutralPostSettings().bloom);
  });
});

describe('mist (formerly fog)', () => {
  it('no settings object has a fog section', () => {
    for (const s of [cinematicPostSettings(), neutralPostSettings()]) {
      const c = clonePostSettings(s);
      expect(c.mist).not.toBe(s.mist);
      expect('fog' in s).toBe(false);
      expect('fog' in c).toBe(false);
    }
  });

  it('a mist patch and a mist blend write mist', () => {
    const s = cinematicPostSettings();
    applyPostPatch(s, { mist: { density: 0.25 } });
    expect(s.mist.density).toBe(0.25);
    const b = new PostBlender();
    b.blendTo(s, { mist: { density: 0.75 } }, 1, easeLinear);
    b.advance(s, 0.5);
    expect(s.mist.density).toBeCloseTo(0.5, 6);
    b.cancel({ mist: { density: 0 } });
    expect(b.active).toBe(false);
  });
});

describe('godRays.direction', () => {
  const proj = new Float32Array(16);
  const view = new Float32Array(16);
  const vp = new Float32Array(16);
  mat4.perspective(proj, Math.PI / 2, 1, 0.1, 100);
  mat4.identity(view); // camera at the origin looking down -z
  mat4.multiply(vp, proj, view);

  it('projects the sun opposite the light direction to logical px', () => {
    const out = [0, 0];
    // Light travelling +z: the sun is straight ahead, at -z, the screen centre.
    expect(godRaySource(vp, [0, 0, 1], 1920, 1080, out)).toBe(1);
    expect(out[0]).toBeCloseTo(960, 3);
    expect(out[1]).toBeCloseTo(540, 3);
    // Coming down and forward: the sun is above the centre (smaller y).
    godRaySource(vp, [0, -1, 2], 1920, 1080, out);
    expect(out[0]).toBeCloseTo(960, 3);
    expect(out[1]).toBeLessThan(540);
  });

  it('reports a sun behind the camera and leaves out alone', () => {
    const out = [5, 6];
    expect(godRaySource(vp, [0, 0, -1], 1920, 1080, out)).toBe(0);
    expect(out).toEqual([5, 6]);
  });

  it('packs x, y when unset and the projected source (zero intensity behind) when set', () => {
    const s = cinematicPostSettings();
    const a = new Float32Array(POST_UNIFORM_FLOATS);
    const b = new Float32Array(POST_UNIFORM_FLOATS);
    packPostUniforms(a, s, 0, 1920, 1080, 1920, 1080);
    packPostUniforms(b, s, 0, 1920, 1080, 1920, 1080, undefined, null, 0, null, null);
    expect(Array.from(b)).toEqual(Array.from(a));

    const rays = new Float32Array(3);
    s.godRays.direction = [0, 0, 1];
    resolveGodRays(s.godRays, vp, 1920, 1080, rays);
    expect(rays[2]).toBe(1);
    packPostUniforms(b, s, 0, 1920, 1080, 1920, 1080, undefined, null, 0, null, rays);
    expect(Array.from(b)).not.toEqual(Array.from(a));

    s.godRays.direction = [0, 0, -1];
    resolveGodRays(s.godRays, vp, 1920, 1080, rays);
    expect(rays[2]).toBe(0);
    resolveGodRays(s.godRays, null, 1920, 1080, rays);
    expect([rays[0], rays[1], rays[2]]).toEqual([s.godRays.x, s.godRays.y, 1]);
  });
});
