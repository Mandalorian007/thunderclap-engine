/**
 * Block light for streamed sections: light from emitting blocks (`BlockDef.emission`, 0..15),
 * flooded in the mesher like sky light is, each cell lit in one of eight hues.
 *
 * A section's mesh reads light from its padded volume, but light reaches up to 14 blocks
 * from a level-15 emitter: further than the one-cell border. So a job near emitters carries
 * the 27 sections around its own whole (the "wide" volume, `3 × size` on a side), and the
 * flood runs through it from every emitter whose light can reach the padded volume. With
 * sections of 15 or more, every path light takes to the padded volume stays inside the wide
 * volume, so a section reads exactly what a flood over the whole world would give and two
 * sections agree on the cells they share. Smaller sections clip light at the wide volume's
 * edge (still seamless where it is the same).
 *
 * Dial's algorithm: cells are taken brightest first, so each spreads once at its final level.
 * Passing into a block costs its `lightCost` (0 stops light); light that can no longer reach
 * the padded volume is pruned. Where two lights tie, the lower hue wins, so the result does not
 * depend on the order emitters are found in.
 */
import type { VoxelFormat } from './format';

/** Reusable buffers for one thread's block light flood. */
export class BlockLightFlood {
  /** Cells spread from by the last flood (its work, for tests and benchmarks). */
  visited = 0;
  private readonly size: number;
  private readonly wideSide: number;
  private readonly level: Uint8Array;
  private readonly hue: Uint8Array;
  private readonly buckets: number[][] = Array.from({ length: 16 }, () => []);

  constructor(private readonly format: VoxelFormat) {
    this.size = format.size;
    this.wideSide = 3 * format.size;
    const n = this.wideSide ** 3;
    this.level = new Uint8Array(n);
    this.hue = new Uint8Array(n);
  }

  /**
   * Flood light through `wide` (cells, `(3 × size)³`, x fastest then z then y, the section at
   * size..2size−1) from the emitters in the sources `sources` names (bits of the 27 in
   * `sourceIndex` order), and write each padded cell's level and hue to `outLevel`, `outHue`
   * (padded index). Returns whether any padded cell is lit.
   */
  fill(wide: Uint32Array, sources: number, outLevel: Uint8Array, outHue: Uint8Array): boolean {
    const S = this.size;
    const W = this.wideSide;
    const WA = W * W;
    const P = S + 2;
    const PA = P * P;
    const LO = S - 1;
    const HI = 2 * S;
    const { idShift, idMask } = this.format;
    const { emission, hue: hueOf, lightCost } = this.format.blocks;
    const level = this.level;
    const hue = this.hue;
    const buckets = this.buckets;
    const dist = (x: number, y: number, z: number): number =>
      (x < LO ? LO - x : x > HI ? x - HI : 0) +
      (y < LO ? LO - y : y > HI ? y - HI : 0) +
      (z < LO ? LO - z : z > HI ? z - HI : 0);
    level.fill(0);
    let seeds = 0;
    for (let s = 0; s < 27; s++) {
      if ((sources & (1 << s)) === 0) continue;
      const x0 = (s % 3) * S;
      const z0 = (Math.floor(s / 3) % 3) * S;
      const y0 = Math.floor(s / 9) * S;
      for (let y = y0; y < y0 + S; y++) {
        for (let z = z0; z < z0 + S; z++) {
          let i = x0 + z * W + y * WA;
          for (let x = x0; x < x0 + S; x++, i++) {
            const id = (wide[i] >>> idShift) & idMask;
            const e = emission[id] ?? 0;
            if (!e) continue;
            if (e <= dist(x, y, z) || e < level[i]) continue;
            const h = hueOf[id];
            if (e === level[i] && h >= hue[i]) continue;
            level[i] = e;
            hue[i] = h;
            buckets[e].push(i);
            seeds++;
          }
        }
      }
    }
    let visited = 0;
    if (seeds > 0) {
      for (let l = 15; l >= 1; l--) {
        const b = buckets[l];
        for (let k = 0; k < b.length; k++) {
          const i = b[k];
          if (level[i] !== l) continue;
          visited++;
          const x = i % W;
          const z = Math.floor(i / W) % W;
          const y = Math.floor(i / WA);
          const h = hue[i];
          for (let n = 0; n < 6; n++) {
            let j: number;
            let nx = x;
            let ny = y;
            let nz = z;
            if (n === 0) {
              if (x === 0) continue;
              j = i - 1;
              nx--;
            } else if (n === 1) {
              if (x === W - 1) continue;
              j = i + 1;
              nx++;
            } else if (n === 2) {
              if (z === 0) continue;
              j = i - W;
              nz--;
            } else if (n === 3) {
              if (z === W - 1) continue;
              j = i + W;
              nz++;
            } else if (n === 4) {
              if (y === 0) continue;
              j = i - WA;
              ny--;
            } else {
              if (y === W - 1) continue;
              j = i + WA;
              ny++;
            }
            const cost = lightCost[(wide[j] >>> idShift) & idMask] ?? 0;
            if (cost === 0) continue;
            const nl = l - cost;
            if (nl <= 0) continue;
            const old = level[j];
            if (nl < old || (nl === old && h >= hue[j])) continue;
            if (nl <= dist(nx, ny, nz)) continue;
            level[j] = nl;
            hue[j] = h;
            buckets[nl].push(j);
          }
        }
        b.length = 0;
      }
    }
    this.visited = visited;
    let lit = false;
    for (let py = 0; py < P; py++) {
      for (let pz = 0; pz < P; pz++) {
        const w = LO + (pz + LO) * W + (py + LO) * WA;
        const p = pz * P + py * PA;
        for (let px = 0; px < P; px++) {
          const v = level[w + px];
          outLevel[p + px] = v;
          if (v) {
            outHue[p + px] = hue[w + px];
            lit = true;
          } else {
            outHue[p + px] = 0;
          }
        }
      }
    }
    return lit;
  }
}
