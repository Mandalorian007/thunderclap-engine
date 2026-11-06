/**
 * The level format: one string per row, one character per tile. Pure TypeScript: no engine, no
 * DOM. `CLAUDE.md` *Levels* explains the characters; `parseLevel` turns the strings into the
 * typed arrays and lists the scenes and the physics read.
 *
 * ```
 * ' '  air                 '#'  solid ground          '-'  one-way platform (land from above)
 * '^'  hazard (spikes)     'o'  coin                  'c'  checkpoint
 * 'p'  spawn (exactly one) 'x'  exit (exactly one)    'm'  moving-platform path (a run of 2+)
 * ```
 */

/** One tile's size in world px (the design space is 1920×1080, so a view is 30×16.875 tiles). */
export const TILE = 64;
/** A moving platform's size in tiles (wide) and px (tall). */
export const MOVER_W = 2;
export const MOVER_H = TILE / 2;
/** A moving platform's speed along its path, px/s. */
export const MOVER_SPEED = 120;

export const EMPTY = 0;
export const SOLID = 1;
export const ONE_WAY = 2;
export const HAZARD = 3;
export type TileKind = typeof EMPTY | typeof SOLID | typeof ONE_WAY | typeof HAZARD;

export interface TilePos {
  readonly col: number;
  readonly row: number;
}

/** A moving platform's path: the platform's top-left travels from `(x0, y0)` to `(x1, y1)` in px. */
export interface MoverPath {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** One leg (end to end), seconds. */
  readonly legSeconds: number;
}

export interface Level {
  readonly id: string;
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  /** Row-major `TileKind` per tile. */
  readonly kinds: Uint8Array;
  readonly coins: readonly TilePos[];
  readonly checkpoints: readonly TilePos[];
  readonly spawn: TilePos;
  readonly exit: TilePos;
  readonly movers: readonly MoverPath[];
}

/** The characters the parser accepts. */
export const CHARS = {
  air: ' ',
  solid: '#',
  oneWay: '-',
  hazard: '^',
  coin: 'o',
  checkpoint: 'c',
  spawn: 'p',
  exit: 'x',
  mover: 'm',
} as const;

const KIND_OF: Readonly<Record<string, TileKind>> = {
  '#': SOLID,
  '-': ONE_WAY,
  '^': HAZARD,
};

/**
 * Parses a level. Throws with the row and column of the first problem: ragged rows, an unknown
 * character, no or several spawns or exits, a moving-platform path shorter than two cells.
 */
export function parseLevel(id: string, name: string, lines: readonly string[]): Level {
  if (lines.length === 0) throw new Error(`level ${id}: no rows`);
  const rows = lines.length;
  const cols = lines[0]!.length;
  if (cols === 0) throw new Error(`level ${id}: row 0 is empty`);
  const kinds = new Uint8Array(cols * rows);
  const coins: TilePos[] = [];
  const checkpoints: TilePos[] = [];
  const movers: MoverPath[] = [];
  let spawn: TilePos | null = null;
  let exit: TilePos | null = null;
  const moverCells = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row++) {
    const line = lines[row]!;
    if (line.length !== cols) {
      throw new Error(`level ${id}: row ${row} has ${line.length} columns, row 0 has ${cols}`);
    }
    for (let col = 0; col < cols; col++) {
      const ch = line[col]!;
      const i = row * cols + col;
      const kind = KIND_OF[ch];
      if (kind !== undefined) {
        kinds[i] = kind;
        continue;
      }
      switch (ch) {
        case CHARS.air:
          break;
        case CHARS.coin:
          coins.push({ col, row });
          break;
        case CHARS.checkpoint:
          checkpoints.push({ col, row });
          break;
        case CHARS.spawn:
          if (spawn) throw new Error(`level ${id}: second spawn at row ${row}, col ${col}`);
          spawn = { col, row };
          break;
        case CHARS.exit:
          if (exit) throw new Error(`level ${id}: second exit at row ${row}, col ${col}`);
          exit = { col, row };
          break;
        case CHARS.mover:
          moverCells[i] = 1;
          break;
        default:
          throw new Error(`level ${id}: unknown character '${ch}' at row ${row}, col ${col}`);
      }
    }
  }
  if (!spawn) throw new Error(`level ${id}: no spawn ('p')`);
  if (!exit) throw new Error(`level ${id}: no exit ('x')`);

  // Moving-platform paths: each run of 'm' cells, horizontal first, else vertical.
  const seen = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (!moverCells[i] || seen[i]) continue;
      let c1 = col;
      while (c1 + 1 < cols && moverCells[row * cols + c1 + 1] && !seen[row * cols + c1 + 1]) c1++;
      let r1 = row;
      if (c1 === col) while (r1 + 1 < rows && moverCells[(r1 + 1) * cols + col]) r1++;
      if (c1 === col && r1 === row) {
        throw new Error(`level ${id}: moving-platform path at row ${row}, col ${col} is one cell`);
      }
      for (let r = row; r <= r1; r++) for (let c = col; c <= c1; c++) seen[r * cols + c] = 1;
      const x0 = col * TILE;
      const y0 = row * TILE;
      const x1 = c1 * TILE;
      const y1 = r1 * TILE;
      const length = Math.hypot(x1 - x0, y1 - y0);
      movers.push({ x0, y0, x1, y1, legSeconds: length / MOVER_SPEED });
    }
  }

  return { id, name, cols, rows, kinds, coins, checkpoints, spawn, exit, movers };
}

/**
 * The tile kind at `(col, row)`. Outside the level: the sides are solid, above is air (a jump
 * can leave the top), below is air (a fall off the bottom is a death, see `physics/player.ts`).
 */
export function kindAt(level: Level, col: number, row: number): TileKind {
  if (col < 0 || col >= level.cols) return SOLID;
  if (row < 0 || row >= level.rows) return EMPTY;
  return level.kinds[row * level.cols + col] as TileKind;
}

/**
 * Where a moving platform's top-left is at time `t` (seconds since the level started): a triangle
 * wave along the path, so it shuttles end to end, writing the delta since `t - dt` into `out`.
 */
export function moverAt(
  path: MoverPath,
  t: number,
  dt: number,
  out: { x: number; y: number; dx: number; dy: number },
): void {
  const f = fraction(path, t);
  const g = fraction(path, t - dt);
  out.x = path.x0 + (path.x1 - path.x0) * f;
  out.y = path.y0 + (path.y1 - path.y0) * f;
  out.dx = (path.x1 - path.x0) * (f - g);
  out.dy = (path.y1 - path.y0) * (f - g);
}

function fraction(path: MoverPath, t: number): number {
  const leg = path.legSeconds;
  if (leg <= 0) return 0;
  const u = (((t / leg) % 2) + 2) % 2;
  return u <= 1 ? u : 2 - u;
}
