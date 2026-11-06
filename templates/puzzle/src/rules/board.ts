/**
 * Pairs: the rules. Pure functions over an immutable `Board`; every move returns a new board.
 * Nothing here knows about the DOM, time or input; the one engine call is `createRandom`, the
 * seeded generator, so a seed reproduces a board exactly (a bug report or a save can name it).
 * The scene turns taps into `reveal(board, index)` and draws what comes back; the tests drive
 * the same functions.
 */
import { createRandom } from '@thunderclap/engine/core';

/** What the board is waiting for. */
export type Phase =
  /** No card is face up: the next reveal starts a pair. */
  | 'first'
  /** One card is face up: the next reveal completes the pair. */
  | 'second'
  /** Two different cards are face up: `settle` (or the next reveal) turns them back. */
  | 'mismatch'
  /** Every pair is matched. */
  | 'won';

export interface Board {
  readonly cols: number;
  readonly rows: number;
  /** The face (pair id, 0..pairs-1) of each cell, row-major. */
  readonly faces: readonly number[];
  /** Cells whose pair has been found; they stay face up. */
  readonly matched: readonly boolean[];
  /** The one or two unmatched cells currently face up, in reveal order. */
  readonly up: readonly number[];
  /** Completed pairs of reveals (a pair counts when its second card turns). */
  readonly moves: number;
  /** The seed the board was dealt from (for saves and bug reports). */
  readonly seed: number;
}

/** Deals a shuffled board. `cols * rows` must be even. */
export function createBoard(cols: number, rows: number, seed: number): Board {
  const cells = cols * rows;
  if (cells % 2 !== 0 || cells === 0)
    throw new Error(`a board needs an even number of cells, got ${cells}`);
  const pairs = cells / 2;
  const deck: number[] = [];
  for (let i = 0; i < pairs; i++) deck.push(i, i);
  return {
    cols,
    rows,
    faces: createRandom(seed).shuffle(deck),
    matched: new Array<boolean>(cells).fill(false),
    up: [],
    moves: 0,
    seed,
  };
}

export function phase(b: Board): Phase {
  if (b.matched.every(Boolean)) return 'won';
  if (b.up.length === 0) return 'first';
  if (b.up.length === 1) return 'second';
  // Two cards up are always different: `reveal` moves a matching pair straight to `matched`.
  return 'mismatch';
}

export const pairsLeft = (b: Board): number => b.matched.filter((m) => !m).length / 2;

export const cellIndex = (b: Board, col: number, row: number): number => row * b.cols + col;

/** Whether a cell currently shows its face (matched, or one of the two turned up). */
export const isFaceUp = (b: Board, index: number): boolean =>
  b.matched[index] === true || b.up.includes(index);

/** Turns a mismatched pair face down again. Any other phase returns the same board. */
export function settle(b: Board): Board {
  return phase(b) === 'mismatch' ? { ...b, up: [] } : b;
}

/**
 * Turns the card at `index` face up. A card that is already up, or an index off the board,
 * leaves the board unchanged (same object). A mismatch still on the table settles first, so a
 * quick player never has to wait for the flip-back.
 */
export function reveal(b: Board, index: number): Board {
  if (index < 0 || index >= b.faces.length) return b;
  const board = settle(b);
  if (phase(board) === 'won' || isFaceUp(board, index)) return b;
  if (board.up.length === 0) return { ...board, up: [index] };
  const first = board.up[0]!;
  const moves = board.moves + 1;
  if (board.faces[first] !== board.faces[index]) return { ...board, up: [first, index], moves };
  const matched = board.matched.slice();
  matched[first] = true;
  matched[index] = true;
  return { ...board, matched, up: [], moves };
}
