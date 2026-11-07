/**
 * The arena: a rolling heightfield with a flat middle and a few stone blocks. Pure: the engine's
 * `geom` heightfield (arithmetic, no GPU) and nothing else; the scene turns it into a mesh with
 * `heightfieldGeometry` and the controller walks it with `heightAt`. Everything derives from the
 * sine table below, so the Worker-free test and the page agree.
 */
import { createHeightfield, type Heightfield, heightAt } from '@thunderclap-engine/engine/geom';

/** Half the arena's side, world units; the controller keeps everyone inside. */
export const HALF = 23;
/** Samples per side; one sample per world unit. */
const SAMPLES = 49;

/** An axis-aligned block the controller slides around; `min`/`max` are world corners. */
export interface Block {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface Ground {
  readonly field: Heightfield;
  readonly blocks: readonly Block[];
}

/** Surface height at world (x, z). */
export function groundHeight(g: Ground, x: number, z: number): number {
  return heightAt(g.field, x, z);
}

function bump(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // Flat in the middle, rolling towards the edge, rising into a rim.
  const roll = 0.55 * Math.sin(x * 0.31) * Math.cos(z * 0.27) + 0.35 * Math.sin((x + z) * 0.17);
  const centre = Math.min(1, Math.max(0, (r - 5) / 9));
  const rim = Math.max(0, r - 19) * 0.45;
  return roll * centre + rim;
}

export function createGround(): Ground {
  const field = createHeightfield(SAMPLES, SAMPLES, {
    scale: [1, 1, 1],
    origin: [-(SAMPLES - 1) / 2, 0, -(SAMPLES - 1) / 2],
  });
  for (let z = 0; z < SAMPLES; z++) {
    for (let x = 0; x < SAMPLES; x++) {
      field.heights[z * SAMPLES + x] = bump(x + field.origin[0], z + field.origin[2]);
    }
  }
  const stone = (x: number, z: number, w: number, h: number): Block => {
    const y = heightAt(field, x, z) - 0.3;
    return { min: [x - w / 2, y, z - w / 2], max: [x + w / 2, y + h, z + w / 2] };
  };
  const blocks: Block[] = [
    stone(7, -6, 2.2, 1.6),
    stone(-9, 4, 1.8, 2.4),
    stone(3, 11, 2.6, 1.2),
    stone(-6, -12, 2, 1.9),
    stone(13, 7, 1.6, 2.8),
  ];
  return { field, blocks };
}

/**
 * Push a circle of `radius` at (x, z) out of every block it overlaps (shortest axis) and inside
 * the arena. Writes `out[0]`, `out[1]` (x, z). Pure, no allocation.
 */
export function resolveXZ(
  g: Ground,
  x: number,
  z: number,
  radius: number,
  out: Float32Array,
): Float32Array {
  const lim = HALF - radius;
  x = Math.min(lim, Math.max(-lim, x));
  z = Math.min(lim, Math.max(-lim, z));
  for (const b of g.blocks) {
    const cx = Math.min(b.max[0], Math.max(b.min[0], x));
    const cz = Math.min(b.max[2], Math.max(b.min[2], z));
    const dx = x - cx;
    const dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      x = cx + (dx / d) * radius;
      z = cz + (dz / d) * radius;
    } else {
      // Inside the block: leave through the nearest face.
      const left = x - b.min[0];
      const right = b.max[0] - x;
      const front = z - b.min[2];
      const back = b.max[2] - z;
      const m = Math.min(left, right, front, back);
      if (m === left) x = b.min[0] - radius;
      else if (m === right) x = b.max[0] + radius;
      else if (m === front) z = b.min[2] - radius;
      else z = b.max[2] + radius;
    }
  }
  out[0] = x;
  out[1] = z;
  return out;
}
