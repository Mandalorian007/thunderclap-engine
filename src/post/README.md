# engine/post

`PostStack` turns the renderer's HDR colour and emissive targets into the final swapchain
image. Every pass can be toggled, and every parameter can change at runtime.

```ts
import { PostStack } from '@thunderclap/engine/post';

const post = new PostStack(renderer, {
  godRays: { x: 960, y: -60 },   // light point in logical px (may be off-screen)
  fog: { density: 0.7 },
});
renderer.post = post;

post.set({ bloom: { intensity: 1.2 }, grade: { saturation: 1.2 } }); // merges per section
post.settings.fog.enabled = false;                                   // or mutate directly
```

Settings are packed into one uniform buffer each frame. Changing them never rebuilds
pipelines or bind groups.

## Easing between looks

`post.blendTo(patch, seconds, ease?)` moves settings over time instead of switching them
at once, so a mood change needs no covering wash.

```ts
import { easeOut } from '@thunderclap/engine/post';

post.blendTo({ grade: { exposure: 0.6, gain: [1.1, 0.9, 0.8] }, fog: { density: 0.9 } }, 3);
post.set({ godRays: { intensity: 0 } }).blendTo({ godRays: { enabled: true, intensity: 0.5 } }, 2, easeOut);
post.blending;      // true while anything is still moving
post.finishBlend(); // jump to the end values
```

- Numbers and RGB colours interpolate from their values at the time of the call. The default
  ease is smoothstep (`easeInOut`); `easeLinear`, `easeIn`, `easeOut` or any `(t) => t` also
  work.
- `enabled: true` applies at once, so set the pass's strength to 0 first to fade it in.
  `enabled: false`, `tonemap`, `dither` and `bloom.levels` switch when the blend ends, so a
  pass can fade out first.
- A later `set` or `blendTo` that touches the same key takes over from its current value.
  Other keys keep blending.
- Blends advance with the frame time passed to `beginFrame`, inside `encode`. Each step counts
  at most 0.1 s, so a hitch or a hidden tab slows a blend rather than skipping it. Without
  rendering, call `post.advanceBlend(time)` yourself.
- `PostBlender` is the same logic as a pure class (no GPU) for custom processors.
- Nothing allocates per frame.

## Passes, in order

| Pass | Where | Key settings |
|---|---|---|
| AO (ws/post-depth) | half res, over the scene depth | `ao.radius` (world units), `intensity`, `bias`, `power`. Normals from depth derivatives; 12 (`aoSamples`) spiral samples rotated per pixel by interleaved-gradient noise. Off by default. |
| AO blur | half res | 4×4 depth-aware blur of the AO term. |
| DoF (ws/post-depth) | half res, over the scene depth and colour | `dof.focusDistance`, `focusRange` (world units), `maxBlur` (px at output res), `nearBlur`. Circle of confusion from linear depth; 24 (`dofTaps`) golden-angle disc taps weighted by each tap's own CoC. Off by default. |
| Bloom prefilter | half res | `threshold`, `knee` (soft knee on scene colour), `emissiveWeight` (the emissive target always blooms). Karis average to stop fireflies. |
| Bloom down/up | half-res mip chain, `levels` deep | 13-tap downsample, 9-tap tent upsample blended by `scatter` |
| God rays | half res | `x, y` light point, `intensity`, `decay`, `density`, `weight`, `color`. Marches 64 samples radially over a light disc (`sourceRadius`, `sourceIntensity`) plus `bloomSource` × bloom, so bright things in the scene also cast shafts. |
| Composite | full res → swapchain | colour × AO, blended toward the DoF result by CoC, + emissive + `bloom.intensity` × bloom + rays, then fog, exposure, tonemap, grade, vignette, dither |

- **Fog** is a screen-space floor mist: a height band from `top` to `bottom` (0..1 of the
  screen, measured down) shaped by `falloff`. Animated fbm sets `noiseScale` and `speed`.
  `lightScatter` tints the mist with nearby bloom so glowing objects light it up.
- **Tonemap** is `'aces'` (the default), `'reinhard'`, or `'none'`, applied after `exposure`.
- **Grade** applies `lift`, `gamma`, and `gain` (RGB each), then `saturation` and `contrast`.
  It runs in display space after tonemapping.
- **Vignette** takes `intensity`, `radius`, `softness`, and `color`.
- **Dither** adds ±½ LSB of noise to hide banding in dark gradients.
- **AO** (`AoSettings`) and **DoF** (`DofSettings`) need the scene depth: the renderer fills
  `PostInputs.depth` (the target's `depth24plus` attachment) and `PostInputs.projection`
  (`near`, `far`, the camera's `proj`) on frames a depth camera rendered, else both are `null`
  and the stack skips both passes with the composite unchanged, so 2D pages stay pixel-identical.
  The passes allocate their half-res textures the first time they run and free them on resize.
  AO multiplies the scene colour only (not the emissive target). Both blend through `blendTo`
  (`enabled` and `nearBlur` switch when the blend ends).

When bloom is disabled the bloom chain is skipped. It still runs if god rays need it
(`bloomSource > 0`).

## Notes

- `defaultPostSettings()` is tuned for a dark, jewel-toned scene: a strong emissive glow, a
  cool mist on the floor, and pale storm rays from above.
- Output is encoded to sRGB in the shader because the swapchain is `bgra8unorm`.
- All intermediate textures are reallocated only on resize (or a bloom level cap change).
- **Quality caps** (`PostQuality`, `post.quality`, `defaultPostQuality()`) are separate from
  the look: `post.setQuality({ maxBloomLevels, raySamples, fogOctaves, compositeAtScene, aoSamples, dofTaps })`
  (defaults 8, 64, 5, false, 12, 24; `compositeAtScene` composites at the scene's resolution and
  upscales when the scene is smaller than the output). Fewer ray samples rescale decay and weight
  per step so the shafts keep their reach; fewer fog octaves add back the dropped octaves'
  mean so the mist keeps its density. Bloom, rays, AO and DoF run at half the scene resolution;
  the composite runs at output resolution and samples the scene by UV. `aoSamples` is clamped
  to 4..16 and `dofTaps` to 8..32.
- Write your own processor by implementing `PostProcessor { resize(w, h); encode(encoder,
  inputs, outputView, viewport?) }` and assigning it to `renderer.post`. `viewport` (texture px)
  asks for the result in that part of the output only, loading the rest; the inputs may differ
  in size from the last `resize`, so size yourself to them (see XR).

## XR (ws/xr-post)

The stack runs per eye, so a headset sees the same bloom, tone map and grade as the screen.
`createGame`'s XR render step renders each eye into the surface's eye-sized HDR `scene` target
and calls `renderer.resolve(scene, eye.target.color.view, eye.viewport)`, which runs
`renderer.post` (this stack) from that target into the eye's part of the session's layer
texture; `renderer.endFrame({ present: false })` then only submits. Inside `encode`:

- Inputs of another size than the last `resize` (the eye, not the canvas) resize the stack
  first, once; leaving VR resizes it back on the first page frame. Steady state allocates nothing.
- With a `viewport` the composite (or the `compositeAtScene` upscale) sets viewport and scissor
  to it and loads the rest of the output instead of clearing, so the second eye keeps the first;
  `compositeAtScene` compares the scene size with the viewport, not the canvas.
- Both eyes share the bloom chain and ray textures (the passes run one eye after the other on
  one encoder), so VR costs no extra HDR allocation. Settings and blends apply to both eyes;
  `godRays.x/y` stay in logical px of the design space.
- Output is encoded to sRGB as on screen, so the layer is made in the swap-chain format
  (`XrSurfaceOptions.colorFormat = renderer.format`).

## Types

- `PostSettings` has one section per pass: `bloom: BloomSettings`, `fog: FogSettings`,
  `godRays: GodRaySettings`, `vignette: VignetteSettings`, `grade: GradeSettings` (which holds
  `tonemap: Tonemap`), `ao: AoSettings`, `dof: DofSettings`. `RGB` is `[r, g, b]`.
- `PostSettingsPatch` is a per-section partial of `PostSettings`, the argument of `new
  PostStack(renderer, patch?)`, `set` and `blendTo`. `applyPostPatch(target, patch)` merges one
  into a settings object in place (shallow per section); `defaultPostSettings()` returns a
  fresh default.
- `Ease` is `(t: number) => number` on 0..1.
