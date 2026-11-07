/**
 * The ws/nav-5 reach bench: `reachable` on a 10k-polygon mesh, in a file of its own so the JIT
 * sees only this mesh (the other reach tests mix area costs, links and small meshes). The numbers
 * it prints are the ones the nav README records.
 */
import { describe, expect, it } from 'vitest';
import { reachable } from '../reach';
import { createMeshReach, reachableOutline } from './mesh-reach';
import { NavMesh } from './navmesh';

/** A `w × h` grid of unit quads on y = 0, one polygon per cell. */
function quadMesh(w: number, h: number): NavMesh {
  const verts = new Float32Array((w + 1) * (h + 1) * 3);
  for (let z = 0; z <= h; z++) {
    for (let x = 0; x <= w; x++) {
      const i = (z * (w + 1) + x) * 3;
      verts[i] = x;
      verts[i + 2] = z;
    }
  }
  const polys = new Int32Array(w * h * 4);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const v = z * (w + 1) + x;
      polys.set([v, v + w + 1, v + w + 2, v + 1], (z * w + x) * 4);
    }
  }
  return new NavMesh(verts, (w + 1) * (h + 1), polys, w * h, 4, 1, 0.2);
}

function time(run: () => void, runs = 31): { best: number; median: number } {
  for (let i = 0; i < 50; i++) run();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { best: times[0]!, median: times[runs >> 1]! };
}

describe('reach bench', () => {
  it('a 10k-polygon mesh finishes within 3× of its 1.2 ms best', () => {
    const mesh = quadMesh(100, 100);
    expect(mesh.polyCount).toBe(10000);
    const out = createMeshReach(mesh);
    const at = { x: 50.5, y: 0, z: 50.5 };
    const whole = time(() => reachable(mesh, at, { budget: Infinity }, out), 101);
    expect(out.count).toBe(10000);
    const range = time(() => reachable(mesh, at, { budget: 12 }, out));
    const rangeCount = out.count;
    const outline = time(() => reachableOutline(out));
    console.log(
      `reachable 10k polys: whole mesh best ${whole.best.toFixed(2)} / median ${whole.median.toFixed(2)} ms; ` +
        `budget 12 (${rangeCount} polys) ${range.best.toFixed(3)} / ${range.median.toFixed(3)} ms; ` +
        `outline ${outline.best.toFixed(3)} / ${outline.median.toFixed(3)} ms`,
    );
    // Best of 101, not the median: at load 25-29 (ws/nav-6, 8+ runs) the best was 1.1-2.6 ms and
    // the median 1.2-9.9 ms (preemption), against 1.2 ms for both unloaded. 4 ms is about 3× the
    // unloaded time, so only a real regression fails, not a loaded machine.
    expect(whole.best).toBeLessThan(4);
  });
});
