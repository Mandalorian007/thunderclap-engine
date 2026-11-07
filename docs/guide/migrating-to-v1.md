# Migrating to v1

## What you'll do

You move a game from `0.x` names to the names `engine-v1.0.0` keeps. In `0.2.0-alpha.1` every
old name below was a deprecated alias with the same shape; `1.0.0` removed them all
([E-036](../DECISIONS.md), [Removal](#removal)), so this guide is the map from 0.x. On 0.x,
rename them first and the upgrade is a version bump; on 1.0.0, each old name is a type error
whose fix is its row in the table.

Most renames exist because two modules exported the same name with different shapes. The game
that imports `Hit` from `input` and `Hit` from `geom` now writes `PickHit` and `RayHit`.

## Find what you use

Run this on your 0.x engine, before you bump. TypeScript knows every deprecated name: it reports each use as a suggestion,
TS6385 for a name and TS6387 for a call signature. Your editor shows them as struck-through
text. To list them from the command line, the engine's snippet checker exports the same pass:

```ts no-check
// find-deprecated.mjs, run from your game's folder with `node find-deprecated.mjs`
import { findDeprecatedUses } from './node_modules/@thunderclap/engine/scripts/check-snippets.mjs';

for (const u of findDeprecatedUses('tsconfig.json')) {
  console.log(`${u.file}:${u.line}:${u.col}  TS${u.code}: ${u.text}`);
}
```

The block opts out of the snippet check: it is a Node script, not engine code. The path is a
file path because `scripts/` is not a package entry point. It uses the engine's own
`typescript` (7, the native compiler), and lists every deprecated name your project's root
files use, the engine's and the DOM's alike.

`pnpm check` in this repo runs the same pass over every checked snippet in the README and the
guides, so the docs never show a deprecated name. After the bump the old names no longer exist,
so `tsc` reports them as errors and the table below says what each becomes.

## Renamed and retired names

The *Module* column is the entry point (`@thunderclap/engine/<module>`). Every name in the
*0.x name* column is gone from `engine-v1.0.0`. A test in `scripts/check-snippets.test.mjs`
fails when a row names something `api/*.api.txt` still exports, or when a later `@deprecated`
export is missing from this table.

| Module | 0.x name | v1 replacement |
| --- | --- | --- |
| `anim` | `BlendMode` | `AnimBlendMode` (render has its own blend mode) |
| `anim` | `PlayOptions` | `AnimPlayOptions` |
| `assets` | `GltfMaterial.baseColorTexture` | `material.baseColor?.index ?? null` |
| `assets` | `GltfMaterial.texCoord` | `material.baseColor?.texCoord ?? 0` |
| `assets` | `SKINNED_JOINTS_OFFSET` | `SKIN_JOINTS_BYTE_OFFSET` from `render` |
| `assets` | `SKINNED_VERTEX_STRIDE` | `VERTEX_SKINNED_STRIDE` from `render` |
| `assets` | `SKINNED_WEIGHTS_OFFSET` | `SKIN_WEIGHTS_BYTE_OFFSET` from `render` |
| `audio` | `FollowTarget` | `AudioFollowTarget` |
| `audio` | `PlayOptions` | `AudioPlayOptions` (so `AudioPlayOptions.at` for a spatial voice) |
| `core` | `SceneStack.list()` | the `scenes` getter (`list()` returns a copy) |
| `geom` | `Aabb` | `GeomAabb` |
| `geom` | `Hit` | `RayHit` |
| `input` | `Aabb` | `RayBox` |
| `input` | `FollowTarget` | `FollowSubject` |
| `input` | `Grid` | `SnapGrid` (ui exports a `Grid` widget) |
| `input` | `Hit` | `PickHit` |
| `input` | `Input.contextStack()` | the `contexts` getter (`contextStack()` returns a copy) |
| `input` | `Input.getBindings()` | `bindings()`, the same map |
| `input` | `Input.getGestures()` | the `gestures` getter |
| `input` | `Input.getLook()` | the `look` getter |
| `input` | `Input.getPointers()` | the `pointers` getter |
| `input` | `Input.listeningFor()` | the `listening` getter |
| `input` | `Rect` | `Edges` (`l`, `t`, `r`, `b`) |
| `nav` | `Cell` | `NavCell` |
| `platform` | `Rect` | `LetterboxRect` |
| `platform` | `prefersReducedMotion()` | `isReducedMotion(win?)` |
| `post` | `FogSettings` | `MistSettings` (the same shape) |
| `post` | `PostSettings.fog` | `PostSettings.mist` (`fog` reads and writes `mist`) |
| `post` | `PostStack.addJitterCamera(camera)` | nothing: the stack jitters every camera through `renderer.setJitter` while TAA runs |
| `post` | `PostStack.removeJitterCamera(camera)` | nothing, as above |
| `post` | `defaultPostSettings()` | `cinematicPostSettings()` (the same values), or `neutralPostSettings()` for no look |
| `render` | `BlendMode` | `RenderBlendMode` |
| `render` | `Fog` | `DistanceFog` (`lights.fog`) |
| `render` | `LoadTextureArrayOptions.mipFilter` | `filter` |
| `render` | `Renderer.createSpriteMaterial(texture, label?, opts?)` | `renderer.createSpriteMaterial({ texture, label?, blend?, sampler? })` |
| `render` | `Renderer.white` | `defaultTextures(renderer.device).white` |
| `render` | `SunLight.dir` | `direction` (the same array) |
| `render` | `BUFFER_BINDING_BASE` | internal, no replacement |
| `render` | `CAMERA_INV_VIEW_PROJ_OFFSET` | internal camera-block layout, no replacement |
| `render` | `CAMERA_JITTER_OFFSET` | internal, as above |
| `render` | `CAMERA_PREV_VIEW_OFFSET` | internal, as above |
| `render` | `CAMERA_PREV_VIEW_PROJ_OFFSET` | internal, as above |
| `render` | `FOG_OFFSET_FLOATS` | internal lights-block layout, no replacement |
| `render` | `LAYERS_OFFSET_FLOATS` | internal, as above |
| `render` | `LIGHTS_BLOCK_FLOATS` | internal, as above |
| `render` | `POINT_LAYERS_OFFSET_FLOATS` | internal, as above |
| `render` | `POINT_LIGHTS_OFFSET_FLOATS` | internal, as above |
| `render` | `SHADOW_PARAMS_OFFSET_FLOATS` | internal, as above |
| `render` | `SKIN_PALETTE_HEADER_FLOATS` | internal, no replacement |
| `render` | `SPOT_LIGHTS_OFFSET_FLOATS` | internal lights-block layout, no replacement |
| `render` | `SPRITE_WGSL` | `renderer.createSpriteMaterial` |
| `render` | `STANDARD_WGSL` | `createStandardMaterial` |
| `render` | `SUN_VIEW_PROJ_OFFSET_FLOATS` | internal lights-block layout, no replacement |
| `save` | `TYPED_CTORS` | internal, no replacement |
| `ui` | `Cell` | `GridCell` (`{ col, row }`; nav exports an x/y cell) |
| `ui` | `Cooldown` | `WidgetCooldown` (core exports the scheduler's `Cooldown`) |
| `ui` | `CooldownOptions` | `WidgetCooldownOptions` |
| `ui` | `prefersReducedMotion(win?)` | `prefersReducedMotionIn(win?)` |
| `ui` | `TooltipHost.frame` | nothing: the frame is read from `anchors().frame.rect` once a camera built the anchors |
| `ui` | `WorldPanelInput.getPointers()` | `pointers` |
| `ui` | `BASE_CSS` | internal: `ensureStyles` injects it |
| `ui` | `CANVAS_MINIMAP_CSS` | internal: `ensureCanvasMinimapStyles` |
| `ui` | `CURSOR_CSS` | internal: `ensureCursorStyles` |
| `ui` | `FLOATS_CSS` | internal: its `ensure*Styles` injects it |
| `ui` | `HUD_CSS` | internal: its `ensure*Styles` injects it |
| `ui` | `INVENTORY_CSS` | internal: its `ensure*Styles` injects it |
| `ui` | `LOADING_CSS` | internal: `ensureLoadingStyles` |
| `ui` | `NOTIFY_CSS` | internal: `ensureNotifyStyles` |
| `ui` | `ORB_CSS` | internal: `ensureOrbStyles` |
| `ui` | `TOOLTIP_CSS` | internal: `ensureTooltipStyles` |
| `ui` | `WIDGETS2_CSS` | internal: its `ensure*Styles` injects it |
| `ui` | `WIDGETS3_CSS` | internal: `ensureWidgets3Styles` |
| `ui` | `WORLD_PANEL_WGSL` | internal: `createWorldPanel` builds its pipeline from it |

`PostStack.addJitterCamera` and `removeJitterCamera` were no-ops since ws/post-6; like every
other row, they are removed in `1.0.0`.

## Reads that became getters

These changed without an alias, so the compiler flags them as errors, not suggestions:

- `cache.stats` (`AssetCache`), not `cache.stats()`.
- `host.fullscreen.active` (`HostFullscreen`), not `active()`. A custom `Host` writes `active` as
  a getter or a plain boolean.

## A worked rename

Before (0.x):

```ts no-check
import type { PlayOptions } from '@thunderclap/engine/audio';
import { defaultPostSettings } from '@thunderclap/engine/post';

const opts: PlayOptions = { at: [0, 1, 0] };
const look = defaultPostSettings();
ctx.post.settings.fog.density = 0.4;
const sprite = renderer.createSpriteMaterial(tex, 'hero');
```

After (checked against today's engine):

```ts
import type { AudioPlayOptions } from '@thunderclap/engine/audio';
import { cinematicPostSettings } from '@thunderclap/engine/post';
import type { Renderer, Texture } from '@thunderclap/engine/render';

declare const renderer: Renderer;
declare const tex: Texture;

const opts: AudioPlayOptions = { at: [0, 1, 0] };
const look = cinematicPostSettings();
look.mist.density = 0.4;
const sprite = renderer.createSpriteMaterial({ texture: tex, label: 'hero' });
```

## Removal

`engine-v1.0.0` deleted every alias in the table above (CHANGELOG *Removed*). Before you bump,
run the script from [Find what you use](#find-what-you-use) in your game's folder on your 0.x
engine; when it prints no engine name, the bump compiles:

```sh
node find-deprecated.mjs
```

From 1.0.0 the public surface is frozen: `api/*.api.txt` records it, and a change to it ships
only with a *Breaking* or *Added* CHANGELOG line naming the module.

## Next

- [CHANGELOG.md](../../CHANGELOG.md): the 1.0.0 *Removed* list, and the *Deprecated* entries of 0.x with the branch that made each change
- [Getting started](getting-started.md)
- [Testing your game](testing-your-game.md)
