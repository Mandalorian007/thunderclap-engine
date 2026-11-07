# Brief: ws/assets-4

Read `docs/briefs/common.md` first. Then read:
- the ws/api-render wishes in `docs/STATUS.md`: gltf-load sun `direction` and a single anim `skinPose` helper
- the render README sections on lights (`SunLight`) and skinning (`SkinPalette.write`/`params`)
- the assets and anim READMEs
- `docs/guide/characters.md`

## Goal

A loaded glTF scene lights itself with the new sun shape, and a skinned character takes one call per frame to pose.

The STATUS row is done when all of these hold:

- **gltf sun.** `loadGltf` maps a `KHR_lights_punctual` directional light to a `SunLight` with `direction`. That direction is the node's world -Z, in the engine's convention. Test: a fixture with a rotated directional light gives the expected direction within 1e-5.
- **skinPose.** Add an anim helper, `skinPose(skeleton, clipState, palette, slot)` or the closest honest signature. It runs the sample, local-to-world, inverse-bind and `palette.write(slot)` steps in one call, with no allocation per frame.
  - Tests: its output matches the five-step path bit for bit, and a steady-state call allocates nothing.
- **Docs.**
  - Rewrite the skinning section of `docs/guide/characters.md` around `skinPose`. Its snippets must pass `check:snippets`.
  - Update the assets and anim READMEs, and add a CHANGELOG *Added* block.
  - Run `pnpm api:update`.

## Files owned

You own:
- `src/{assets,anim}/**` and their READMEs
- `docs/guide/characters.md`
- `api/*.api.txt` (regenerated)
- `CHANGELOG.md`

Do not edit `src/render/**`, because ws/render-10 is editing it. Use the public `SkinPalette` API, and record any gap as a wish. Do not edit `src/{core,ui,input}/**` either (ws/api-core), or `demos/**`.

Branch from `origin/main`. Use `E2E_PORT_OFFSET=1330`.

Gate:
- `pnpm check` and `snap:check`
- `gltf`, `gltf3` and `skin`, each run alone
