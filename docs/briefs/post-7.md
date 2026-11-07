# Brief: ws/post-7

Read `docs/briefs/common.md` first. Then read the ws/post-5 and ws/post-6 rows and notes in `docs/STATUS.md`, including the two post-6 wishes this closes. Then read `src/post/README.md` (TAA, *Jitter*), `src/post/{post-stack,taa}.ts`, `src/render/renderer.ts` (read only: `setJitter` and `post`), and `harness/post3*`.

## Goal

The post stack's jitter hook can never be left behind, and no engine page uses the deprecated jitter-camera calls.

STATUS row, *done when*:

- **Hook ownership.** The stack recognises its own hook.
  - When it is detached from the renderer (`renderer.post` set to another stack or `null`), it clears its hook, provided the hook is still its own. Pick the mechanism and say why in the README: an `onDetach` the renderer calls, or a check at the next frame.
  - If `src/render` must change, keep it to one additive setter-side call and name it in the report. ws/render-7 owns `src/render/**` alongside you, so put the change in a separate commit that the integrator can take.
  - Unit test: swapping `renderer.post` from stack A to stack B leaves only B's hook installed; setting it to `null` leaves no hook.
- **Deprecated calls gone from the engine pages.** `harness/post3.ts` no longer calls `addJitterCamera`/`removeJitterCamera`. Keep the post3 goldens and state unchanged, and keep `e2e/post3.spec.ts` green.
  - The deprecated no-ops stay exported for one more release, with a `@deprecated` tag naming the removal.
- **Docs.** Post README *Jitter*, one CHANGELOG line.

## Files owned

You own:
- `src/post/**`
- `harness/post3*`
- `CHANGELOG.md`
- at most one additive line in `src/render/renderer.ts`, in its own commit

Do not edit:
- other `src/render` files
- `demos/**`
- `templates/**`

Branch from `main` (22f809c or later). Use `E2E_PORT_OFFSET=1080`. Gate per E-031 with post2, post3, post4, depth-post and xr each run alone.
