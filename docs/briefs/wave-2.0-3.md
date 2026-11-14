# Wave 2.0-3

Same rules as `wave-2.0-1.md`: a worktree per step, `nice -n 10`, 1–3 hours, about 4k lines, the PM integrates.

## Start point

Branch from `main`. If main does not yet contain ws/core-views (251cd81) and ws/core-immediate (5a79434), merge whichever of those your brief names into your branch first, then run `pnpm check`. The integrator lands them, plus ws/actors and ws/ref-scenes, while you work. When they're on main, merge main again before you report.

## Ownership

| Step | Owns | Shared, touched carefully |
| --- | --- | --- |
| B4 core-passes | `src/post/**`, `src/render/shadow.ts`, `src/fx/sky*`, new `src/render/core/passes/**`, device-loss in `src/render/core/**` and `src/platform/gpu.ts` | `src/render/renderer.ts` (pass wiring), `src/actors/**` (loss hook only) |
| B5 core-effects | `src/fx/{particles,water,decals,trail,billboard}*`, new `src/fx/weather*` | `src/fx/index.ts`, the core PassList registration |
| C6 ui-world | `src/ui/**` (new world presenter, `stack.ts`) | `src/kit/**` (if the presenter needs a service) |
| C8 xr-merge | `src/platform/xr-*`, `src/kit/xr.ts`, new `src/xr/**` | `src/core/game.ts` (XR path), `src/render/core/views*` |

Shared docs (README, ARCHITECTURE, CHANGELOG, api) are append-only.

E2E port offsets:

| Step | Offset |
| --- | --- |
| B4 | 260 |
| B5 | 270 |
| C6 | 280 |
| C8 | 290 |

The WebKit iPad project is on main (A1). Run your touched specs with `--project=webkit-ipad` as well as Chromium. When a spec is green there, add it to `WEBKIT_SPECS`.
