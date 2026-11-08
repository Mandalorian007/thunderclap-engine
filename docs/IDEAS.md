# Ideas

Parked ideas, not scheduled. The PM keeps this. An idea leaves this file when it becomes a brief and a row in `docs/STATUS.md`, or when the user drops it. Newest first.

## Publishing follow-ups (2026-11-07, PM, from ws/publish)

The npm path works (E-037). These are what the first cut left. ws/publish-2 takes the first three. Older TypeScript, Node and browser support is out of scope: the engine targets current toolchains only (user, 2026-11-07).

- **Guard against plain `npm publish`.** npm ignores pnpm's `publishConfig` exports. A plain `npm publish` in a package folder would ship a package pointing at `src/` files it doesn't contain. Add a `prepublishOnly` guard that fails outside a packed tarball, or point the root manifest at `dist/` and give the workspace another way to reach source.
- **Install from npm after publishing.** After `publish.yml` publishes, install the new version from the registry into a fresh project, then typecheck and import it. A broken tarball then fails the run, not a user.
- **GitHub Release per tag.** Have the publish job create a GitHub Release from that version's CHANGELOG section, so the repo's Releases page keeps itself current.
- **WebXR types versus `@types/webxr`.** The engine ships its own XR globals (`platform/xr-types.d.ts`). A consumer with `@types/webxr` and `skipLibCheck` off may hit duplicate declarations. Add that case to `check:pack`; if it clashes, rename the engine's XR types to module-scoped names or depend on `@types/webxr`.
- **host-capacitor peer.** The package imports no `@capacitor/*` module, so it has no peer dependency. Decide whether an optional `@capacitor/core` peer helps users anyway, as documentation in the manifest.

## XR rough edges (2026-11-07, user + PM)

The XR shape works: one `xr` option, an Enter VR button, scenes recorded through the head camera, controllers and hands as rays, world panels for menus, post per eye. Rough edges found while explaining it (performance is the next entry):

- **Never run on a real headset.** `e2e/xr.spec.ts` checks only that the button is disabled when XR is missing. The VR path is unit-tested against `platform/xr-fake.ts`, and the spec says "a real headset is a manual check". No such check is on record. Do a Quest smoke run of `harness/xr.html`, plus a short manual checklist (enter, exit from the headset menu, select with trigger and pinch, panel press, post on both eyes).
- **The head-locked panel trap.** `attach` positions a head-locked panel from `renderer.camera`, the page camera, so a game that forgets `hud.update(camera)` gets a misplaced HUD in VR with no error. Have `attach` follow the camera that is drawing (the head in VR). Anchors and floating labels have the same issue: in VR they default to the game camera, not the head (STATUS backlog).
- **No locomotion or interaction kit.** Games move the world by hand. Offer opt-in helpers: snap and smooth turn about the head, stick walking with a comfort vignette, teleport with an arc, and grab and throw on `squeeze`. Forgewilds has snap turn about the head (`apps/web/src/xr/pivot.ts`), stick walking and a vignette to learn from.
- **VR only.** There's no `immersive-ar` or passthrough. Park until a game needs it (VISION rule 6).
- **Stale doc note.** Older input backlog notes say XR pointers still reach a running replay; input-11 fixed that (pointer-source mute). Correct the note in the next doc sweep.
- **Fold into the recipes guides.** The VR grab and world-menu recipe already planned for `input-recipes.md` should also show the head-locked `update(camera)` call.

## VR performance without quality cuts (2026-11-07, user + PM)

The user's rule: the game must look and feel the same in VR. So no foveation, no lower frame-rate request, no resolution or viewport scaling, no quality ladder, no shorter draw distance and no turning bloom off. Each item below keeps the image the same, or fixes a bug. Sources: a read of Forgewilds' shelved VR client (`apps/web/src/xr/`, `docs/client/vr/`) and of ThunderClap's XR path. Citations are as of `fce9288`.

- **Cull in XR at all, once per frame.** The eye cameras never set `cull` (`platform/xr-surface.ts:106`; `Camera.cull` defaults to false), so XR draws everything. The draw list is also built and sorted for each eye (`render/renderer.ts:1258,1946`). Forgewilds culls once with a frustum that covers both eyes, then each eye trims that list (`render/view.ts:122-184`). That union holds at most 1.15x what one eye sees.
- **Bug: the head frustum misses the right eye's outer edge.** `head` uses eye 0's projection (`xr-surface.ts:252`), and scene-level culling such as voxel chunks (`voxel/chunks.ts:206`) runs against `head`. So chunks seen only at the right eye's edge can be dropped. Give `head` the union projection.
- **Share work across the eyes.** These run again for the second eye: shadow placement and the shadow pass, which is centred on each eye with no texel snapping (`renderer.ts:1253-1285`, `render/shadow.ts:132`); the full instance upload and the lane upload (`renderer.ts:1272-1283`); and LOD selection (`renderer.ts:1946`). Do each once from the head. One shadow map and one LOD choice also stop the eyes from disagreeing, which today can show as stereo shimmer.
- **Bug: auto exposure adapts twice a frame in XR.** `adaptExposure(..., dt)` runs once per eye with the full `dt` (`post/post-stack.ts:914`), so exposure adapts at about twice the intended speed, and the two eyes can differ. Adapt once per frame and share the result between the eyes.
- **Fused eye, only when nothing would change.** When the post settings are all per-pixel (exposure, tone map, grade, LUT, no bloom, mist, god rays, AO or DOF), fold them into the scene shaders and write straight into the layer. That skips the HDR target and the composite pass (Forgewilds `render/forward.ts`; it saved about 24 MB a frame of store and reload on a tiled GPU). Games using bloom or mist keep today's path. The check is a golden: the fused output must match the composite within rounding.
- **Layer depth for reprojection.** With `scene: true`, the projection layer gets no depth (`xr-surface.ts:159-169`), so the headset cannot correct a late frame for head movement. Copy the scene depth into a layer depth texture. That costs a little GPU time and makes late frames feel smoother, with no visual change. Forgewilds falls back across formats and has a stall watchdog (`apps/web/src/xr/speed.ts:342-366`, `xr/present.ts`).
- **Bug: a frame that throws stops the headset for good.** `GameLoop.frame` requests the next frame only after `try/finally` (`core/loop.ts:223-228`), and `renderer.inFrame` stays set. Keep the loop alive and clear the layer to the fog colour on any failed or viewless frame, as Forgewilds does (`apps/web/src/xr/stereo.ts:588-615`). Also, a frame with no views falls back to rendering the page target (`renderer.ts:1565`), which wastes GPU time. In XR, skip it.
- **The frame cap must not apply in XR.** The `minFrameMs` skip (`loop.ts:216`) would drop headset frames. Forgewilds never caps in XR.
- **Per-frame allocations.** `SceneTarget.adopt` makes a new `AdoptedTexture` and view each time the swapchain rotates (`render/scene-target.ts:355`), probably every frame. Cache them by texture. Hoist the `{ present: false }` literal (`core/game.ts:709`). Drop the unused emissive texture the size of the layer in scene mode (STATUS backlog).
- **Measure on a headset.** `GpuTimer` sums per-eye passes under shared labels and caps at 48 passes (`render/gpu-timer.ts:5,58`), which two eyes with bloom can exceed. Add per-eye labels and an XR budget report: GPU p95 at most 0.81 of the frame period, and under 2% missed or repeated frames (Forgewilds `xr/budget.ts`). Repeated frames matter: Forgewilds' first Quest runs reported 0 missed frames while 28% of refreshes repeated a frame. Then run on a Quest; no ThunderClap XR run on a real headset is on record.
- **Watch: WebGPU multiview.** When it ships, both eyes can be drawn in a single pass with nothing lost. Neither engine can use it today.
- Already done (checked, nothing to do): both eyes share one encoder and one submit (`renderer.ts:1213,1588`); opaque draws are sorted front to back (`renderer.ts:2672`); frames are counted, never keyed on the reused `XRFrame` (`loop.ts:248`).

## Layout rough edges (2026-11-07, user + PM)

The three layers work: the surface letterboxes design px, the layout puts HUD regions per form factor (safe area included), and the host is the only part that changes per platform. Rough edges found while explaining it:

- **Portrait phones get a small letterboxed strip.** A landscape game on an upright phone just shrinks. `createRotateCard` and `platform/device-mode.ts` are interim (E-010). Finish that work: a `createGame` option for orientation policy (`'landscape' | 'portrait' | 'any'`) that shows the rotate card, or locks orientation through `host.fullscreen.toggle({ lockLandscape })` where the host can, then retire device mode.
- **Design px versus CSS px.** The canvas is design px, while `freeRect`, the overlay and the safe area are CSS px. `fitFreeRect` hides that for the camera. Options: a `layout.freeRectLogical` (design px), or have the surface letterbox into the free rect automatically (`surface.setFrame(freeRect)` exists) behind a `createGame({ layout: { worldFits: 'free' } })` flag, so step 3 of the usage list goes away.
- **Refitting the camera is hand wiring.** Every game writes the same `onChange` + `onResize` + `fitFreeRect` trio. Offer `ctx.camera.followFreeRect(rect)`, or a scene option that refits on its own and unsubscribes on exit.
- **Electron verified only on macOS arm64.** Windows and Linux are built in CI but never run on hardware, and nothing is signed. Needed: a hardware smoke run on each, then signing once the user supplies certificates (already noted in `packages/host-electron/README.md`).
- **Layout recipes.** A `docs/guide/layout-recipes.md` with the default grids drawn per form factor (ASCII), plus three or four specs (a side-column phone HUD, a big orb bar, a portrait-first puzzle game, a desktop-only tool UI), all under `check:snippets`. It could share a page with the input recipes.
- **A dev overlay.** Draw the region boxes, `freeRect`, the safe-area insets and the `overflows()` list on top of the game behind a debug key, so layout problems can be seen on a real phone without DevTools.

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

## Wave 6 leftovers (E-038, 2026-11-07)

- **Surface:** `createGame({ overlay: false })` (`DetachedSurface`) ignores `fit` and has no `visibleRect` / `setFit` (ws/surface-fill).
- **XR:** a frame that throws mid-session leaves the XR layer stale; clearing it needs a try/catch in `core/game.ts` or new API (ws/xr-fixes).
- **XR:** DOM anchors and HUD floats still project through the page camera in VR; they are wired in `core/game.ts` / `ui` (ws/xr-fixes).
- **XR:** `PostStack` advances `grainSeed` once per eye. Cosmetic, the same double count as the exposure bug.
- **Render:** `GpuTimer` has no reset hook, so a timing sample started in a dropped frame stays busy.
