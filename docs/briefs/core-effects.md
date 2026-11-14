# Brief: ws/core-effects (B5)

Read:
- `common.md` and `wave-2.0-3.md`
- `docs/design/2.0/architecture.md` (R1–R3)
- B1's DrawSet and PassList, B3's views

Merge ws/core-views first if it isn't on main.

Forge sources, read only: `FW:render/weather-pass.ts`, `weather-shader.ts`, `drops*.ts`, `fall-shader.ts`, `life-motes.ts`.

## Goal

The world effects run on the render core, so they draw in every view (stereo included) through bundles. Each is a drawable or pass that any game registers. No Forge nouns.

1. **Particles** (`src/fx/particles*`, `billboard*`, `trail*`):
   - GPU simulation and draw as core drawables, culled per view;
   - camera-facing in each eye, using the eye's own view.
2. **Weather** (new `src/fx/weather*`), generalized from Forge's weather pass:
   - precipitation volumes (rain, snow, or any game-defined particle) that follow the camera;
   - an occlusion height so it doesn't fall under roofs, a wind vector and an intensity knob.

   Forge's rain and snow are one config of it. A desert dust storm is another (the harness demo).
3. **Water** (`src/fx/water*`): surface drawable plus refraction and reflection inputs from the core's depth and colour per view.
4. **Decals** (`src/fx/decals*`): projected onto core depth per view.
5. **Quality knobs:** each effect registers knobs with C7's governor (`./quality`): particle budget, weather density and water reflection.

## Done when

- The fx harness pages are pixel-identical, or each difference is named.
- The stereo page shows particles, weather and water in both eyes from one bundle per view.
- A counted budget test shows calls flat in particle count.
- The weather demo runs two configs.

## Size

M–L. Ship 1–3 first if you run long.
