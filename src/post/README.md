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
| Bloom prefilter | half res | `threshold`, `knee` (soft knee on scene colour), `emissiveWeight` (the emissive target always blooms). Karis average to stop fireflies. |
| Bloom down/up | half-res mip chain, `levels` deep | 13-tap downsample, 9-tap tent upsample blended by `scatter` |
| God rays | half res | `x, y` light point, `intensity`, `decay`, `density`, `weight`, `color`. Marches 64 samples radially over a light disc (`sourceRadius`, `sourceIntensity`) plus `bloomSource` × bloom, so bright things in the scene also cast shafts. |
| Composite | full res → swapchain | colour + emissive + `bloom.intensity` × bloom + rays, then fog, exposure, tonemap, grade, vignette, dither |

- **Fog** is a screen-space floor mist: a height band from `top` to `bottom` (0..1 of the
  screen, measured down) shaped by `falloff`. Animated fbm sets `noiseScale` and `speed`.
  `lightScatter` tints the mist with nearby bloom so glowing objects light it up.
- **Tonemap** is `'aces'` (the default), `'reinhard'`, or `'none'`, applied after `exposure`.
- **Grade** applies `lift`, `gamma`, and `gain` (RGB each), then `saturation` and `contrast`.
  It runs in display space after tonemapping.
- **Vignette** takes `intensity`, `radius`, `softness`, and `color`.
- **Dither** adds ±½ LSB of noise to hide banding in dark gradients.

When bloom is disabled the bloom chain is skipped. It still runs if god rays need it
(`bloomSource > 0`).

## Notes

- `defaultPostSettings()` is tuned for a dark, jewel-toned scene: a strong emissive glow, a
  cool mist on the floor, and pale storm rays from above.
- Output is encoded to sRGB in the shader because the swapchain is `bgra8unorm`.
- All intermediate textures are reallocated only on resize (or a bloom level cap change).
- **Quality caps** are separate from the look: `post.setQuality({ maxBloomLevels,
  raySamples, fogOctaves })` (defaults 8, 64, 5). Fewer ray samples rescale decay and weight
  per step so the shafts keep their reach; fewer fog octaves add back the dropped octaves'
  mean so the mist keeps its density. Bloom and rays run at half the scene resolution; the
  composite runs at output resolution and samples the scene by UV.
- Write your own processor by implementing `PostProcessor { resize(w, h); encode(encoder,
  inputs, outputView) }` and assigning it to `renderer.post`.
