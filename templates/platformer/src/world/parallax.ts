/**
 * Three-layer parallax from tile layers. Each layer is a short pattern (strings, like a level)
 * repeated across the view; `update` slides the layer's origin so it scrolls at `factor` of the
 * camera and wraps every pattern period. One draw per layer.
 *
 * The engine has `createTileLayer` but no parallax helper; this is what the template wrote.
 */
import {
  createTileLayer,
  type Frame,
  type Material,
  type Renderer,
  type TileLayer,
} from '@thunderclap/engine/render';
import { TILE } from '../levels/format';
import { ATLAS_COLS, ATLAS_ROWS, CELL } from './atlas';

interface LayerSpec {
  /** 0 = pinned to the sky, 1 = moves with the world. */
  factor: number;
  /** Pattern characters, see `GLYPH`. All rows the same length; the width is the period. */
  pattern: readonly string[];
  /** Rows of air above the pattern when the view is taller than it. */
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

export interface Parallax {
  /** Aims every layer for a view whose top-left is `(camLeft, camTop)`. */
  update(camLeft: number, camTop: number): void;
  draw(frame: Frame): void;
  destroy(): void;
}

export function createParallax(
  renderer: Renderer,
  material: Material,
  viewW: number,
  viewH: number,
  worldH: number,
): Parallax {
  const viewCols = Math.ceil(viewW / TILE) + 1;
  const layers: {
    layer: TileLayer;
    spec: LayerSpec;
    periodPx: number;
    params: { tint: [number, number, number, number] };
  }[] = [];
  for (const spec of SPECS) {
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
    const t = spec.tint;
    layers.push({ layer, spec, periodPx: period * TILE, params: { tint: [t, t, t, 1] } });
  }
  const groundY = worldH - TILE;
  return {
    update(camLeft, camTop) {
      for (const l of layers) {
        const scroll = camLeft * l.spec.factor;
        l.layer.origin.x = camLeft - (((scroll % l.periodPx) + l.periodPx) % l.periodPx);
        // The pattern's bottom row sits on the world's ground line, eased by the same factor so
        // climbing lifts the far layers less than the near ones.
        const baseTop = groundY - l.layer.rows * TILE;
        const pinned = camTop + viewH - l.layer.rows * TILE;
        l.layer.origin.y = baseTop + (pinned - baseTop) * (1 - l.spec.factor);
      }
    },
    draw(frame) {
      for (const l of layers) l.layer.draw(frame, l.params);
    },
    destroy() {
      for (const l of layers) l.layer.destroy();
    },
  };
}
