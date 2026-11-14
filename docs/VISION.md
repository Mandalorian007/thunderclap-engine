# ThunderClap: vision

*2026-11-05, pillar status refreshed 2026-11-06; the 2.0 mission and rules 4–6 rewritten 2026-11-14 (E-041). The target every engine proposal is judged against. `ARCHITECTURE.md` says what exists today and what is planned; this file says why.*

## The goal

Ship a game every two weeks to a month, spending nearly all of that time on game logic, content and art, and almost none on foundations.

ThunderClap is the foundation: a layer games can trust to scale out on, for many games and many styles, from a 2D puzzler to a streamed 3D world to a headset. It owns everything that is not the game: surface, camera, renderer, post-processing, FX, input, layout, UI, audio, saves, host integration (links, embeds, fullscreen, storage), analytics hooks, and the foundations every game of a kind would otherwise rebuild: streamed worlds and their meshing, procedural models, animated characters at scale, UI described once for screens and headsets, quality control under load, and both sides of a networked game's seam (the client's replication and prediction, and a server foundation that runs a game's rules). A game supplies scenes, rules, content and art, and gets everything else.

Speed is tuned over time; the shape of the foundation is not. A module is designed so the fast path is reachable (retained, GPU-driven, views done once), even before it is tuned.

A new game's repo holds `rules/`, `content/`, `scenes/`, `shaders/` and a `createGame()` call. If it holds anything else, the engine has a gap.

## What done looks like

Two shipped styles bound the range, and both must run on one engine with one code path:

- **The Last Rune**: a painted 2D puzzler. Procedural WGSL materials, HDR bloom, candle point lights, a DOM overlay in layout regions, touch with a loupe, saves with migrations. Phones, tablets, desktop, itch iframe, Electron.
- **Forgewilds**: a first-person 3D voxel world at scale, networked. Streamed world sections meshed in Workers, procedural part-model creatures posed on the GPU, perspective and stereo cameras, baked and dynamic light, fog, water, weather and emissive FX, one HUD for screen and headset, pointer lock, Bedrock-style touch, pad and headset controllers, a server-authoritative world. Since E-041 it is the engine's first large game: the 2.0 program moves its foundations into the engine until it runs on ThunderClap at feature parity.

These are *candidate styles*, not the feature list. The engine is style-agnostic: a low-poly scene, a toon-shaded one, an isometric tactics map or a painted side-scroller should be expressible with the same camera, instance format, material contract and lighting block, through WGSL the game writes.

## The six pillars, in the order they matter to a game author

1. **Runs everywhere, laid out properly.** Phone, tablet, desktop, Electron, iframe embed and headset from one bundle. Safe areas, form factors, DPR, page lifecycle, device loss, browser-zoom blocking. *Done, including headsets.*
2. **One input vocabulary.** Touch, keyboard, mouse, pen, gamepad, VR controllers and hands all land as the same actions and the same ray hits. A game reads `select` and `hit.cell`; it never sees a touch, a button or an `XRInputSource`. *Done: rays, XR controllers and hands, and deterministic record and replay (also mid-session). Ahead: muting XR pointers during a replay.*
3. **2D and 3D on one renderer.** A matrix camera with presets (ortho 2D is the default), depth when a camera asks, instanced sprites and meshes sharing one instance format, a vertex layout per mesh, sorted draw lists. *Done: perspective and depth, culling, LOD, picking, voxel chunks, two views. The 2D path is pixel-identical.*
4. **Lots of style, shader-first.** Custom WGSL materials, HDR colour and emissive targets, a rich post stack, a lighting block with shadows, GPU particles and weather-class FX. Style comes from shaders and light, not from asset pipelines; glTF is secondary. *Done: PBR, sun and spot shadows, sky, water, weather, GPU particles, trails, decals, and a post stack with TAA on camera jitter, SSR, AO and object motion blur. Ahead: polish.*
5. **UI that follows the game.** DOM panels, toasts and captions in CSS-px regions on screens; world-anchored labels; in-world and head-locked panels where there is no screen. *Done: HUD widgets (orbs, floats, minimap), rails per form factor, anchors, world and VR panels, inventory. Ahead: easier widget handling.*
6. **Framework plumbing.** Host seam, saves, analytics events, game templates, and a `createGame` where the fixed-step sim and the save store are opt-in, so a pure client fits. *Done: analytics, i18n, four templates, client mode. Ahead: usage guides, the API surface frozen for `engine-v1.0.0`, and a real game on it.*

## The rules that do not move

1. **No game nouns.** Code joins the engine only if a shipped game uses it, the next game plausibly would, and its API names nothing from either.
2. **One direction.** Games import the engine; the engine never imports a game.
3. **No runtime dependencies.** WebGPU is the only renderer; WebXR the only XR binding. No fallbacks.
4. **The engine opens no connection of its own.** Storage is browser-only through `Host.storage`; analytics sinks are the game's. The networking client runs over a transport the host or game hands it; the server foundation is a separate package a game's server runs.
5. **Foundations, not rules.** Anything every game of a kind would otherwise rebuild belongs in the engine: world storage, streaming, meshing and light; models and characters; the UI framework; input intents; quality control; replication, prediction and the server's loop, log and persistence. A game's rules, content, AI, world generation and art direction stay the game's. Rule 1 guards the line: a module joins only when its API names nothing from any game, and its data (block tables, vertex schemas, part trees, panel specs, message schemas) is declared by the game.
6. **Nothing on spec.** Each capability arrives with the game that needs it. Forgewilds' needs count as real, and so does a second game's style: a foundation moved in from one game is shaped so a 2D, a different 3D, or a VR game could use it through the same API.

## What is the game's job

Rules (client-side and server-side), content, AI, world generation, art direction, its message schemas, and the game's own product tests. The engine makes these possible and pleasant, not automatic. The engine verifies platform capability once, for every game; a game tests only its own product.

## How to judge a proposal

Ask, in order:

1. Does it shorten the next game's build, or only the engine's wishlist?
2. Could both candidate styles use it through the same API?
3. Does it name a game noun, add a dependency, or make a network call?
4. Which shipped or in-progress game needs it this month?

A yes to 1 and 2, a no to 3, and a named game for 4 is the bar.
