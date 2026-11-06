/**
 * `SceneTarget`: the allocated target as before (sizes, lazy depth, resize) and the external
 * one (ws/xr): adopts a colour and depth texture it never destroys, allocates only its emissive,
 * re-points on `adopt`, and refuses `resize`.
 */
import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeTexture } from './fake-gpu';
import { DEPTH_FORMAT } from './material';
import { SCENE_FORMAT, SceneTarget, sharedEmissiveCount } from './scene-target';

function labels(fake: ReturnType<typeof createFakeDevice>): string[] {
  return fake.textures.filter((t) => !t.destroyed).map((t) => t.label ?? '?');
}

describe('SceneTarget (allocated)', () => {
  it('allocates colour and emissive at the size, depth on first use, and resizes', () => {
    const fake = createFakeDevice();
    const t = new SceneTarget(fake.device, { width: 100, height: 50 });
    expect(t.isExternal).toBe(false);
    expect(t.adoptedColor).toBeNull();
    expect(t.viewport).toBeNull();
    expect(labels(fake)).toEqual(['scene-color', 'scene-emissive']);
    expect(t.depth).toBeNull();
    t.depthAttachment();
    expect(t.depth?.format).toBe(DEPTH_FORMAT);
    expect(t.resize(100, 50)).toBe(false);
    expect(t.resize(10, 10)).toBe(true);
    expect(labels(fake)).toEqual(['scene-color', 'scene-emissive']);
    expect(t.depth).toBeNull();
    t.destroy();
    expect(labels(fake)).toEqual([]);
  });

  it('a zero size still makes 1×1 textures', () => {
    const fake = createFakeDevice();
    const t = new SceneTarget(fake.device, { width: 0, height: 0 });
    expect(t.width).toBe(1);
    expect(t.height).toBe(1);
  });
});

describe('SceneTarget.external', () => {
  function textures(fake: ReturnType<typeof createFakeDevice>, w = 128, h = 32) {
    const color = fake.device.createTexture({
      label: 'layer-color',
      size: [w, h],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const depth = fake.device.createTexture({
      label: 'layer-depth',
      size: [w, h],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return { color, depth };
  }

  it('adopts colour and depth, allocates only its emissive, and never destroys what it adopted', () => {
    const fake = createFakeDevice();
    const { color, depth } = textures(fake);
    const t = SceneTarget.external({
      device: fake.device,
      color,
      depth,
      viewport: { x: 0, y: 0, width: 64, height: 32 },
      label: 'eye',
    });
    expect(t.isExternal).toBe(true);
    expect(t.adoptedColor).toBe(color);
    expect(t.width).toBe(128);
    expect(t.height).toBe(32);
    expect(t.viewport).toEqual({ x: 0, y: 0, width: 64, height: 32 });
    expect(labels(fake)).toEqual(['layer-color', 'layer-depth', 'eye-emissive']);
    expect(t.color.texture).toBe(color);
    expect(t.color.width).toBe(128);
    expect(t.colorAtt.view).toBe(t.color.view);
    expect(t.depth?.texture).toBe(depth);
    expect(t.depthAttachment().view).toBe(t.depth?.view);
    expect(labels(fake)).toEqual(['layer-color', 'layer-depth', 'eye-emissive']);
    t.destroy();
    expect((color as unknown as FakeTexture).destroyed).toBe(false);
    expect((depth as unknown as FakeTexture).destroyed).toBe(false);
    expect(labels(fake)).toEqual(['layer-color', 'layer-depth']);
  });

  it('adopt re-points at the next textures; same textures are a no-op but the viewport updates', () => {
    const fake = createFakeDevice();
    const a = textures(fake);
    const t = SceneTarget.external({ device: fake.device, color: a.color, depth: a.depth });
    const colorView = t.color.view;
    const emissive = t.emissive;
    t.adopt({ color: a.color, depth: a.depth, viewport: { x: 64, y: 0, width: 64, height: 32 } });
    expect(t.color.view).toBe(colorView);
    expect(t.viewport).toEqual({ x: 64, y: 0, width: 64, height: 32 });
    const b = textures(fake);
    t.adopt({ color: b.color, depth: b.depth });
    expect(t.adoptedColor).toBe(b.color);
    expect(t.color.view).not.toBe(colorView);
    expect(t.emissive).toBe(emissive); // same size: kept
    expect(t.viewport).toBeNull();
    // A new size reallocates the emissive and drops the depth.
    const c = textures(fake, 64, 64);
    t.adopt({ color: c.color, depth: c.depth });
    expect(t.width).toBe(64);
    expect(t.emissive).not.toBe(emissive);
    expect((emissive as unknown as { texture: FakeTexture }).texture.destroyed).toBe(true);
    expect(t.depth?.texture).toBe(c.depth);
  });

  it('external targets of one size share one emissive, stored with discard, freed by the last', () => {
    const fake = createFakeDevice();
    const a = textures(fake);
    const b = textures(fake);
    const left = SceneTarget.external({ device: fake.device, color: a.color, label: 'left' });
    const right = SceneTarget.external({ device: fake.device, color: b.color, label: 'right' });
    expect(right.emissive).toBe(left.emissive);
    expect(left.emissiveAtt.storeOp).toBe('discard');
    expect(labels(fake).filter((l) => l.endsWith('emissive'))).toEqual(['left-emissive']);
    expect(sharedEmissiveCount(fake.device)).toBe(1);
    // Another size is another texture; the first stays while someone holds it.
    const c = textures(fake, 64, 64);
    right.adopt({ color: c.color });
    expect(right.emissive).not.toBe(left.emissive);
    expect(sharedEmissiveCount(fake.device)).toBe(2);
    left.destroy();
    expect(sharedEmissiveCount(fake.device)).toBe(1);
    expect((left.emissive as unknown as { texture: FakeTexture }).texture.destroyed).toBe(true);
    right.destroy();
    expect(sharedEmissiveCount(fake.device)).toBe(0);
    // An allocated target keeps its own emissive with store.
    const own = new SceneTarget(fake.device, { width: 8, height: 8 });
    expect(own.emissiveAtt.storeOp).toBe('store');
  });

  it('without an adopted depth texture it allocates its own on first use, then drops it when one arrives', () => {
    const fake = createFakeDevice();
    const { color, depth } = textures(fake);
    const t = SceneTarget.external({ device: fake.device, color, label: 'eye' });
    expect(t.depth).toBeNull();
    t.depthAttachment();
    expect(t.depth?.format).toBe(DEPTH_FORMAT);
    expect(labels(fake)).toContain('eye-depth');
    t.adopt({ color, depth });
    expect(t.depth?.texture).toBe(depth);
    t.adopt({ color });
    expect(t.depth).toBeNull();
  });

  it('refuses resize', () => {
    const fake = createFakeDevice();
    const { color } = textures(fake);
    const t = SceneTarget.external({ device: fake.device, color });
    expect(() => t.resize(1, 1)).toThrow(/external/);
  });
});
