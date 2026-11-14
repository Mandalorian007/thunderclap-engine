/**
 * The voxel-world page's section codec (harness/voxel-world.html): runs of cells, as a game's
 * server might send them. Bytes are little-endian u32 pairs `[count, cell]` in cell order (x
 * fastest, then z, then y); one u32 is a uniform section. Shared by the page and its Workers.
 */
import type { SectionCodec } from '@thunderclap-engine/engine/voxel';

export const RUNS_CODEC: SectionCodec = {
  decode(bytes, out) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    if (words.length === 1) return words[0]!;
    let at = 0;
    for (let i = 0; i < words.length; i += 2) {
      const n = words[i]!;
      out.fill(words[i + 1]!, at, at + n);
      at += n;
    }
    if (at !== out.length) throw new RangeError(`runs cover ${at} cells, expected ${out.length}`);
    return null;
  },
};

/** Cells into `RUNS_CODEC` bytes. */
export function encodeRuns(cells: Uint32Array): Uint8Array {
  const runs: number[] = [];
  let i = 0;
  while (i < cells.length) {
    const c = cells[i]!;
    let j = i + 1;
    while (j < cells.length && cells[j] === c) j++;
    runs.push(j - i, c);
    i = j;
  }
  if (runs.length === 2) return new Uint8Array(Uint32Array.of(runs[1]!).buffer);
  return new Uint8Array(Uint32Array.from(runs).buffer);
}
