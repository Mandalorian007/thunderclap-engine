# Highland: the first-person template

A first-person walk over a 64×64 block terrain: a sun with shadows, fog, falling snow and three
landmarks to find and inspect. The terrain is generated from a seed and meshed in a Worker, one
chunk at a time, straight into GPU buffers. Mouse and keyboard, touch (a walk stick and a look
drag) and gamepad all work. Start here for an exploration game, a voxel world or a shooter.

## Run

```sh
pnpm install
pnpm dev        # Vite at http://127.0.0.1:5173 (a WebGPU browser: Chrome, Edge or Safari 26+)
pnpm test       # Vitest: the terrain, the mesher and the chunk upload
pnpm check      # tsc, Biome, Vitest
pnpm build      # the static game in dist/ (pnpm preview serves it)
```

In the engine repo: `pnpm template:first-person` from the root.

Click the canvas to take the pointer lock; WASD walks, Shift runs, E inspects, R respawns.

## Edit these first

- `src/world/terrain.ts`: the world. `SEED`, the height field, which block goes where, and `findLandmarks`.
- `src/world/mesher.ts`: chunk geometry. Keep `meshChunk(terrain, cx, cz, buffer)` and the scene does not change; `src/world/upload.test.ts` uploads a chunk to the engine's fake GPU and checks it draws.
- `src/art/blocks.ts`: the block textures, generated as pixels.
- `src/scenes/world.ts`: walking, lights, snow, landmark labels and the crosshair pick.
- `CLAUDE.md`: the whole template and every engine noun it uses, for you or an agent.

## Engine guides

- [Getting started](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/getting-started.md)
- [Make a 3D game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/3d-game.md)
- [Input](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/input.md)
- [Style your game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/style-and-post.md)
- [Testing your game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/testing-your-game.md)
