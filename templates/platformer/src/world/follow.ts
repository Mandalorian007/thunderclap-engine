/**
 * 2D camera follow: a dead zone around the target, look-ahead in the facing direction, and a
 * clamp to the level. Pure; `scenes/level.ts` copies the result onto `ctx.camera.x/y`.
 *
 * The engine's `Camera` has 2D pan but no follow helper yet; this is what the template wrote.
 */

export interface FollowOptions {
  /** View size in world px. */
  viewW: number;
  viewH: number;
  /** World bounds the view stays inside. */
  worldW: number;
  worldH: number;
  /** Half-size of the dead zone around the view centre, px. */
  deadX: number;
  deadY: number;
  /** How far ahead of the target the view centre leads, px. */
  lookAhead: number;
  /** Seconds for the look-ahead to settle (exponential). */
  lookAheadTime: number;
  /** Seconds for the vertical follow to settle (exponential); 0 = instant. */
  smoothY: number;
}

export interface Follow {
  /** View centre, world px. */
  x: number;
  y: number;
  /** Current look-ahead offset. */
  lead: number;
}

export function createFollow(cx: number, cy: number): Follow {
  return { x: cx, y: cy, lead: 0 };
}

/**
 * Advances `f` toward `(tx, ty)` (the target's centre) with `facing` (+1/-1, or 0 to relax the
 * lead) over `dt`. The horizontal follow is dead-zoned around the led point; the vertical is
 * dead-zoned then smoothed; both are clamped so the view never shows outside the world.
 */
export function updateFollow(
  f: Follow,
  tx: number,
  ty: number,
  facing: number,
  dt: number,
  o: FollowOptions,
): void {
  // Look-ahead eases toward the facing direction.
  const wantLead = facing * o.lookAhead;
  const k = o.lookAheadTime > 0 ? 1 - Math.exp(-dt / o.lookAheadTime) : 1;
  f.lead += (wantLead - f.lead) * k;

  const aimX = tx + f.lead;
  if (aimX > f.x + o.deadX) f.x = aimX - o.deadX;
  else if (aimX < f.x - o.deadX) f.x = aimX + o.deadX;

  let aimY = f.y;
  if (ty > f.y + o.deadY) aimY = ty - o.deadY;
  else if (ty < f.y - o.deadY) aimY = ty + o.deadY;
  const ky = o.smoothY > 0 ? 1 - Math.exp(-dt / o.smoothY) : 1;
  f.y += (aimY - f.y) * ky;

  f.x = clampCentre(f.x, o.viewW, o.worldW);
  f.y = clampCentre(f.y, o.viewH, o.worldH);
}

/** Snaps the view onto the target (level start, respawn). */
export function snapFollow(f: Follow, tx: number, ty: number, o: FollowOptions): void {
  f.lead = 0;
  f.x = clampCentre(tx, o.viewW, o.worldW);
  f.y = clampCentre(ty, o.viewH, o.worldH);
}

function clampCentre(c: number, view: number, world: number): number {
  const half = view / 2;
  if (world <= view) return world / 2;
  return Math.min(world - half, Math.max(half, c));
}
