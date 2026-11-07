import { describe, expect, it } from 'vitest';
import { createIso } from '../geom/iso';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from './fake-gpu';
import { INSTANCE_FLOATS, INSTANCE_OFFSET } from './material';
import { VERTEX_FLOATS, VERTEX_STRIDE } from './mesh';
import { Renderer } from './renderer';
import { createTileLayer, type TileLayerOptions } from './tile-layer';

function setup(opts: Partial<TileLayerOptions> = {}) {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  const material = r.createSpriteMaterial({
    texture: r.textureFromPixels({ width: 2, height: 2, data: new Uint8Array(16) }),
  });
  const layer = createTileLayer(r, {
    material,
    tileW: 10,
    tileH: 20,
    columns: 4,
    rows: 3,
    atlas: { cols: 2, rows: 2 },
    ...opts,
  });
  // Drop the creation-time uploads: the tests below count the layer's own writes.
  fake.writes.splice(0);
  return { fake, r, layer, material };
}

/** `writeBuffer` calls into the layer's vertex buffer. */
function vertexWrites(fake: FakeDevice) {
  return fake.writes.filter((w) => w.buffer.label === 'tile-layer-vb');
}

/** The scene pass's draw commands of the last frame. */
function sceneDraws(fake: FakeDevice) {
  const p = [...fake.passes].reverse().find((x) => x.label === 'scene')!;
  return p.commands.filter((c) => c.op === 'draw' || c.op === 'drawIndexed');
}

describe('createTileLayer', () => {
  it('builds one mesh of columns × rows quads, all empty, and tracks count', () => {
    const { layer, fake } = setup();
    expect(layer.mesh.vertexCount).toBe(4 * 3 * 4);
    expect(layer.mesh.indexCount).toBe(4 * 3 * 6);
    expect(layer.mesh.indexFormat).toBe('uint16');
    expect(layer.count).toBe(0);
    expect(layer.get(0, 0)).toBe(-1);
    expect(layer.mesh.bounds.center).toEqual([20, 30, 0]);
    expect(fake.errors).toEqual([]);
    layer.set(1, 2, 3);
    layer.set(1, 2, 0);
    layer.set(3, 0, 2);
    expect(layer.count).toBe(2);
    expect(layer.get(1, 2)).toBe(0);
    layer.set(1, 2, -1);
    expect(layer.count).toBe(1);
    // Out of range: ignored.
    layer.set(4, 0, 1);
    layer.set(0, -1, 1);
    expect(layer.count).toBe(1);
    expect(layer.get(4, 0)).toBe(-1);
  });

  it('writes per-tile positions in logical px and atlas UVs; -1 collapses the quad', () => {
    const { layer, fake, r } = setup();
    // The fake records write ranges only: capture the bytes of the layer's uploads here.
    const uploaded: Float32Array[] = [];
    const queue = r.device.queue;
    const original = queue.writeBuffer.bind(queue);
    queue.writeBuffer = ((buffer, offset, data, dataOffset, size) => {
      if (buffer.label === 'tile-layer-vb') {
        uploaded.push(
          new Float32Array((data as ArrayBuffer).slice(dataOffset!, dataOffset! + size!)),
        );
      }
      original(buffer, offset, data as ArrayBuffer, dataOffset, size);
    }) as typeof queue.writeBuffer;
    const draw = () => {
      const f = r.beginFrame(0, 0);
      layer.draw(f);
      r.endFrame();
    };
    layer.set(2, 1, 3);
    draw();
    const w = vertexWrites(fake);
    expect(w.length).toBe(1);
    const t = 1 * 4 + 2;
    expect(w[0]!.offset).toBe(t * 4 * VERTEX_STRIDE);
    expect(w[0]!.bytes).toBe(4 * VERTEX_STRIDE);
    // Tile (2, 1) of 10 × 20 px: x 20..30, y 20..40; atlas cell 3 of a 2 × 2 grid: uv 0.5..1.
    const quad = uploaded[0]!;
    const vert = (i: number) => [...quad.slice(i * 8, i * 8 + 8)];
    expect(vert(0)).toEqual([20, 20, 0.5, 0.5, 1, 1, 1, 1]);
    expect(vert(1)).toEqual([30, 20, 1, 0.5, 1, 1, 1, 1]);
    expect(vert(2)).toEqual([30, 40, 1, 1, 1, 1, 1, 1]);
    expect(vert(3)).toEqual([20, 40, 0.5, 1, 1, 1, 1, 1]);
    layer.set(2, 1, -1);
    draw();
    const empty = uploaded[1]!;
    for (let i = 0; i < 4; i++) {
      expect([...empty.slice(i * 8, i * 8 + 2)]).toEqual([20, 20]);
    }
  });

  it('uploads only the dirty tile range, once per draw, and nothing when clean', () => {
    const { layer, fake, r } = setup();
    const draw = () => {
      const f = r.beginFrame(0, 0);
      layer.draw(f);
      r.endFrame();
    };
    draw();
    expect(vertexWrites(fake).length).toBe(0);
    layer.set(1, 0, 1); // tile 1
    layer.set(2, 2, 2); // tile 10
    draw();
    let w = vertexWrites(fake);
    expect(w.length).toBe(1);
    expect(w[0]!.offset).toBe(1 * 4 * VERTEX_STRIDE);
    expect(w[0]!.bytes).toBe(10 * 4 * VERTEX_STRIDE);
    draw();
    expect(vertexWrites(fake).length).toBe(1);
    // Setting a tile to what it already holds is not a change.
    layer.set(1, 0, 1);
    draw();
    expect(vertexWrites(fake).length).toBe(1);
    layer.fill([0, 1, 2, 3]);
    draw();
    w = vertexWrites(fake);
    expect(w.length).toBe(2);
    expect(w[1]!.offset).toBe(0);
    expect(w[1]!.bytes).toBe(4 * 4 * VERTEX_STRIDE);
    expect(layer.count).toBe(5);
    expect(fake.errors).toEqual([]);
  });

  it('draws as one indexed draw placed by origin and scale, carrying the given instance params', () => {
    const { layer, fake, r } = setup({ fill: 0 });
    expect(layer.count).toBe(12);
    layer.origin.x = 100;
    layer.origin.y = 50;
    layer.scale = 2;
    const tint = [0.5, 0.25, 1, 1];
    const f = r.beginFrame(0, 0);
    layer.draw(f, { tint, order: 3, layers: 2 });
    r.endFrame();
    const draws = sceneDraws(fake);
    expect(draws).toEqual([{ op: 'drawIndexed', indices: 72, instances: 1, firstInstance: 0 }]);
    const inst = fake.writes.find((w) => w.buffer.label === 'instances');
    expect(inst).toBeTruthy();
    expect(r.stats.drawCalls).toBe(1);
    // Instance 0: matrix row 0 = [sx, 0, 0, x], row 1 = [0, sy, 0, y]; tint follows.
    const data = (r as unknown as { instanceData: Float32Array }).instanceData;
    expect([...data.slice(0, 8)].map((v) => v + 0)).toEqual([2, 0, 0, 100, 0, 2, 0, 50]);
    expect([...data.slice(INSTANCE_OFFSET.tint, INSTANCE_OFFSET.tint + 4)]).toEqual(tint);
    expect([...data.slice(INSTANCE_OFFSET.uvRect, INSTANCE_OFFSET.uvRect + 4)]).toEqual([
      0, 0, 1, 1,
    ]);
    expect(data.length).toBeGreaterThanOrEqual(INSTANCE_FLOATS);
    // A second draw without params clears them again (no stale tint).
    const f2 = r.beginFrame(0, 0);
    layer.draw(f2);
    r.endFrame();
    expect([...data.slice(INSTANCE_OFFSET.tint, INSTANCE_OFFSET.tint + 4)]).toEqual([1, 1, 1, 1]);
  });

  it('uses uint32 indices past 65 535 vertices and clamps tile indices to the atlas', () => {
    const { layer } = setup({ columns: 200, rows: 100 });
    expect(layer.mesh.indexFormat).toBe('uint32');
    layer.set(0, 0, 99);
    expect(layer.get(0, 0)).toBe(3);
    layer.set(0, 0, -5);
    expect(layer.get(0, 0)).toBe(-1);
  });

  it('refuses an empty grid or atlas', () => {
    expect(() => setup({ columns: 0 })).toThrow(/columns and rows/);
    expect(() => setup({ atlas: { cols: 0, rows: 1 } })).toThrow(/atlas/);
  });

  it('vertex layout is the 2D one: 8 floats per vertex', () => {
    expect(VERTEX_FLOATS).toBe(8);
  });
});

describe("createTileLayer order: 'painter'", () => {
  /** Captures the floats of every vertex upload, by buffer label. */
  function capture(r: Renderer) {
    const uploads = new Map<string, Float32Array[]>();
    const queue = r.device.queue;
    const original = queue.writeBuffer.bind(queue);
    queue.writeBuffer = ((buffer, offset, data, dataOffset, size) => {
      if (buffer.label.endsWith('-vb')) {
        const list = uploads.get(buffer.label) ?? [];
        list.push(new Float32Array((data as ArrayBuffer).slice(dataOffset!, dataOffset! + size!)));
        uploads.set(buffer.label, list);
      }
      original(buffer, offset, data as ArrayBuffer, dataOffset, size);
    }) as typeof queue.writeBuffer;
    return uploads;
  }

  it('builds one mesh per diagonal and draws the non-empty bands back to front', () => {
    const elev = (col: number, row: number) => (col === 1 && row === 1 ? 2 : 0);
    const { layer, fake, r } = setup({ columns: 3, rows: 3, order: 'painter', elevation: elev });
    expect(layer.order).toBe('painter');
    expect(layer.meshes.length).toBe(5);
    expect(layer.mesh).toBe(layer.meshes[0]);
    expect(layer.meshes.map((m) => m.vertexCount)).toEqual([4, 8, 12, 8, 4]);
    const uploads = capture(r);
    layer.fill([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const f = r.beginFrame(0, 0);
    layer.draw(f, { order: 10 });
    r.endFrame();
    expect(sceneDraws(fake).length).toBe(5);
    expect(r.stats.drawCalls).toBe(5);
    // Each band uploaded once; the lifted tile (1, 1) sits in band 2 at slot 1 (after (2, 0)),
    // 2 × elevH = 20 px up: y 20..40 becomes 0..20.
    expect([...uploads.keys()]).toEqual([0, 1, 2, 3, 4].map((b) => `tile-layer-${b}-vb`));
    const band2 = uploads.get('tile-layer-2-vb')![0]!;
    const vert = (slot: number, i: number) => [
      ...band2.slice(slot * 32 + i * 8, slot * 32 + i * 8 + 2),
    ];
    expect(vert(0, 0)).toEqual([20, 0]); // (2, 0)
    expect(vert(1, 0)).toEqual([10, 0]); // (1, 1) lifted
    expect(vert(1, 2)).toEqual([20, 20]);
    expect(vert(2, 0)).toEqual([0, 40]); // (0, 2)
    expect(layer.elevationAt(1, 1)).toBe(2);
    expect(layer.elevationAt(0, 0)).toBe(0);
    // The bands' orders: base + diagonal, in submission order.
    const recs = (r as unknown as { recs: { order: number }[] }).recs;
    expect(recs.slice(0, 5).map((x) => x.order)).toEqual([10, 11, 12, 13, 14]);
    expect(fake.errors).toEqual([]);
  });

  it('skips empty bands, uploads nothing and draws the same when the map is static', () => {
    const { layer, fake, r } = setup({ columns: 3, rows: 3, order: 'painter' });
    layer.set(1, 1, 0);
    const draw = () => {
      const f = r.beginFrame(0, 0);
      layer.draw(f);
      r.endFrame();
    };
    draw();
    expect(sceneDraws(fake).length).toBe(1);
    expect(fake.writes.filter((w) => w.buffer.label?.endsWith('-vb')).length).toBe(1);
    draw();
    draw();
    expect(fake.writes.filter((w) => w.buffer.label?.endsWith('-vb')).length).toBe(1);
    expect(sceneDraws(fake).length).toBe(1);
    expect(layer.count).toBe(1);
  });

  it('depthOf agrees with Iso.depth and refresh re-reads a changed elevation', () => {
    const iso = createIso({ tileW: 10, tileH: 20, originX: 100, originY: 50 });
    let lift = 0;
    const { layer, r } = setup({
      columns: 3,
      rows: 3,
      order: 'painter',
      diamond: true,
      iso,
      elevation: (c, row) => (c === 2 && row === 0 ? lift : 0),
    });
    const uploads = capture(r);
    layer.fill([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(layer.depthOf(2, 0)).toBe(iso.depth(2, 0, 0));
    expect(layer.depthOf(1, 1, 3)).toBe(iso.depth(1, 1, 3));
    expect(layer.depthOf(0, 2)).toBeLessThan(layer.depthOf(2, 1));
    // Diamond placement: tile (2, 0)'s quad top-left is its centre less (tileW / 2, iso.tileH / 2).
    const draw = () => {
      const f = r.beginFrame(0, 0);
      layer.draw(f);
      r.endFrame();
    };
    draw();
    const pt = { x: 0, y: 0 };
    iso.toScreen(2, 0, 0, pt);
    let band2 = uploads.get('tile-layer-2-vb')!;
    expect([...band2[0]!.slice(0, 2)]).toEqual([pt.x - 5, pt.y - 10]);
    // Lift it: nothing moves until refresh; then one upload of that band.
    lift = 1;
    draw();
    expect(band2.length).toBe(1);
    layer.refresh(2, 0);
    expect(layer.elevationAt(2, 0)).toBe(1);
    expect(layer.depthOf(2, 0)).toBe(iso.depth(2, 0, 1));
    draw();
    band2 = uploads.get('tile-layer-2-vb')!;
    expect(band2.length).toBe(2);
    iso.toScreen(2, 0, 1, pt);
    expect([...band2[1]!.slice(0, 2)]).toEqual([pt.x - 5, pt.y - 10]);
    expect(uploads.get('tile-layer-0-vb')!.length).toBe(1);
    // refresh() without arguments walks every tile; nothing changed, nothing uploads.
    layer.refresh();
    draw();
    expect(uploads.get('tile-layer-2-vb')!.length).toBe(2);
  });

  it('refuses diamond without an iso', () => {
    expect(() => setup({ order: 'painter', diamond: true })).toThrow(/diamond/);
  });
});
