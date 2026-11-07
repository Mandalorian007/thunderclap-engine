# Brief: ws/v1-cut

Read `docs/briefs/common.md` first. Then read:
- DECISIONS E-036, especially its *v1 gate*
- `docs/guide/migrating-to-v1.md` (the table and § Removal)
- `scripts/check-deprecated.mjs`, `scripts/check-api*` and `api/`
- `CHANGELOG.md`

## Goal

Cut `engine-v1.0.0` in the tree. Remove every deprecated engine alias and freeze `api/` as the v1 surface.

The STATUS row is done when all of the following hold.

**Removal.** Delete every `@deprecated` engine export, member, overload and settings key listed in the migration guide. This includes:
- `src/ui/deprecated.ts`
- the render internals file
- the `Hit`/`Aabb`/`Rect`/… aliases
- getter-replaced methods such as `getGestures`
- `SunLight.dir`
- the `fog` settings key
- the positional `createSpriteMaterial` overload
- `GltfSceneLights` `dir`

Tests that live only under `// deprecated-alias test` go too. Code under `// deprecated-alias impl` collapses to the v1 path. Tests that import internals from a source file, per E-036 *Internals*, keep working.

Platform deprecations such as DOM `execCommand` are not ours and stay.

**Zero left.** A grep for `@deprecated` in `src/**` finds only platform shims, each named in your report. `check:deprecated` passes with the exemption markers removed. Drop the markers too, unless the checker still needs them for platform names.

**Freeze.**
- Regenerate `api/*.api.txt`. The diff must be removals only; any addition is a bug.
- Add a header line to each snapshot: `engine-v1.0.0 frozen surface`.
- Extend `check:api` so that any `api/` diff fails, unless CHANGELOG `## Unreleased` has a *Breaking* or *Added* line naming the changed module. Unit-test that rule.

**Version.**
- Set `package.json` `version` to `1.0.0`.
- Turn CHANGELOG `## Unreleased` into `## 1.0.0 (2026-11-07)`, with a *Removed* section listing every alias by module. Open a fresh empty `## Unreleased` above it.
- Update the root README *Status* section and the migration guide (including guide line ~119, `PostStack.addJitterCamera`, which says "the rest go in the next minor"): aliases are removed in 1.0.0, and the guide is the map from 0.x.
- Do **not** create a git tag. The PM and the user tag.

**Templates and demos.** These already use no deprecated names. Confirm `check:create-game` and `check:deprecated` both pass.

**Gate:**
- `pnpm check` green
- `snap:check` at 0 px
- the full e2e once under the slot (E-030), with 0 failed

## Files owned

You own the whole repo except `docs/{STATUS,DECISIONS,VISION,PM}.md` and `docs/briefs/`. You are the only stream running.

Branch from origin/main after train 17 lands. Use `E2E_PORT_OFFSET=1380`.
