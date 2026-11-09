// The `thunderclap.desktop.prePackage` step of `thunderclap-desktop package` (#4): a game's own
// command, such as generating its icon, run in the game's folder before the app is staged.
import { spawnSync } from 'node:child_process';

/**
 * Runs `command` through the system shell in `cwd`, with its output passed through. Throws when
 * it cannot start, is killed by a signal or exits non-zero; the message names the command.
 * @param {string} command the `prePackage` command line
 * @param {string} cwd the game's folder
 * @param {{ stdio?: import('node:child_process').StdioOptions }} [opts] default `inherit`
 */
export function runPrePackage(command, cwd, opts = {}) {
  const r = spawnSync(command, { cwd, shell: true, stdio: opts.stdio ?? 'inherit' });
  if (r.error) throw new Error(`prePackage "${command}" could not start: ${r.error.message}`);
  if (r.signal) throw new Error(`prePackage "${command}" was killed by ${r.signal}`);
  if (r.status !== 0) throw new Error(`prePackage "${command}" failed with exit code ${r.status}`);
}
