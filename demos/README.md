# Demos

Small complete games on `@thunderclap/engine`, one per folder, that prove a path through the engine at game scale (E-021). Each is a Vite page with no build config and no dependency beyond the workspace engine; everything it draws and plays is procedural. Run one with `pnpm exec vite demos/<name> --host 127.0.0.1` (or `pnpm demo <name>` once the script lands); each has a spec in `e2e/demos/<name>.spec.ts` that runs inside `pnpm test:e2e`.

| Demo | Path | Shows | Spec checks |
|---|---|---|---|
| dungeon | `demos/dungeon` | 2D top-down crawl: 40×30 tile map from a canvas atlas, 60 flipbook bats, wall collision, flickering emissive torches with bloom, fog-of-war layer, pad-navigated pause menu, coins in `save`, synthesised sounds; one draw call | boots clean, 60 bats, one draw call, fps > 20 on desktop, player stops flush on a wall tile, coin pickup survives a reload, pause menu walks with arrows and d-pad |
