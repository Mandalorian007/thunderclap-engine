/**
 * Engine harness e2e ports, shared by playwright.config.ts and the specs.
 *
 * Uses the same per-checkout offset as the game's tests/e2e/ports.ts: `E2E_PORT_OFFSET` if set,
 * else a stable offset for git worktrees under `.claude/worktrees/`, else 0. That way parallel
 * worktrees never test each other's servers. The base ports end in 7 and 8 and the offsets step
 * by 10, so in any checkout they never collide with the game's ports, which end in 3, 5, 0 and 1.
 */
import { createHash } from 'node:crypto';

const WORKTREES = '/.claude/worktrees/';

function offset(): number {
  const env = process.env.E2E_PORT_OFFSET;
  if (env !== undefined && env !== '') return Number(env);
  const cwd = process.cwd();
  const i = cwd.indexOf(WORKTREES);
  if (i < 0) return 0;
  // Hash the worktree root (the repo root of a checkout), so the offset matches the game's.
  const name = cwd.slice(i + WORKTREES.length).split('/')[0];
  const n = createHash('sha1')
    .update(`${cwd.slice(0, i)}${WORKTREES}${name}`)
    .digest()
    .readUInt16BE(0);
  return 10 + (n % 90) * 10;
}

export const PORT_OFFSET = offset();
/** Vite dev server for harness/ (the top-level page). */
export const HARNESS_PORT = 4177 + PORT_OFFSET;
/** The itch-style wrapper page, which embeds the harness from a different site. */
export const WRAPPER_PORT = 4178 + PORT_OFFSET;

/** The harness is served from 127.0.0.1 and the wrapper from localhost: two sites, like itch. */
export const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}/`;
export const WRAPPER_URL = `http://localhost:${WRAPPER_PORT}/`;
