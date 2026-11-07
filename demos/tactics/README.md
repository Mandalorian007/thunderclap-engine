# Demo: tactics

An isometric turn-based skirmish: four player units against six raiders on a 24×24 diamond map
with two elevation steps. Run it with `pnpm demo tactics` and open the URL Vite prints. Tap a
unit, then a blue tile to move or a red one to attack; `E` (or the HUD button, or pad Y) ends the
turn; drag pans, wheel or pinch zooms; the arrow keys or d-pad step a tile cursor and `Enter` / A
confirms. `?still&seed=1` fixes the map and the AI's rolls (`createRandom`, the AI on its own `fork`; the toast is skipped too). To start
a 2D game of your own from this shape, `pnpm create-game` scaffolds a project on the same API.

## What to look at

- The map reads as isometric from painted tiles: `atlas.ts` paints diamond grass, mud and water
  tops and a cliff riser (left and right faces of one step) on a 512×512 canvas at boot, and
  raised tiles are drawn as stacked risers under a lifted top. No asset is committed.
- One draw call for everything: tile stacks, range overlays, cursor, units, shadows and health
  bars are sprites of one material submitted in painter's order (`tx + ty`, the tile's stack,
  then its overlay, then the unit on it). Tile layers were not used: `createTileLayer` lays a
  rectangular grid and cannot stagger a diamond, lift a tile by its height or sort units
  between tiles, so the demo keeps a sorted sprite list (about 750 instances).
- Moves cost terrain (grass 1, mud 2, water impassable) plus one per elevation step climbed or
  dropped; the blue overlay is a budget-bounded Dijkstra flood (`rules.ts`) whose parent pointers
  are the yellow path preview under the cursor and the path the unit walks, one tween per tile
  with a facing flipbook and a walk bob.
- An attack lunges the attacker, bursts particles on the target and floats a damage caption
  anchored over it through `ui.anchors`; the enemy turn walks each raider down the nav
  `createFlowField` distances toward the nearest player and attacks the weakest in reach.
- The pointer cursor is the demo's iso inverse (`iso.ts`): it tries each elevation from the top
  down and keeps the first tile that really has that height, so a raised top under the pointer
  wins over the flat tile the same pixel would cover at ground level. The spec checks it on every
  viewport and DPR.

## Known limits

Elevation steps are half a tile (16 px), so a raised tile directly in front hides the flat tile
behind it entirely; the inverse answers with what is visible. The flow field is 8-neighbour with
a per-cell cost, so raiders descend its distances over the four neighbours with the demo's own
step cost rather than following `direction()`. Units act once per turn (move, then attack if
something is in reach); there is no undo and no camera follow on the enemy turn.

## Engine modules

`createGame` (core), `render` (`textureFromSource`, `createSpriteMaterial`, `DrawParams`, `hex`),
`nav` (`createNavGrid`, `createFlowField`), `tween` (`createTweens`, `ease`), `input`
(bindings, `gestures.drag` / `pinch` / `tap`, `pointer.wheelY`, fake gamepad), `ui` (`layout`,
`anchors`, `stack`, `button`, `h`, toasts), `fx` (`ctx.particles`), `audio` (recipes on the
`sfx` bus).

## What the spec checks

`e2e/demos/tactics.spec.ts` (served through the harness Vite server's `/demos/tactics/` route)
reads `window.__demo.state` (`frame`, `fps`, `stats`, `drawCalls`, `turn`, `phase`, `units`,
`cursorTile`, `selected`, `pathLength`, `lastPathLength`, `mapHash`, `busy`, `padPresses`, `padReleases`) after a
`requestAnimationFrame` settle and asserts: a clean boot in the player phase, 4 vs 6, at most two
draw calls, no console errors; a pointer over a flat tile, a raised tile and a spawn tile sets
`cursorTile` to that tile (the spec projects the tile itself with the constants from `iso.ts`,
against the letterboxed canvas, so every row and DPR exercises the inverse); clicking the Knight
selects it, a far tile does nothing, and a two-step tile moves it (`pathLength` 2 on hover, the
unit on the new tile once `busy` clears); `KeyE` runs the enemy phase and comes back to `player`
on turn 2 with every raider moved; the latched fake d-pad steps `cursorTile` by one; and
`?still&seed=1` gives the same `mapHash` and unit list twice while `seed=2` differs.
