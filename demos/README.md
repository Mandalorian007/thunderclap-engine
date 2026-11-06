# Demos

Each demo under `demos/<name>/` exercises one real use case end to end, outside the engine and
outside the package, so a regression shows up as a visible or measured change. Run one with
`pnpm demo <name>`; its spec lives in `e2e/demos/<name>.spec.ts` and reads `window.__demo`.

| Demo | Shows | Engine modules | Spec checks |
| --- | --- | --- | --- |
| `range` | First-person target range: pointer-lock look, ray picks through `meshTester`, hinge tween, sparks, tracer, positioned chime, score anchor | input, render, fx, audio, ui, platform, core | boot clean; `aimAt(i)` + click hits `i`, scores, resets after 3 s; sky shot misses; tap fires on touch rows; desktop fps > 20 |
