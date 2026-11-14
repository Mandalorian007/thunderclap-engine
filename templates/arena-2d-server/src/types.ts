/**
 * The arena's wire types as TypeScript sees them (the schema itself, `./schema`, is generated from
 * the Rust).
 */

/** A position in arena units: a player's body. */
export interface Pos {
  x: number;
  y: number;
}

/** One player in the entity stream. */
export interface Player {
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  it: boolean;
}

/** The scoreboard (`score {}`). */
export interface Score {
  it: number | bigint;
  players: { id: number | bigint; name: string; tags: number; present: boolean }[];
}
