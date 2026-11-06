# Demo: dungeon

A 2D top-down dungeon crawl at game scale, to validate the engine's 2D path end to end. Run it with `pnpm exec vite demos/dungeon --host 127.0.0.1` (or `pnpm demo dungeon` once the root script lands) and open the URL Vite prints.

## What it shows

- A 40×30 tile map (nine rooms, L-shaped corridors, pillars) drawn from a 128×128 atlas that `atlas.ts` paints on a canvas at boot: floor, wall, torch, coin, player, four bat wing frames and a white cell for the fog. One material, one draw call for the whole room (about 2200 instances).
- 60 bats with a four-frame flipbook, bouncing off walls; touching one plays a synthesised thud and flashes the player.
- A player square moved by arrows/WASD, a gamepad (d-pad or left stick) or a touch drag, with axis-separated box collision so it stops flush against walls (`map.ts`, `moveBox`).
- Torches whose tint follows `flicker`, with `emissive` so bloom glows them.
- A fog-of-war layer: one dark quad per tile on layer 2, alpha by distance from the player and the torches; the pause menu's "Fog" button masks the layer off through `camera.layers`.
- A pause menu (Escape, P or Start) on `ui.stack`, walked with the arrow keys and a `PadNav` that also reads the demo's fake pad.
- A coin counter kept in `save` (`thunderclap:demo-dungeon:main`) that survives reloads, with a HUD line in the top layout region.
- Pickup and hit sounds from `recipes.chime` / `recipes.thud` on the `sfx` bus.

## Engine modules

`createGame` (core), `render` (`textureFromSource`, `createSpriteMaterial`, `DrawParams`, layers), `fx` (`flicker`), `input` (bindings, gestures), `ui` (`stack`, `PadNav`, `button`, `h`, `layout`, toasts), `save`, `audio`, `post` (bloom).

## What the spec checks

`e2e/demos/dungeon.spec.ts` (served through the harness Vite server's `/@fs/` route) reads `window.__demo.state` (`frame`, `fps`, `stats`, `drawCalls`, `coins`, `bats`, `playerTile`, `playerPos`, `paused`, `focused`, ...) and asserts: no console errors, 60 bats, one draw call, fps > 20 on the desktop rows; holding ArrowLeft stops the player on tile (2, 5) flush against the wall at x = 1; holding ArrowRight picks up the coin at (6, 5) and `coins` is still 1 after a reload; Escape opens the pause menu and ArrowUp/ArrowDown and the fake d-pad (`__demo.pad(13, true)`) move focus, A activates, and movement keys do nothing while it is open.
