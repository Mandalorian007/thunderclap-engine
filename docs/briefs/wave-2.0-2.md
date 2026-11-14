# Wave 2.0-2: the render core's two halves (2026-11-14)

Read after `common.md` and `wave-2.0-1.md` (its rules on worktrees, size, the machine and shared files still apply). B1's retained core (`src/render/core/`, ws/core-retained head a237c57) is landing on main now.

**Start point.** If `git merge-base --is-ancestor a237c57 main` is true, branch from main. Otherwise branch from `ws/core-retained`, and `git merge main` once it lands (B1 itself does not change, so this is clean).

| Step | Branch | Owns | E2E_PORT_OFFSET |
| --- | --- | --- | --- |
| B2 core-immediate | ws/core-immediate | the immediate API's files (`src/render/renderer.ts` frame API, `frame.*`, `InstanceList`, `Drawable`, mesh/sprite paths, the emissive target), `src/core/platform*` / `initGpu` feature requests | 210 |
| B3 core-views | ws/core-views | `src/render/core/**` (owner from now on), views/two-views/XR render path, `src/render/fake-gpu.ts`, `src/testing/index.ts` exports | 220 |

B2 builds on the core's public API. If it needs a core change, it makes the smallest additive change in a new file under `src/render/core/` and names it in the report, or asks B3 by writing the ask into its report.
