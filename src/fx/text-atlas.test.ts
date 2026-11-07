import { describe, expect, it } from 'vitest';
import { type AtlasCanvas, type AtlasContext2D, TextAtlas } from './text-atlas';

/** A 2D context stub: 10 px per character, records draw calls. */
function stubCanvas(size: number): { canvas: AtlasCanvas; calls: string[] } {
  const calls: string[] = [];
  const ctx: AtlasContext2D = {
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    measureText: (t) => ({ width: t.length * 10 }),
    fillText: (t, x, y) => calls.push(`fill ${t} ${x} ${y}`),
    strokeText: (t) => calls.push(`stroke ${t}`),
    clearRect: (x, y, w, h) => calls.push(`clear ${x} ${y} ${w} ${h}`),
  };
  return { canvas: { width: size, height: size, getContext: () => ctx }, calls };
}

describe('TextAtlas', () => {
  it('packs strings on shelves and returns uv regions', () => {
    const { canvas } = stubCanvas(256);
    const atlas = new TextAtlas({ size: 256, canvas });
    const a = atlas.text('ab', { size: 32, padding: 0 })!;
    const b = atlas.text('cde', { size: 32, padding: 0 })!;
    expect(a.width).toBe(20);
    expect(a.height).toBe(40);
    expect(a.u0).toBe(0);
    expect(a.v0).toBe(0);
    expect(a.u1).toBeCloseTo(20 / 256);
    expect(a.v1).toBeCloseTo(40 / 256);
    // Same shelf, to the right.
    expect(b.u0).toBeCloseTo(20 / 256);
    expect(b.v0).toBe(0);
    expect(atlas.count).toBe(2);
    expect(atlas.dirty).toBe(true);
    expect(atlas.used).toBeCloseTo((50 * 40) / (256 * 256));
  });

  it('caches by text and style; a different style rasterises again', () => {
    const { canvas, calls } = stubCanvas(256);
    const atlas = new TextAtlas({ size: 256, canvas });
    const a = atlas.text('hi');
    const fills = calls.filter((c) => c.startsWith('fill')).length;
    expect(atlas.text('hi')).toBe(a);
    expect(calls.filter((c) => c.startsWith('fill')).length).toBe(fills);
    expect(atlas.text('hi', { color: '#f00' })).not.toBe(a);
    expect(atlas.count).toBe(2);
    atlas.markUploaded();
    expect(atlas.dirty).toBe(false);
    atlas.text('hi');
    expect(atlas.dirty).toBe(false);
  });

  it('strokes before filling when a stroke is set', () => {
    const { canvas, calls } = stubCanvas(256);
    const atlas = new TextAtlas({ size: 256, canvas });
    atlas.text('x', { stroke: '#000', strokeWidth: 3 });
    const s = calls.findIndex((c) => c.startsWith('stroke'));
    const f = calls.findIndex((c) => c.startsWith('fill'));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(f);
  });

  it('returns null for a string larger than the canvas', () => {
    const { canvas } = stubCanvas(64);
    const atlas = new TextAtlas({ size: 64, canvas });
    expect(atlas.text('0123456789', { size: 16 })).toBeNull();
    expect(atlas.text('ok', { size: 64 })).toBeNull();
    expect(atlas.count).toBe(0);
  });

  it('evicts the least recently used shelf when full, keeping touched regions', () => {
    const { canvas } = stubCanvas(100);
    const atlas = new TextAtlas({ size: 100, canvas });
    // Each string is 100 wide and 20 tall: one per shelf, five shelves fill the canvas.
    const style = { size: 16, padding: 0 };
    const rows = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee'].map(
      (t) => atlas.text(t, style)!,
    );
    expect(atlas.count).toBe(5);
    expect(atlas.evictions).toBe(0);
    // Keep the first row alive (a live quad shows it); b is then the oldest.
    atlas.touch(rows[0]!);
    const f = atlas.text('ffffffffff', style)!;
    expect(atlas.evictions).toBe(1);
    expect(atlas.count).toBe(5);
    expect(atlas.has(rows[0]!)).toBe(true);
    expect(atlas.has(rows[1]!)).toBe(false);
    expect(atlas.has(f)).toBe(true);
    // The new string took b's row.
    expect(f.v0).toBeCloseTo(20 / 100);
    // The evicted key rasterises again, evicting the next oldest (c).
    atlas.text('bbbbbbbbbb', style);
    expect(atlas.evictions).toBe(2);
    expect(atlas.has(rows[2]!)).toBe(false);
  });

  it('starts over when no shelf is tall enough', () => {
    const { canvas } = stubCanvas(100);
    const atlas = new TextAtlas({ size: 100, canvas });
    const small = { size: 16, padding: 0 };
    for (const t of ['a', 'b', 'c', 'd', 'e'])
      atlas.text(`${t}${t}${t}${t}${t}${t}${t}${t}${t}${t}`, small);
    const tall = atlas.text('T', { size: 40, padding: 0 })!;
    expect(tall.v0).toBe(0);
    expect(atlas.count).toBe(1);
  });

  it('clear forgets everything and marks the canvas dirty', () => {
    const { canvas, calls } = stubCanvas(64);
    const atlas = new TextAtlas({ size: 64, canvas });
    const r = atlas.text('a')!;
    atlas.markUploaded();
    atlas.clear();
    expect(atlas.count).toBe(0);
    expect(atlas.used).toBe(0);
    expect(atlas.has(r)).toBe(false);
    expect(atlas.dirty).toBe(true);
    expect(calls.at(-1)).toBe('clear 0 0 64 64');
  });
});

describe('TextAtlas owned cells (ws/fx-4)', () => {
  it('a cell is uncached, rounded up for headroom, and rewritten in place when the text fits', () => {
    const { canvas, calls } = stubCanvas(256);
    const atlas = new TextAtlas({ size: 256, canvas });
    const c = atlas.cell('HP 10', { padding: 0 })!;
    expect(c.width).toBe(64); // 50 px of text, rounded up to 32s
    expect(atlas.cellSize('HP 10', { padding: 0 })).toEqual({ width: 64, height: c.height });
    expect(atlas.text('HP 10', { padding: 0 })).not.toBe(c);
    atlas.markUploaded();
    calls.length = 0;
    const same = atlas.rewrite(c, 'HP 9')!;
    expect(same).toBe(c);
    expect(calls).toEqual([`clear 0 0 64 ${c.height}`, `fill HP 9 32 ${c.height / 2}`]);
    expect(atlas.dirty).toBe(true);
    expect(atlas.has(c)).toBe(true);
  });

  it('grows into a wider cell and releases the old one when the text does not fit', () => {
    const { canvas } = stubCanvas(256);
    const atlas = new TextAtlas({ size: 256, canvas });
    const c = atlas.cell('abc', { padding: 0 })!;
    const count = atlas.count;
    const wide = atlas.rewrite(c, 'abcdefghij')!;
    expect(wide).not.toBe(c);
    expect(wide.width).toBe(128);
    expect(atlas.has(c)).toBe(false);
    expect(atlas.has(wide)).toBe(true);
    expect(atlas.count).toBe(count);
    atlas.release(wide);
    expect(atlas.has(wide)).toBe(false);
    expect(atlas.count).toBe(count - 1);
    atlas.release(wide); // twice is a no-op
    expect(atlas.count).toBe(count - 1);
    expect(() => atlas.rewrite(atlas.text('x')!, 'y')).toThrow(/owned/);
  });
});
