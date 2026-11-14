/**
 * The arena's wire schema, the twin of `server/src/game.rs`: its hash must equal the server's,
 * which `shared/schema-hash.txt` holds (both sides' tests check it). Change a type here and in the
 * Rust together, then rerun `cargo test` there with `TC_BLESS=1`.
 */
import { defineSchema } from '@thunderclap-engine/engine/net';

export const schema = defineSchema({
  types: {
    Pos: { struct: { x: 'i32', y: 'i32' } },
    Player: {
      struct: { name: 'String', x: 'i32', y: 'i32', vx: 'i32', vy: 'i32', it: 'bool' },
    },
    Entry: { struct: { id: 'u64', name: 'String', tags: 'u32', present: 'bool' } },
    Score: { struct: { it: 'u64', players: { vec: 'Entry' } } },
  },
  roles: { input: 'u8', state: 'Pos' },
  roots: ['Player'],
  queries: { score: { result: 'Score' } },
});

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
