# Brief: ws/api-rest

Read `docs/briefs/common.md` first. Then read:
- DECISIONS E-036
- the ws/harden-api audit row, the ws/docs-modules tween wish and the ws/docs-guide tooling wishes in `docs/STATUS.md`
- `api/*.api.txt` for the modules below
- `templates/*/package.json`, `packages/*/package.json` and the `create-game` script
- `docs/guide/{getting-started,testing-your-game,xr}.md`

## Goal

Apply E-036 to the remaining modules and make the path from "copy a template" to a built game work.

The STATUS row is done when:

- **E-036 in analytics, anim, assets, audio, geom, host, i18n, nav, platform, save, tween and voxel.**
  - Rename `Cell`, `Grid`, `PlayOptions` (anim/audio), `FollowTarget`, `Aabb` (geom side), `Rect` (platform side) and `prefersReducedMotion` (platform side) with deprecated aliases. Coordinate with the names ws/api-core picks: input `Rect` becomes `Edges`, and ui keeps `Rect` only if it matches platform.
  - Deprecate save `TYPED_CTORS`.
  - Apply the getter rule: `AssetCache.stats`, and `Host.active` and `Host.state`.
  - `snapToGrid`'s output fits `MagnifyOptions.snap`.
- **Tween.** `update` treats NaN `dt` as 0. Add a test.
- **Templates and tooling.**
  - Every template has a `build` script that produces a static bundle.
  - `create-game` defaults its engine dependency to the version a user can install today. Use a `file:`/workspace link when it runs inside the repo, and state the published-version plan in the README.
  - The template `package.json` descriptions no longer say "Copy the folder…".
  - The `./testing` entry exports what the testing guide needs beyond the fake GPU (for example a fake host and a fixed clock), if those already exist internally.
  - Test: scaffold each template into `/tmp/ar-*`, then install offline and build it.
- **Docs.** Update the module READMEs and the three guides above. Add a CHANGELOG block (*Deprecated* where needed) and run `pnpm api:update`.

## Files owned

- `src/{analytics,anim,assets,audio,geom,host,i18n,nav,platform,save,tween,voxel}/**` and their READMEs
- `templates/**`
- `packages/*/package.json`
- the `create-game` script
- `docs/guide/{getting-started,testing-your-game,xr}.md`. ws/api-core also edits getting-started; you own only its *Templates* and *Ship it* sections.
- `api/*.api.txt` (regenerated)
- `CHANGELOG.md`

Do not edit `src/{core,ui,input,render,post,fx}/**` or `demos/**`.

Branch from `origin/main` after train 13 lands. Use `E2E_PORT_OFFSET=1280`.

Gate:
- `pnpm check` and `snap:check`
- the template e2e specs, each run alone
- save, gltf, gltf3, audio4, nav and voxel
