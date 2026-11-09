# Brief: ws/prepackage

Read `docs/briefs/common.md`, E-040 in `docs/DECISIONS.md`, `packages/host-electron/README.md` and its desktop config code, and GitHub issue #4 (`gh issue view 4`).

## Goal

STATUS row, *done when*:
- The `thunderclap.desktop` config accepts an optional `prePackage` command.
- `thunderclap-desktop package` runs it in the game's folder before staging, and `package --dry-run` runs it too. A non-zero exit fails the command with a clear message.
- The README documents it. The config tests cover the parse, the run and the failure.
- Bump `packages/host-electron` to `0.3.0` and add a CHANGELOG `## Unreleased` line. The PM cuts the root version.
- It is additive: a config without `prePackage` behaves exactly as before.

## Files owned

`packages/host-electron/**` only, plus the CHANGELOG `## Unreleased` lines and `pnpm-lock.yaml` if it changes.

Running alongside: ws/crash and ws/layout-check (`src/`). Don't edit their files.

## Gate

`pnpm check`, `pnpm check:pack`, and the host-electron tests. Run the Electron smoke if the package command path changed.
