# Brief: ws/publish-2

Read `docs/briefs/common.md`, E-037 in `docs/DECISIONS.md`, `docs/releasing.md`, `.github/workflows/publish.yml`, `scripts/pack-smoke.mjs`, and the "Publishing follow-ups" entry in `docs/IDEAS.md`.

## Goal

Make the tag-to-npm release fail safe and leave a trail. This branch's release (1.1.1) is also the first one CI publishes through trusted publishing, so it proves the path end to end.

STATUS row, *done when*:

- **Plain `npm publish` is refused.** Running `npm publish` in the repo root or a host folder, outside a tarball made by `pnpm pack`, fails with a message pointing at `docs/releasing.md`. Publishing a tarball made by `pnpm pack` still works. Choose the mechanism (for example a `prepublishOnly` check on a marker that only pack writes, or a published manifest that differs from the workspace one), and say why. `check:pack` covers both cases.
- **Install-from-npm check.** After the publish loop, `publish.yml` waits for each newly published version to appear on the registry (poll with a cap). It then installs those versions into a fresh project, typechecks it and imports every entry. Reuse `pack-smoke.mjs`'s consumer project by letting it take registry versions in place of tarballs.
- **GitHub Release.** After a successful publish, the workflow creates a GitHub Release for the tag. The body is that version's CHANGELOG section. It needs `contents: write` and uses `gh`. A release that already exists is updated, not duplicated.
- **Docs and changelog.** Update `docs/releasing.md`, and add a CHANGELOG `## Unreleased` *Fixed* or *Added* line.

## Files owned

`.github/workflows/publish.yml`, `scripts/pack-smoke.mjs`, the root and `packages/*/package.json` (scripts and publish fields only), any new `scripts/*publish*` file, `docs/releasing.md`, CHANGELOG. Leave `src/` and `api/` alone.

## Not in scope

Running `npm publish`, creating tags or running `pnpm release`; the PM does those.

## Gate

`pnpm check`, `pnpm snap:check` at 0 px and `pnpm check:pack`. Run `actionlint` on the workflows if it's available; say if it isn't.
