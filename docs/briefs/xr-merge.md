# Brief: ws/xr-merge (C8)

Read:
- `common.md` and `wave-2.0-3.md`
- the engine's XR (`src/platform/xr-*`, `src/kit/xr.ts`, `xr-fake.ts`)
- B3's views (`setViewFromMatrices`, `CullGroup`)

Merge ws/core-views first if it isn't on main.

Forge sources, read only: `FW:xr/**`, which covers session, input, pointer, keyboard, comfort, pivot, height, ladder, speed, layer-depth, controller-models, stereo, emulate and the `dev` tools.

## Goal

One XR layer for every 3D game, built from the engine's own XR and Forge's, on B3's views. VR is shelved as a Forge priority, but the engine must not lose any of Forge's XR capability.

1. **Sessions:** XR sessions on the core. Each XR eye becomes a core view through `setViewFromMatrices`, and both eyes go in one union `CullGroup`. Move `core/game.ts`'s XR render path off the immediate `Renderer` onto the core (B3's ask). Keep the immediate path only where B2's runs still need it.
2. **Input:** controllers and hands become C7's intents (aim rays, select, squeeze), with controller models.
3. **Comfort** from Forge: snap and smooth turn, vignette, seated or standing height, and speed limits, as options, not rules.
4. **Emulation:** the emulator and fake-XR setups from both sides are merged into one `./testing` fake.

## Done when

- The fake-XR tests from both sides are ported and green.
- The stereo page runs on the emulator (e2e) with one cull dispatch for both eyes.
- `xr.spec` passes on Chromium, and on WebKit if it applies.

## Size

M–L, mostly moving and generalizing.
