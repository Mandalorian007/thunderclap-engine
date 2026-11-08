# Brief: ws/hosts-tidy

Read `docs/briefs/common.md`, E-037 and E-039 in `docs/DECISIONS.md`, `docs/releasing.md`, the READMEs and `package.json` of `packages/host-capacitor` and `packages/host-pwa`, and the "host-capacitor peer" entry under "Publishing follow-ups" in `docs/IDEAS.md`.

## Goal

A small, low-risk cleanup to host-capacitor and host-pwa, so each ships a new patch version through CI trusted publishing. It is their first CI publish; until now only the engine and host-electron have published that way. This rides on the 1.2.1 tag with the engine's WebXR-types fix.

STATUS row, *done when*:

- **host-capacitor peer (IDEAS), ruled yes.** Add `@capacitor/core` as an *optional* peer (`peerDependenciesMeta`), at the major the repo already uses or else the current one (latest only, no older ranges). It documents what the host runs inside; the package still imports no `@capacitor/*` module. Say so in the README's install section. Strike the IDEAS entry through as fixed.
- **host-pwa tidy.** Read the README against `src/` and fix whatever is stale or missing, for example an install line, the `pwaPlugin` options table, or the `host.pwa` members. Docs and manifest only. If you find nothing worth changing, say so; a code change needs the PM first.
- **Versions.** Bump `packages/host-capacitor` and `packages/host-pwa` to `0.1.1`. Don't touch the root version; the PM cuts 1.2.1. Add CHANGELOG `## Unreleased` lines naming both packages and their new versions.

## Files owned

`packages/host-capacitor/{package.json,README.md}`, `packages/host-pwa/{package.json,README.md}`, `docs/IDEAS.md` (that one entry), CHANGELOG `## Unreleased`, and `pnpm-lock.yaml` if the peer changes it. No `src/`, no `api/`.

## Gate

`pnpm check` and `pnpm check:pack`. No e2e is needed: nothing under `src/` changes.
