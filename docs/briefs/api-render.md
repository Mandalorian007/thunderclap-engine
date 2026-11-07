# Brief: ws/api-render

Read `docs/briefs/common.md` first. Then read DECISIONS E-036, the ws/docs-guide wishes in `docs/STATUS.md`, the `api/index.api.txt` sections for render, post and fx, those three modules' READMEs, and `docs/guide/{2d-game,3d-game,characters,style-and-post}.md`.

## Goal

Get render, post and fx ready for v1. Apply E-036 and fix the friction the guides found. Every change is additive or keeps a deprecated alias, and the 2D harness stays pixel-identical.

STATUS row, *done when*:

- **E-036.**
  - Deprecate the render internals that only tests use: `CAMERA_*_OFFSET`, `*_OFFSET_FLOATS`, `LIGHTS_BLOCK_FLOATS`, `SKIN_PALETTE_HEADER_FLOATS`, `BUFFER_BINDING_BASE`, `STANDARD_WGSL`, `SPRITE_WGSL`. Tests import them from their source files.
  - Deprecate `Renderer.white` in favour of `defaultTextures.white`.
  - Rename `BlendMode` on the render/post side to `PostBlendMode` or similar, keeping an alias.
  - Rename `Hit` and `Aabb` on the render side if the render module exports them.
  - Apply the getter rule where E-036 calls for it.
  - Leave the fx WGSL chunks public.
- **Ergonomics.**
  - `setScale(s)` on a 3D node scales all three axes. 2D callers must not change, so check `harness/*` stays at 0 px.
  - Give one spelling to the two fogs (`lights.fog` and the post `fog`), or document which one wins and make the other a forwarder.
  - Name `defaultPostSettings` as a neutral preset, with the tuned look exported under its own name.
  - `createSpriteMaterial` takes an options object; the positional form is deprecated.
  - Make Lights field shapes consistent.
  - `godRays` takes a world-space sun direction, alongside the 2D px placement.
  - Make the LOD types line up.
  - Reduce skinning to one helper that covers the five steps the characters guide shows.
  - `atlasFrames` accepts an `inset`.
  - `screenToWorld` gets a 2D overload with no depth.
  - Each item gets a unit or harness test. Any item that would break a caller becomes a wish instead.
- **Docs.**
  - Update the render, post and fx READMEs. Their snippet blocks must pass.
  - Update the four guides above to the new spellings.
  - Add a CHANGELOG entry, with deprecations under *Deprecated*.
  - Run `pnpm api:update`.

## Files owned

- `src/{render,post,fx}/**` and their READMEs
- `docs/guide/{2d-game,3d-game,characters,style-and-post}.md`
- `api/*.api.txt` (regenerated)
- `CHANGELOG.md`
- ARCHITECTURE: one phrase per module

Do not edit `src/{core,ui,input}/**` (ws/api-core), the other modules (ws/api-rest), `demos/**`, `templates/**` or `harness/*` goldens.

Branch from `origin/main` after train 13 lands. Use `E2E_PORT_OFFSET=1270`.

Gate:
- `pnpm check`, plus `snap:check` at 0 px
- These specs, each run alone: mesh, render4, post3, post4, depth-post, skin, decals, fx3, sprite
