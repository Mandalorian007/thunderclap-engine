# Demos

End-to-end quality demos, outside the engine and the package (`docs/briefs/demos-common.md`). Run one with `pnpm demo <name>`; each has a spec in `e2e/demos/`.

| Demo | Shows | Engine modules | Spec |
| --- | --- | --- | --- |
| [showroom](showroom/) | 7×7 PBR sphere grid (metalness × roughness), sun shadows, three moving point lights, emissive strip, canvas-textured floor, orbit camera, five post looks on keys 1–5 | platform, render, post, input, ui, core | `showroom.spec.ts`: 3 draw calls, lit middle sphere, looks switch, parked lights, fps |
