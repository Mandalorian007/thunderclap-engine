# Brief: ws/docs-guide

Read `docs/briefs/common.md` first, then `docs/VISION.md`, the root `README.md`, `docs/OFFERING.md`, `ARCHITECTURE.md`, `scripts/check-docs.mjs`, `scripts/create-game.mjs`, `examples/hello/` and each `templates/*/CLAUDE.md`. After that, read only the module READMEs and code a guide needs.

## Goal

Someone who has never seen the engine can go from clone to a running game of their own in one sitting, using only the docs. Every code block they copy compiles against the engine as it is today.

Today the README describes the engine as of wave 4 or 5. `OFFERING.md` lists what landed through wave 4. There is no guide layer between the README and the module references, and most of those references run 200 to 1300 lines.

The STATUS row is done when:

- **Root `README.md` is rewritten for a first-time user. Keep its tone and The Last Rune section.**
  - **Features** describes the engine as it is on main. Include PBR, the post stack (TAA, SSR, AO, motion blur), skinning, sockets, picking, LOD, nav, voxel, HUD widgets, record and replay, analytics and i18n. Each feature gets one line and its entry point.
  - **Quick start** covers all four templates and what each is for. Use `pnpm create-game --list`.
  - A new **Guides** section links each guide.
  - **Status and roadmap** says where the engine is now, in five lines at most. Delete the wave-by-wave history, which CHANGELOG already holds.
  - Keep the harness list and the count line exactly as they are. Other branches edit them.
- **`docs/guide/`** holds short, task-shaped guides of 150 to 400 lines each. Every guide ends with *Next* links to the module reference.
  1. `getting-started.md`: scaffold, run, the shape of a game (`createGame`, scenes, ctx, the loop), then ship to itch.io, Electron or a PWA.
  2. `2d-game.md`: sprites, the camera, materials in your own WGSL, particles and the layout regions.
  3. `3d-game.md`: perspective, meshes, glTF, the lights block, shadows, PBR, LOD and culling.
  4. `characters.md`: skinned glTF, the animation mixer, sockets for cosmetics and `Follow`. This is the E-015 path.
  5. `input.md`: actions and bindings, gestures, pointers as rays, `Look`, pads and touch zones, then record and replay with `ctx.replay`.
  6. `ui-and-hud.md`: overlay, regions and rails, the widgets (orbs, floats, minimap), anchors and world panels, theme and text scale.
  7. `style-and-post.md`: the post stack, quality tiers, FX, sky, water and weather.
  8. `xr.md`: entering VR, controllers and hands, per-eye post, panels.
  9. `testing-your-game.md`: deterministic replay tests, the harness pattern and `expect.poll`. Base it on what the templates ship.
- **Snippet check.**
  - Add `scripts/check-snippets.mjs`, using Node built-ins plus the repo's own `tsc`, and wire it into `pnpm check`.
  - It extracts every fenced `ts` block in `docs/guide/**` and the root `README.md`. In a module README it extracts only the blocks immediately preceded by `<!-- snippet:check -->`, which ws/docs-modules adds.
  - It typechecks each block against the package's public entry points.
  - A block may opt out with the info string `ts no-check`. Use that only for a fragment, and say why in the prose next to it.
  - Test: a broken snippet fails the check, and a fixed one passes.
- **`docs/OFFERING.md`** is refreshed to main as of today: one line per capability with its entry point. Remove its wave-4 framing.
- **CHANGELOG:** one *Docs* line.

## Files owned

You own:
- `README.md`, except its harness list and count line
- `docs/guide/**` (new)
- `docs/OFFERING.md`
- `scripts/check-snippets.mjs` and its test
- the `check:snippets` script line in `package.json` and its place in `check`
- `CHANGELOG.md`

Do not edit:
- `src/**`
- the module READMEs (ws/docs-modules owns them)
- `templates/**`
- `demos/**`
- `docs/{VISION,STATUS,DECISIONS,PM}.md`
- `docs/briefs/**`

If a guide finds an API that is awkward to explain, report it as a wish; that is the point of the exercise.

Branch from `origin/main`. Use `E2E_PORT_OFFSET=1220`. Gate: `pnpm check` (snippets included) and `snap:check`. You run no e2e unless you touch something e2e reads.
