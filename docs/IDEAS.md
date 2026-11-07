# Ideas

Parked ideas, not scheduled. The PM keeps this. An idea leaves this file when it becomes a brief and a row in `docs/STATUS.md`, or when the user drops it. Newest first.

## Input convenience layer (2026-11-07, user + PM)

The action map design is sound: named actions in a typed union, one bindings map, contexts, every pointer as a ray, tick-counted timing, recordable. It matches the model Unity's Input System, Godot's InputMap and Unreal's Enhanced Input settled on. It is not yet *trivial* (`docs/VISION.md`), because the surface is large and common setups take hand wiring. Proposed as additive, minor-version work under the 1.0 freeze:

- **Binding presets.** No defaults today, so every game writes WASD + left stick + A from scratch. Ship presets (platformer, top-down, first-person, point-and-click) a game spreads and overrides.
- **`createGame` builds the optional parts.** Options that create `Look` and `PadCursor` instead of the game wiring them by hand.
- **World panels poll themselves.** Today the game calls `panel.poll(ctx.pointers.pointers)` every tick; forgetting it leaves a dead panel.
- **One recommended path per job.** Say plainly when to use `{ pointer: 'select' }` over `{ mouse: 0 }` / `{ gesture: 'tap' }`, and how touch zones' own bindings map and `Look` relate to actions. Consider folding touch-zone bindings into the main map.
- **Typed menu actions.** A typed game must declare context-only actions in the base union; look for a lighter form.
- **Input recipes guide.** `docs/guide/input-recipes.md`: per-genre examples (platformer, tactics, first-person, VR grab and world menu, pause menu with prompts and rebinding, bug-report replay), all under `check:snippets`. Draft examples from the 2026-11-07 PM session need fixes: the world panel `poll` call, and `confirm`/`back` declared in the action union.
- **Verify gaps.** Local multiplayer (several pads, each mapped to its own player) was not seen in the docs; replays do not capture XR controllers or pointer-lock raw motion. Confirm and decide.
- **A "start here" cut of `src/input/README.md`** (510 lines): what a newcomer can ignore.
