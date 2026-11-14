/**
 * ws/warm-voxel-fit (D2): the core's sun shadow reads a lean source (`CoreShadowMap`, no forward
 * renderer), and an off shadow returns lit before the divide (an all-zero matrix: w 0, NaN).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CoreShadowMap, CoreSunShadow, coreSunShadowWgsl } from './core-shadow';
import { createFakeDevice } from './fake-gpu';

describe('core sun shadow (ws/warm-voxel-fit)', () => {
  it('returns 1 when off, before dividing by w', () => {
    const wgsl = coreSunShadowWgsl(2);
    const off = wgsl.indexOf('if (core_sun.params.z == 0.0)');
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(wgsl.indexOf('clip.w'));
    expect(wgsl).toContain('@group(2) @binding(0)');
  });

  it('imports nothing of the forward renderer', () => {
    const src = readFileSync(new URL('./core-shadow.ts', import.meta.url), 'utf8');
    const imports = src.split('\n').filter((l) => l.startsWith('import'));
    expect(imports).toEqual(["import type { ShadowUniforms } from './lights';"]);
  });

  it('CoreSunShadow binds a CoreShadowMap and follows its resize', () => {
    const fake = createFakeDevice();
    const device = fake.device as unknown as GPUDevice;
    const map = new CoreShadowMap(device);
    expect(map.size).toBe(0);
    const sun = new CoreSunShadow(device, map);
    const g0 = sun.group;
    expect(sun.group).toBe(g0);
    map.resize(1024);
    expect(map.uniforms.texelSize).toBe(1 / 1024);
    expect(map.target.view).toBe(map.view);
    expect(map.target.format).toBe('depth32float');
    expect(sun.version).toBe(1);
    const g1 = sun.group;
    expect(g1).not.toBe(g0);
    map.resize(1024);
    expect(sun.group).toBe(g1);
    sun.write(true, [0, 0, 0]);
    expect(fake.errors).toEqual([]);
  });
});
