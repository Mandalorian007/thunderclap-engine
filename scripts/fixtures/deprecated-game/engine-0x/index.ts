// Stands in for a 0.x engine (scripts/check-deprecated-game.test.mjs): a renamed type that
// still has its deprecated alias.
export interface RayHit {
  t: number;
}
/** @deprecated Use `RayHit`. */
export type Hit = RayHit;
