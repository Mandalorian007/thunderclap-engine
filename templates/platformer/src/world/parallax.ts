/**
 * Three-layer parallax: each layer is a short pattern (strings, like a level) repeated across the
 * view as a tile layer; the engine's `createParallax` slides every layer's origin at `factor` of
 * the camera and wraps it every pattern period. One draw per layer.
 */
import {
  createParallax as createEngineParallax,
  createTileLayer,
  type Material,
  type Parallax,
  type ParallaxLayerOptions,
  type Renderer,
} from '@thunderclap-engine/engine/render';
import { TILE } from '../levels/format';
import { ATLAS_COLS, ATLAS_ROWS, CELL } from './atlas';

export type { Parallax } from '@thunderclap-engine/engine/render';

interface LayerSpec {
  /** 0 = pinned to the sky, 1 = moves with the world. */
  factor: number;
  /** Pattern characters, see `GLYPH`. All rows the same length; the width is the period. */
  pattern: readonly string[];
  /** Brightness: far layers are darker. */
  tint: number;
}

const GLYPH: Readonly<Record<string, number>> = {
  ' ': -1,
  '^': CELL.peak,
  M: CELL.mountain,
  n: CELL.hillTop,
  H: CELL.hill,
  T: CELL.treeTop,
  t: CELL.trunk,
  c: CELL.cloud,
  '*': CELL.star,
};

const SPECS: readonly LayerSpec[] = [
  {
    factor: 0.15,
    tint: 0.55,
    pattern: [
      '  *       c          *      ',
      '      *          *          ',
      '   c         *        c     ',
      '           ^                ',
      '     ^    MMM    ^      ^   ',
      '    MMM  MMMMM  MMM  ^ MMM  ',
      '   MMMMMMMMMMMMMMMMMMMMMMMMM',
      'MMMMMMMMMMMMMMMMMMMMMMMMMMMM',
    ],
  },
  {
    factor: 0.4,
    tint: 0.75,
    pattern: [
      '                        ',
      '      nnn        nn     ',
      '   nnnHHHnn    nnHHnn   ',
      ' nnHHHHHHHHHnnnHHHHHHnnn',
      'HHHHHHHHHHHHHHHHHHHHHHHH',
    ],
  },
  {
    factor: 0.7,
    tint: 0.9,
    pattern: ['                ', '  T       T     ', '  t   T   t  T  ', '  t   t   t  t  '],
  },
];

/**
 * Builds the three layers for a view of `viewW × viewH` over a world `worldH` tall and hands them
 * to the engine's `createParallax`; `update(camLeft, camTop)` aims them, `draw` draws them in
 * far-to-near order, `destroy` releases them.
 */
export function createParallax(
  renderer: Renderer,
  material: Material,
  viewW: number,
  viewH: number,
  worldH: number,
): Parallax {
  const viewCols = Math.ceil(viewW / TILE) + 1;
  const groundY = worldH - TILE;
  const layers: ParallaxLayerOptions[] = SPECS.map((spec) => {
    const period = spec.pattern[0]!.length;
    const rows = spec.pattern.length;
    const columns = viewCols + period;
    const layer = createTileLayer(renderer, {
      material,
      tileW: TILE,
      tileH: TILE,
      columns,
      rows,
      atlas: { cols: ATLAS_COLS, rows: ATLAS_ROWS },
      label: `parallax-${spec.factor}`,
    });
    for (let r = 0; r < rows; r++) {
      const line = spec.pattern[r]!;
      for (let c = 0; c < columns; c++) {
        const idx = GLYPH[line[c % period]!] ?? -1;
        if (idx >= 0) layer.set(c, r, idx);
      }
    }
    // The pattern's bottom row sits on the world's ground line when the view's bottom is there,
    // eased by the same factor so climbing lifts the far layers less than the near ones. The
    // engine adds `camTop × (1 - factor)` to this base on every `update`.
    const baseTop = groundY - rows * TILE;
    layer.origin.y = baseTop + (viewH - rows * TILE - baseTop) * (1 - spec.factor);
    const t = spec.tint;
    return {
      layer,
      factorX: spec.factor,
      factorY: spec.factor,
      wrapW: period * TILE,
      params: { tint: [t, t, t, 1] },
    };
  });
  return createEngineParallax(renderer, layers);
}
