import { describe, expect, it } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from './fake-gpu';
import { createParallax, parallaxOffset } from './parallax';
import { Renderer } from './renderer';
import { createTileLayer } from './tile-layer';

function setup() {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  const material = r.createSpriteMaterial(
    r.textureFromPixels({ width: 2, height: 2, data: new Uint8Array(16) }),
  );
  const layer = (label: string) =>
    createTileLayer(r, {
      material,
      tileW: 10,
      tileH: 10,
      columns: 4,
      rows: 2,
      atlas: { cols: 2, rows: 2 },
      fill: 0,
      label,
    });
  return { fake, r, layer };
}

describe('parallaxOffset', () => {
  it('scales by 1 - factor without a wrap', () => {
    expect(parallaxOffset(100, 0, undefined)).toBe(100);
    expect(parallaxOffset(100, 1)).toBe(0);
    expect(parallaxOffset(100, 0.25)).toBe(75);
    expect(parallaxOffset(-40, 0.5)).toBe(-20);
  });

  it('with a wrap keeps the origin within one period behind the camera', () => {
    for (const cam of [0, 7, 30, 31, 100, -1, -45, 1234.5]) {
      const o = parallaxOffset(cam, 0.3, 30);
      expect(o).toBeGreaterThan(cam - 30);
      expect(o).toBeLessThanOrEqual(cam);
      // The same scroll as the unwrapped offset, modulo the period.
      expect(((o - cam * 0.7) % 30) + 30 > 29.999 || Math.abs((o - cam * 0.7) % 30) < 1e-9).toBe(
        true,
      );
    }
    expect(parallaxOffset(0, 0.3, 30)).toBe(0);
    expect(parallaxOffset(100, 0.3, 30)).toBe(100 - (((30 % 30) + 30) % 30));
    expect(parallaxOffset(50, 0.5, 30)).toBe(50 - 25);
  });
});

describe('createParallax', () => {
  it('moves each layer from its base by camera × (1 - factor), wrapped on request', () => {
    const { r, layer } = setup();
    const far = layer('far');
    const mid = layer('mid');
    const near = layer('near');
    mid.origin.y = 100;
    const p = createParallax(r, [
      { layer: far, factorX: 0, factorY: 0 },
      { layer: mid, factorX: 0.5, factorY: 0.5, wrapW: 40 },
      { layer: near, factorX: 1, factorY: 1 },
    ]);
    expect(p.layers.length).toBe(3);
    expect(p.layers[1]!.baseY).toBe(100);
    p.update(200, 60);
    expect([far.origin.x, far.origin.y]).toEqual([200, 60]);
    expect([near.origin.x, near.origin.y]).toEqual([0, 0]);
    // mid: x scroll 100 mod 40 = 20 → origin 180 (within one period behind 200); y unwrapped.
    expect(mid.origin.x).toBe(180);
    expect(mid.origin.y).toBe(100 + 30);
    expect([p.layers[1]!.offsetX, p.layers[1]!.offsetY]).toEqual([180, 30]);
    p.update(-10, 0);
    expect(mid.origin.x).toBe(-10 - 35);
    expect(far.origin.x).toBe(-10);
  });

  it('draws the layers in order with their params and destroys them', () => {
    const { fake, r, layer } = setup();
    const a = layer('a');
    const b = layer('b');
    const p = createParallax(r, [
      { layer: a, factorX: 0.2, factorY: 0.2, params: { order: 1 } },
      { layer: b, factorX: 0.8, factorY: 0.8, params: { order: 2 } },
    ]);
    p.update(0, 0);
    const f = r.beginFrame(0, 0);
    p.draw(f);
    r.endFrame();
    expect(r.stats.drawCalls).toBe(2);
    const recs = (r as unknown as { recs: { order: number }[] }).recs;
    expect(recs.slice(0, 2).map((x) => x.order)).toEqual([1, 2]);
    p.destroy();
    expect(fake.errors).toEqual([]);
  });
});
