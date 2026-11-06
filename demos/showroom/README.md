# Showroom

A material and lighting showroom: a 7×7 grid of spheres sweeping metalness (left to right) × roughness (top to bottom) under a shadowing sun, three orbiting point lights (warm, cool, magenta), an emissive pulsing strip, and a floor with a canvas-drawn checker albedo and roughness map. Drag to orbit, wheel or pinch to zoom, keys `1`–`5` blend between post looks through `post.blendTo`. A readout (`ui`) shows draw calls, GPU ms and fps. `?still` parks the lights and the strip and finishes look blends at once.

Run: `pnpm demo showroom` (or `pnpm exec vite demos/showroom --host 127.0.0.1`).

## Looks

| Key | Look | Expected visual |
| --- | --- | --- |
| 1 | `neutral` | ACES, mild bloom on the strip and the sun highlights, light vignette. |
| 2 | `warm` | Strong bloom (the strip glows wide), warm fog, warm colour gain and higher saturation. |
| 3 | `rays` | God rays streak from the sun's screen point behind the grid, otherwise neutral. |
| 4 | `contrast` | Punchy: raised contrast and exposure, lower saturation, heavy vignette. |
| 5 | `off` | Post disabled, no tonemap: flat, slightly clipped highlights. |

## Engine modules

`platform` (`boot`), `render` (`Renderer`, `Camera`, `Lights` with sun shadow, point lights and fog, `createStandardMaterial`, `textureFromSource`, instance `order`/`emissive`/`uv`, `stats`, `timing`), `post` (`PostStack`, `blendTo`, god rays), `input` (`Input`, `Gestures`, wheel and key bindings), `ui` (`createOverlay`, `h`), `core` (`GameLoop`).

## What the spec checks

`e2e/demos/showroom.spec.ts` loads the page with `?still` through the harness vite server's `/@fs/` route on every matrix row and asserts: `drawCalls` is 3 (floor, spheres, strip) with 51 instances and shadow draws; `gpuMs` arrives; the three `lightPositions` do not move; the middle sphere's centre pixel is lit (not black, not blown out); keys `2`,`3`,`4`,`5`,`1` change `look`, the frame keeps rendering and the sphere stays lit under each look; no console errors; `fps` above 20 on the desktop rows.
