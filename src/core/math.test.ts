import { describe, expect, it } from 'vitest';
import { mat4 } from './math';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]!).toBeCloseTo(b[i]!, -Math.log10(eps));
};

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translation(x: number, y: number, z: number) {
  const m = mat4.create();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

describe('mat4', () => {
  it('creates and resets the identity', () => {
    const m = mat4.create();
    expect([...m]).toEqual(I);
    m[3] = 7;
    expect([...mat4.identity(m)]).toEqual(I);
  });

  it('multiplies column-major (b first, then a) and allows aliasing', () => {
    const t = translation(1, 2, 3);
    const s = mat4.create();
    s[0] = 2;
    s[5] = 2;
    s[10] = 2;
    const out = mat4.multiply(mat4.create(), t, s); // scale, then translate
    const p = [0, 0, 0];
    mat4.transformPoint(p, out, 1, 1, 1);
    expect(p).toEqual([3, 4, 5]);
    mat4.multiply(s, s, t); // translate, then scale; out aliases a
    mat4.transformPoint(p, s, 1, 1, 1);
    expect(p).toEqual([4, 6, 8]);
  });

  it('inverts, and reports singular matrices', () => {
    const m = mat4.create();
    mat4.lookAt(m, [3, 4, 5], [0, 1, 0], [0, 1, 0]);
    const inv = mat4.invert(mat4.create(), m)!;
    close(mat4.multiply(mat4.create(), m, inv), I);
    const zero = new Float32Array(16);
    const out = mat4.create();
    expect(mat4.invert(out, zero)).toBeNull();
    expect([...out]).toEqual(I);
  });

  it('ortho maps the box to clip space with 0..1 depth', () => {
    const m = mat4.ortho(mat4.create(), 0, 100, 50, 0, 1, 11); // y down
    const p = [0, 0, 0];
    mat4.transformPoint(p, m, 0, 0, -1);
    close(p, [-1, 1, 0]);
    mat4.transformPoint(p, m, 100, 50, -11);
    close(p, [1, -1, 1]);
  });

  it('perspective maps near to 0 and far to 1, finite or infinite', () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 2, 2, 1, 100);
    const p = [0, 0, 0];
    expect(mat4.transformPoint(p, m, 0, 0, -1)).toBeCloseTo(1);
    close(p, [0, 0, 0]);
    mat4.transformPoint(p, m, 0, 0, -100);
    expect(p[2]).toBeCloseTo(1);
    // 90° fov: at depth 10, y = 10 is the top edge; aspect 2 → x = 20 is the right edge.
    mat4.transformPoint(p, m, 20, 10, -10);
    close([p[0]!, p[1]!], [1, 1]);
    mat4.perspective(m, Math.PI / 2, 1, 1, Number.POSITIVE_INFINITY);
    mat4.transformPoint(p, m, 0, 0, -1);
    expect(p[2]).toBeCloseTo(0);
    mat4.transformPoint(p, m, 0, 0, -1e9);
    expect(p[2]).toBeCloseTo(1);
  });

  it('lookAt puts the eye at the origin looking down -z', () => {
    const m = mat4.lookAt(mat4.create(), [0, 0, 10], [0, 0, 0], [0, 1, 0]);
    const p = [0, 0, 0];
    mat4.transformPoint(p, m, 0, 0, 0);
    close(p, [0, 0, -10]);
    mat4.lookAt(m, [10, 0, 0], [0, 0, 0], [0, 1, 0]);
    mat4.transformPoint(p, m, 0, 0, -1); // to the eye's right when looking down -x
    close(p, [1, 0, -10]);
  });

  it('view2d is the identity at rest and pans, zooms and turns about the centre', () => {
    const m = mat4.view2d(mat4.create(), 0, 0, 1, 0, 200, 100);
    close(m, I);
    const p = [0, 0, 0];
    mat4.view2d(m, 10, 5, 2, 0, 200, 100);
    mat4.transformPoint(p, m, 110, 55); // the pan target lands on the centre
    close(p, [100, 50, 0]);
    mat4.transformPoint(p, m, 120, 55);
    close(p, [120, 50, 0]); // zoom 2 about the centre
    mat4.view2d(m, 0, 0, 1, Math.PI / 2, 200, 100);
    mat4.transformPoint(p, m, 110, 50); // the view turns clockwise, so the world turns back
    close(p, [100, 40, 0]);
  });

  it('copies', () => {
    const a = translation(1, 2, 3);
    expect([...mat4.copy(mat4.create(), a)]).toEqual([...a]);
  });
});
