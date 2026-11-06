# Demo: dungeon

A 2D top-down dungeon crawl at game scale, to validate the engine's 2D path end to end. Run it
with `pnpm demo dungeon` (or `pnpm exec vite demos/dungeon --host 127.0.0.1`) and open the URL
Vite prints. `?still` parks the bats and the torch flicker from the first frame, the same as
`__demo.park(true)`, so a probe reads a steady room. To start a 2D game of your own from this
shape, `pnpm create-game` scaffolds a project on the same public API.

## What to look at

- One material, one draw call for the whole room: about 2200 sprite instances (tiles, torches,
  coins, bats, the player and the fog quads) from a 128×128 atlas `atlas.ts` paints on a canvas.
- 60 bats on a four-frame flipbook bouncing off walls; a touch costs a health point, flashes the
  player and plays a synthesised thud.
- The HUD in the top layout region: a coin line kept in `save` (survives a reload) and a
  `ui.meter` health bar whose tone goes success → warn → danger as the bats chip at it; a coin
  gives a point back.
- Torches whose tint follows `flicker`, with `emissive` so bloom glows them, under a fog-of-war
  layer (one dark quad per tile on layer 2, alpha by distance from the player and the torches);
  the pause menu's "Fog" button masks the layer off through `camera.layers`.
- The pause menu (Escape, P or Start) on `ui.stack`: the `PanelStack`'s own arrow walking
  (`arrowNav: 'vertical'`, the default) moves focus on ArrowUp/ArrowDown and wraps, and a `PadNav`
  drives the same stack from the pad and the demo's fake pad; a fake press is latched until the
  `PadNav` has seen it. The demo handles no menu keys itself.

## Known limits

The health bar stays `ui.meter`: it is the HUD primitive (`role="meter"`, region-aware, tones),
where the widgets `bar` is a panel progress row (`role="progressbar"`). The spec asserts the meter.

## What it shows

- A 40×30 tile map (nine rooms, L-shaped corridors, pillars) drawn from a 128×128 atlas that `atlas.ts` paints on a canvas at boot: floor, wall, torch, coin, player, four bat wing frames and a white cell for the fog. One material, one draw call for the whole room (about 2200 instances).
- 60 bats with a four-frame flipbook, bouncing off walls; touching one plays a synthesised thud, flashes the player and costs one of ten health points (`ui.meter`); a coin gives one back.
- A player square moved by arrows/WASD, a gamepad (d-pad or left stick) or a touch drag, read as one stick (`input.stick`, length clamped to 1), with axis-separated box collision so it stops flush against walls (`map.ts`, `moveBox`).
- The room layout, the coins and the bats come from `createRandom` (`core`); the hit cooldown is a `createScheduler` cooldown.
- Torches whose tint follows `flicker`, with `emissive` so bloom glows them.
- A fog-of-war layer: one dark quad per tile on layer 2, alpha by distance from the player and the torches; the pause menu's "Fog" button masks the layer off through `camera.layers`.
- A pause menu (Escape, P or Start) on `ui.stack`, walked by the stack's arrow keys and a `PadNav` that also reads the demo's fake pad. A fake press (`__demo.pad(i, true)`) stays down until the `PadNav` has observed it in an update, so a release in the same frame, or a frame the loop skipped under load, cannot lose the step.
- A coin counter kept in `save` (`thunderclap:demo-dungeon:main`) that survives reloads, with a HUD line in the top layout region.
- Pickup and hit sounds from `recipes.chime` / `recipes.thud` on the `sfx` bus.

## Engine modules

`createGame` (core), `core` (`createRandom`, `createScheduler`), `render` (`textureFromSource`, `createSpriteMaterial`, `DrawParams`, layers), `fx` (`flicker`), `input` (bindings, gestures), `ui` (`stack`, `PadNav`, `button`, `h`, `layout`, `meter`, toasts), `save`, `audio`, `post` (bloom).

## What the spec checks

`e2e/demos/dungeon.spec.ts` (served through the harness Vite server's `/demos/dungeon/` route) reads `window.__demo.state` (`frame`, `fps`, `stats`, `drawCalls`, `coins`, `health`, `bats`, `playerTile`, `playerPos`, `paused`, `focused`, ...) after a `requestAnimationFrame` settle and asserts: no console errors, 60 bats, one draw call, a `role="meter"` health bar with `aria-valuemax` 10, fps > 20 on the desktop rows; holding ArrowLeft stops the player on tile (2, 5) flush against the wall at x = 1; holding ArrowRight picks up the coin at (6, 5) and `coins` is still 1 after a reload; Escape opens the pause menu and ArrowUp/ArrowDown and the fake d-pad (`__demo.pad(13, true)`, held until `focused` reads the next item, then released) move focus, A activates, and movement keys do nothing while it is open.
