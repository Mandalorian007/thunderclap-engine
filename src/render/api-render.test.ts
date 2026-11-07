// ws/api-render (E-036): the renamed and added render surface, and that every deprecated alias
// is the same value or type as its replacement.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { box } from '../geom/primitives';
import { createLodChain } from '../geom/simplify';
import { BUFFER_BINDING_BASE } from './bindings';
import type { BlendMode, RenderBlendMode } from './blend'; // deprecated-alias test
import { CAMERA_INV_VIEW_PROJ_OFFSET, CAMERA_JITTER_OFFSET, Camera } from './camera';
import * as deprecated from './deprecated';
import { createFakeDevice, fakeRendererGpu } from './fake-gpu';
import { atlasFrames } from './flipbook';
import type { DistanceFog, Fog } from './lights'; // deprecated-alias test
import { FOG_OFFSET_FLOATS, LIGHTS_BLOCK_FLOATS, Lights } from './lights';
import { SPRITE_WGSL } from './material';
import { Renderer } from './renderer';
import { SKIN_PALETTE_HEADER_FLOATS, SkinPalette } from './skin';
import { STANDARD_WGSL } from './standard';
import { defaultTextures } from './texture';
import { Transform } from './transform';

function renderer() {
  const fake = createFakeDevice();
  return { fake, r: new Renderer(fakeRendererGpu(fake)) };
}

describe('deprecated aliases (E-036)', () => {
  it('re-export the internals unchanged', () => {
    expect(deprecated.CAMERA_INV_VIEW_PROJ_OFFSET).toBe(CAMERA_INV_VIEW_PROJ_OFFSET); // deprecated-alias test
    expect(deprecated.CAMERA_JITTER_OFFSET).toBe(CAMERA_JITTER_OFFSET); // deprecated-alias test
    expect(deprecated.FOG_OFFSET_FLOATS).toBe(FOG_OFFSET_FLOATS); // deprecated-alias test
    expect(deprecated.LIGHTS_BLOCK_FLOATS).toBe(LIGHTS_BLOCK_FLOATS); // deprecated-alias test
    expect(deprecated.SKIN_PALETTE_HEADER_FLOATS).toBe(SKIN_PALETTE_HEADER_FLOATS); // deprecated-alias test
    expect(deprecated.BUFFER_BINDING_BASE).toBe(BUFFER_BINDING_BASE); // deprecated-alias test
    expect(deprecated.STANDARD_WGSL).toBe(STANDARD_WGSL); // deprecated-alias test
    expect(deprecated.SPRITE_WGSL).toBe(SPRITE_WGSL); // deprecated-alias test
  });

  it('BlendMode is RenderBlendMode and Fog is DistanceFog', () => {
    expectTypeOf<BlendMode>().toEqualTypeOf<RenderBlendMode>(); // deprecated-alias test
    expectTypeOf<Fog>().toEqualTypeOf<DistanceFog>(); // deprecated-alias test
  });

  it('renderer.white is defaultTextures(device).white', () => {
    const { r } = renderer();
    expect(r.white).toBe(defaultTextures(r.device).white); // deprecated-alias test
  });
});

const xyz = (t: Transform) => [t.scale.x, t.scale.y, t.scale.z];

describe('Transform.setScale', () => {
  it('one number scales all three axes', () => {
    const t = new Transform().setScale(2);
    expect(xyz(t)).toEqual([2, 2, 2]);
  });

  it('two numbers keep z at 1; three set each', () => {
    expect(xyz(new Transform().setScale(2, 3))).toEqual([2, 3, 1]);
    expect(xyz(new Transform().setScale(2, 3, 4))).toEqual([2, 3, 4]);
  });
});

describe('createSpriteMaterial', () => {
  it('takes an options object', () => {
    const { r } = renderer();
    const texture = r.textureFromPixels({ width: 1, height: 1, data: new Uint8Array(4) });
    const m = r.createSpriteMaterial({ texture, label: 'hero', blend: 'additive' });
    expect(m.label).toBe('hero');
    expect(m.blend).toBe('additive');
    expect(r.createSpriteMaterial({ texture }).label).toBe('sprite');
  });

  it('still takes the deprecated positional form', () => {
    const { r } = renderer();
    const texture = r.textureFromPixels({ width: 1, height: 1, data: new Uint8Array(4) });
    const m = r.createSpriteMaterial(texture, 'old', { blend: 'premultiplied' }); // deprecated-alias test
    expect(m.label).toBe('old');
    expect(m.blend).toBe('premultiplied');
  });
});

describe('Lights.sun.direction', () => {
  it('is the same array as the deprecated dir, both ways', () => {
    const l = new Lights();
    expect(Array.from(l.sun.direction)).toEqual([0, -1, 0]);
    expect(l.sun.dir).toBe(l.sun.direction); // deprecated-alias test
    l.sun.dir = [1, 0, 0]; // deprecated-alias test
    expect(l.sun.direction).toEqual([1, 0, 0]);
    l.sun.direction = [0, 0, -2];
    expect(l.sun.dir).toEqual([0, 0, -2]); // deprecated-alias test
  });

  it('writes the block from direction', () => {
    const l = new Lights();
    l.sun.direction = [0, 0, -2];
    l.sun.color = [1, 1, 1];
    const f32 = new Float32Array(LIGHTS_BLOCK_FLOATS);
    l.writeBlock(f32, new Uint32Array(f32.buffer), 0, null);
    const a = Array.from(f32);
    // The normalised direction appears in the block (sun_dir).
    const i = a.findIndex((v, k) => v === 0 && a[k + 1] === 0 && a[k + 2] === -1);
    expect(i).toBeGreaterThanOrEqual(0);
  });
});

describe('createMeshLod', () => {
  it('uploads geom’s chain as a MeshLod that keeps the geometries', () => {
    const { r } = renderer();
    const geometries = createLodChain(box(), [0.5]);
    const lod = r.createMeshLod({ geometries, thresholdsPx: [100], label: 'rock' });
    expect(lod.meshes.length).toBe(2);
    expect(lod.meshes[1]!.label).toBe('rock-lod1');
    expect(lod.thresholdsPx).toEqual([100]);
    expect(lod.geometries).toBe(geometries);
  });

  it('throws on more thresholds than levels or an empty chain', () => {
    const { r } = renderer();
    expect(() => r.createMeshLod({ geometries: [box()], thresholdsPx: [1, 2] })).toThrow();
    expect(() => r.createMeshLod({ geometries: [], thresholdsPx: [] })).toThrow();
  });
});

describe('SkinPalette.write / params', () => {
  it('write is the slot’s staging block, marked dirty', () => {
    const { r } = renderer();
    const p = new SkinPalette(r.device, { joints: 2, instances: 2 });
    p.flush();
    expect(p.isDirty).toBe(false);
    const v = p.write(1);
    expect(v.length).toBe(24);
    expect(p.write(1)).toBe(v);
    expect(p.isDirty).toBe(true);
    v[3] = 7;
    // The same floats `set` would have written.
    const q = new SkinPalette(r.device, { joints: 2, instances: 2 });
    const m = new Float32Array(24);
    m.set(v);
    q.set(1, m);
    expect(Array.from(q.write(1))).toEqual(Array.from(v));
  });

  it('params names the slot in params.w, one object per slot', () => {
    const { r } = renderer();
    const p = new SkinPalette(r.device, { joints: 1, instances: 3 });
    expect(Array.from(p.params(2).params!)).toEqual([0, 0, 0, 2]);
    expect(p.params(2)).toBe(p.params(2));
    expect(() => p.params(3)).toThrow();
  });
});

describe('atlasFrames inset', () => {
  it('pulls each rect in by inset texels', () => {
    const [a] = atlasFrames({ cols: 2, rows: 2, inset: 0.5, width: 64, height: 32 }, [3]);
    expect(a).toEqual([0.5 + 0.5 / 64, 0.5 + 0.5 / 32, 1 - 0.5 / 64, 1 - 0.5 / 32]);
    expect(atlasFrames({ cols: 2, rows: 1 })[1]).toEqual([0.5, 0, 1, 1]);
  });

  it('throws without the texture size', () => {
    expect(() => atlasFrames({ cols: 2, rows: 2, inset: 0.5 })).toThrow(/width and height/);
  });
});

describe('Camera.screenToWorld(sx, sy, out)', () => {
  it('lands on z = 0 for ortho2d, with the same x, y as a depth pick', () => {
    const cam = Camera.ortho2d(1920, 1080);
    cam.x = 100;
    cam.zoom = 2;
    const out = { x: 0, y: 0, z: 9 };
    cam.screenToWorld(400, 300, out);
    const d = cam.screenToWorld(400, 300, 0);
    expect(out.x).toBeCloseTo(d.x, 6);
    expect(out.y).toBeCloseTo(d.y, 6);
    expect(out.z).toBe(0);
  });

  it('meets the ground plane under a tilted perspective camera', () => {
    const cam = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 100).lookAt([0, 0, 10], [0, 0, 0]);
    const out = { x: 0, y: 0, z: 0 };
    cam.screenToWorld(cam.screen.width / 2, cam.screen.height / 2, out);
    expect(out.x).toBeCloseTo(0, 4);
    expect(out.y).toBeCloseTo(0, 4);
    expect(out.z).toBe(0);
    const w = cam.worldToScreen(3, -2, 0);
    cam.screenToWorld(w.x, w.y, out);
    expect(out.x).toBeCloseTo(3, 3);
    expect(out.y).toBeCloseTo(-2, 3);
  });
});
