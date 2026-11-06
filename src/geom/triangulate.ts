/**
 * Ear-clipping triangulation of a simple polygon (`triangulate`), the cap step of `extrude` and
 * the whole of `polygon`. Pure arithmetic over x, y pairs.
 */

/** A closed 2D outline as x, y pairs, counter-clockwise (clockwise is accepted and reversed). */
export type Profile2D = Float32Array | number[];

/** Twice the signed area of a profile: positive counter-clockwise, negative clockwise. */
export function profileArea2(profile: Profile2D): number {
  const n = profile.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += profile[j * 2]! * profile[i * 2 + 1]! - profile[i * 2]! * profile[j * 2 + 1]!;
  }
  return a;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** `p` strictly inside, or on the edge of, triangle `a b c` (counter-clockwise). */
function inTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    cross(ax, ay, bx, by, px, py) >= 0 &&
    cross(bx, by, cx, cy, px, py) >= 0 &&
    cross(cx, cy, ax, ay, px, py) >= 0
  );
}

/**
 * Triangulate a simple polygon by ear clipping: up to `n - 2` triangles over the profile's vertex
 * indices, wound counter-clockwise in the profile's plane whatever its input winding. Concave
 * outlines are handled; collinear or repeated points are dropped as zero-area ears (so fewer
 * triangles come back). Self-intersection detection is out of scope: a self-intersecting outline
 * still triangulates completely, but which side is "inside" is undefined there. `Uint16Array` up
 * to 65535 points, `Uint32Array` past it. Fewer than three points gives an empty array. Cost is
 * O(n · r) for r reflex (inward-turning) corners, so convex outlines fan in O(n); a huge outline
 * whose corners jitter in and out of convexity (float32 rounding on a 70000-gon) is quadratic.
 */
export function triangulate(profile: Profile2D): Uint16Array | Uint32Array {
  const n = profile.length >> 1;
  const triCount = Math.max(0, n - 2);
  const out = n > 0xffff ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  if (n < 3) return out;
  // Doubly linked ring over the vertex indices, in counter-clockwise order.
  const ccw = profileArea2(profile) >= 0;
  const next = new Int32Array(n);
  const prev = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const i = ccw ? k : n - 1 - k;
    const iNext = ccw ? (k + 1) % n : n - 1 - ((k + 1) % n);
    next[i] = iNext;
    prev[iNext] = i;
  }
  const x = (i: number) => profile[i * 2]!;
  const y = (i: number) => profile[i * 2 + 1]!;
  // Reflex vertices (an inward turn) are the only ones that can sit inside a candidate ear, so
  // the containment test skips the others; a convex outline has none and fans in O(n).
  const reflex = new Uint8Array(n);
  let reflexCount = 0;
  for (let i = 0; i < n; i++) {
    const a = prev[i]!;
    const c = next[i]!;
    if (cross(x(a), y(a), x(i), y(i), x(c), y(c)) < 0) {
      reflex[i] = 1;
      reflexCount++;
    }
  }
  const updateReflex = (i: number) => {
    const was = reflex[i]!;
    const a = prev[i]!;
    const c = next[i]!;
    const now = cross(x(a), y(a), x(i), y(i), x(c), y(c)) < 0 ? 1 : 0;
    if (was !== now) {
      reflex[i] = now;
      reflexCount += now - was;
    }
  };
  let remaining = n;
  let o = 0;
  let cur = ccw ? 0 : n - 1;
  let guard = 0;
  while (remaining > 3) {
    const a = prev[cur]!;
    const b = cur;
    const c = next[cur]!;
    const area = cross(x(a), y(a), x(b), y(b), x(c), y(c));
    let ear = false;
    if (Math.abs(area) <= 1e-12 * (1 + Math.abs(x(a)) + Math.abs(y(a)))) {
      // Collinear or repeated: a zero-area ear, dropped without a triangle.
      next[a] = c;
      prev[c] = a;
      if (reflex[b]) reflexCount--;
      remaining--;
      updateReflex(a);
      updateReflex(c);
      cur = c;
      guard = 0;
      continue;
    }
    if (area > 0) {
      ear = true;
      for (let p = next[c]!; reflexCount > 0 && p !== a; p = next[p]!) {
        if (
          reflex[p] === 1 &&
          (x(p) !== x(a) || y(p) !== y(a)) &&
          (x(p) !== x(b) || y(p) !== y(b)) &&
          (x(p) !== x(c) || y(p) !== y(c)) &&
          inTriangle(x(a), y(a), x(b), y(b), x(c), y(c), x(p), y(p))
        ) {
          ear = false;
          break;
        }
      }
    }
    if (ear) {
      out[o++] = a;
      out[o++] = b;
      out[o++] = c;
      next[a] = c;
      prev[c] = a;
      remaining--;
      updateReflex(a);
      updateReflex(c);
      cur = a;
      guard = 0;
    } else {
      cur = c;
      // A full loop without an ear: the outline is not simple; clip anyway so the fan completes.
      if (++guard > remaining) {
        out[o++] = a;
        out[o++] = b;
        out[o++] = c;
        next[a] = c;
        prev[c] = a;
        if (reflex[b]) reflexCount--;
        remaining--;
        updateReflex(a);
        updateReflex(c);
        cur = a;
        guard = 0;
      }
    }
  }
  if (remaining === 3) {
    out[o++] = prev[cur]!;
    out[o++] = cur;
    out[o++] = next[cur]!;
  }
  // Dropped degenerate ears leave fewer triangles than n - 2: trim to what was written.
  return o < out.length ? out.slice(0, o) : out;
}
