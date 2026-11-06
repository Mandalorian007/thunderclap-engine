# Showroom

A material and lighting showroom: a 7×7 grid of spheres sweeping metalness (left to right) × roughness (top to bottom) under a shadowing sun, three orbiting point lights (warm, cool, magenta), an emissive pulsing strip, and a floor with a canvas-drawn checker albedo and roughness map. Drag to orbit, wheel or pinch to zoom (a `Look`'s `zoom` axis), keys `1`–`5` blend between post looks through `post.blendTo`. A readout (`ui`) shows draw calls, GPU ms and fps. `?still` parks the lights and the strip and finishes look blends at once.

Run: `pnpm demo showroom` (or `pnpm exec vite demos/showroom --host 127.0.0.1`). To start a 3D game of your own from this shape, `pnpm create-game` scaffolds a project on the same public API.

## What to look at

- The grid is one instanced draw: a 7×7 metallic-roughness texture (G roughness, B metallic) sampled per sphere through a collapsed instance `uv` rect, so 49 spheres cost one draw call.
- The floor's roughness map: rough light tiles blur the sun's reflection, glossy dark tiles sharpen it; both maps are painted on a canvas and uploaded with `textureFromSource`.
- The sun's shadow map across the grid and three coloured point lights circling it; the strip's `emissive` feeds bloom in every look but `off`.
- The five looks (keys 1–5) blending over 1.2 s through `post.blendTo`: a neutral base on `defaultPostSettings()` and each other look as the patch that differs from it, applied with `applyPostPatch`, so a look spells only what it changes.
- GPU ms appears in the readout once `renderer.timing.ready()` resolves (the first sample landed); nothing polls `timing.samples`.
- Every mesh is a `geom` builder (`sphere`, `plane` with `uvScale`, `box`); the demo writes no vertex arrays of its own.

## Known limits

The orbit keeps a one-pointer pan for the drag, since a `Look` turns a mouse only under the pointer lock.

## Looks

| Key | Look | Expected visual |
| --- | --- | --- |
| 1 | `neutral` | ACES, mild bloom on the strip and the sun highlights, light vignette. |
| 2 | `warm` | Strong bloom (the strip glows wide), warm fog, warm colour gain and higher saturation. |
| 3 | `rays` | God rays streak from the sun's screen point behind the grid, otherwise neutral. |
| 4 | `contrast` | Punchy: raised contrast and exposure, lower saturation, heavy vignette. |
| 5 | `off` | Post disabled, no tonemap: flat, slightly clipped highlights. |

## Engine modules

`platform` (`boot`), `geom` (`sphere`, `plane`, `box`), `render` (`Renderer`, `Camera`, `Lights` with sun shadow, point lights and fog, `createStandardMaterial`, `textureFromSource`, instance `order`/`emissive`/`uv`, `stats`, `timing.ready()`), `post` (`PostStack`, `blendTo`, `applyPostPatch`, `defaultPostSettings`, god rays), `input` (`Input`, `Gestures` pan, `Look` zoom axis, key bindings), `ui` (`createOverlay`, `h`), `core` (`GameLoop`).

## What the spec checks

`e2e/demos/showroom.spec.ts` loads the page with `?still` through the harness vite server's `/demos/showroom/` route on every matrix row and asserts: `drawCalls` is 3 (floor, spheres, strip) with 51 instances and shadow draws; `gpuMs` arrives; the three `lightPositions` do not move; the middle sphere's centre pixel is lit (not black, not blown out), sampled from a screenshot taken after a `requestAnimationFrame` settle; keys `2`,`3`,`4`,`5`,`1` change `look`, the frame keeps rendering and the sphere stays lit under each look; no console errors; `fps` above 20 on the desktop rows.
