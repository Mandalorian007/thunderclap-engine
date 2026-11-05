# ThunderClap: vision

*2026-11-05. The target every engine proposal is judged against. `ARCHITECTURE.md` says what exists today and what is planned; this file says why.*

## The goal

Ship a game every two weeks to a month, spending nearly all of that time on game logic, content and art, and almost none on foundations.

ThunderClap is the foundation. It is a WebGPU rendering-and-display framework for games in the browser and its wrappers. It owns everything that is not the game: surface, camera, renderer, post-processing, FX, input, layout, UI overlay, audio, saves, host integration (links, embeds, fullscreen, storage) and analytics hooks. A game, or a thin client for a server-authoritative game, supplies scenes, rules, content and art, and gets everything else.

A new game's repo holds `rules/`, `content/`, `scenes/`, `shaders/` and a `createGame()` call. If it holds anything else, the engine has a gap.

## What done looks like

Two shipped styles bound the range, and both must run on one engine with one code path:

- **The Last Rune**: a painted 2D puzzler. Procedural WGSL materials, HDR bloom, candle point lights, a DOM overlay in layout regions, touch with a loupe, saves with migrations. Phones, tablets, desktop, itch iframe, Electron.
- **Forgewilds**: a first-person 3D voxel world. Chunk meshes from Workers, perspective and stereo cameras, baked and dynamic light, fog, water, weather and emissive FX, a DOM HUD plus in-world panels, pointer lock, Bedrock-style touch, pad and headset controllers, no client saves (server-authoritative).

These are *candidate styles*, not the feature list. The engine is style-agnostic: a low-poly scene, a toon-shaded one, an isometric tactics map or a painted side-scroller should be expressible with the same camera, instance format, material contract and lighting block, through WGSL the game writes.

## The six pillars, in the order they matter to a game author

1. **Runs everywhere, laid out properly.** Phone, tablet, desktop, Electron, iframe embed and headset from one bundle. Safe areas, form factors, DPR, page lifecycle, device loss, browser-zoom blocking. *Largely done.*
2. **One input vocabulary.** Touch, keyboard, mouse, pen, gamepad, VR controllers and hands all land as the same actions and the same ray hits. A game reads `select` and `hit.cell`; it never sees a touch, a button or an `XRInputSource`. *Action map and gestures done; rays and XR bindings ahead.*
3. **2D and 3D on one renderer.** A matrix camera with presets (ortho 2D is the default), depth when a camera asks, instanced sprites and meshes sharing one instance format, a vertex layout per mesh, sorted draw lists. *Phase 3 begins it.*
4. **Lots of style, shader-first.** Custom WGSL materials, HDR colour and emissive targets, a rich post stack, a lighting block with shadows, GPU particles and weather-class FX. Style comes from shaders and light, not from asset pipelines; glTF is secondary. *Material and post foundation done; lighting and FX ahead.*
5. **UI that follows the game.** DOM panels, toasts and captions in CSS-px regions on screens; world-anchored labels; in-world and head-locked panels where there is no screen. *Overlay and layout done; placements ahead.*
6. **Framework plumbing.** Host seam, saves, analytics events, game templates, and a `createGame` where the fixed-step sim and the save store are opt-in, so a pure client fits. *Host and saves done; analytics, templates and opt-in ahead.*

## The rules that do not move

1. **No game nouns.** Code joins the engine only if a shipped game uses it, the next game plausibly would, and its API names nothing from either.
2. **One direction.** Games import the engine; the engine never imports a game.
3. **No runtime dependencies.** WebGPU is the only renderer; WebXR the only XR binding. No fallbacks.
4. **No network calls from the engine.** Storage is browser-only through `Host.storage`; analytics is a sibling package.
5. **Rendering, not mechanics.** The engine ships the renderer. A voxel mesher, a pathfinder, a rules evaluator or a netcode layer is a game's content pipeline that feeds engine buffers, even when two games share it.
6. **Nothing on spec.** Each capability arrives with the game that needs it. Forgewilds' needs count as real.

## What is the game's job

Rules, content, AI, servers, netcode, world generation, art direction, and the game's own product tests. The engine makes these possible and pleasant, not automatic. The engine verifies platform capability once, for every game; a game tests only its own product.

## How to judge a proposal

Ask, in order:

1. Does it shorten the next game's build, or only the engine's wishlist?
2. Could both candidate styles use it through the same API?
3. Does it name a game noun, add a dependency, or make a network call?
4. Which shipped or in-progress game needs it this month?

A yes to 1 and 2, a no to 3, and a named game for 4 is the bar.
