# Brief: ws/fx-4

Read `docs/briefs/common.md` first. Then read:
- The ws/fx-3 and ws/core-2 rows in `docs/STATUS.md`.
- The wishes routed to ws/fx-4: the ws/core-2 `Math.random` → `Random` line, and the ws/demo-polish-2 line (`Decals` `readsDepth` and the billboard `setText`).
- `src/fx/README.md` end to end.
- `src/fx/**`.
- `src/core/README.md` *Random* (`createRandom`, `fork`).
- `src/render/README.md` *Render hooks* (read only: what `readsDepth` gives a hook).
- `harness/decals*`, `harness/fx3*`.

## Goal

Effects become deterministic under a seed. Decals on moving targets stop lagging a frame. A billboard text plate can change its text without being rebuilt. There are no visual changes for existing pages beyond what determinism implies, and the 2D goldens stay pixel-identical.

STATUS row, *done when*:

- **Seeded fx.**
  - Every `Math.random` in `src/fx` goes through a `Random`, verified by a grep test.
  - Emitters, `createEffect` and `Decals` take an optional `random?: Random`. The default is a fork of a module default seeded once, documented.
  - Test: two effects with the same seed produce identical particle buffers over 120 steps.
- **Decals on the depth hook.**
  - `Decals` registers a `readsDepth` render hook, so box-mode decals sample this frame's depth rather than last frame's copy in `prepare`.
  - The copy path is deleted, unless a caller without hooks needs it. If so, keep it behind the documented fallback.
  - Test (fake GPU): the decal pass binds the current frame's depth view.
  - Harness: a decal on a moving cube shows no one-frame trail. State `lagPx` is 0.
- **Text plate `setText`.**
  - The billboard text plate handle gains `setText(text)`, re-rasterising into its existing atlas cell when it fits and growing the cell when it doesn't.
  - Test: no new texture is allocated when the text fits.
- **Harness.** Add `?seed` and `?decalLag` variants to a new `harness/fx4.html`, `fx4.ts` and `fx4-state.ts`. Add `e2e/fx4.spec.ts`. fx3, fx2 and decals specs stay green: e2e-harden may be editing `e2e/decals.spec.ts`, so don't edit it; only run it.
- **Docs.** The fx README, a CHANGELOG block and the root README harness list.

## Files owned

- `src/fx/**` and its tests.
- New `harness/fx4*`.
- `e2e/fx4.spec.ts`.
- `CHANGELOG.md`.
- The root `README.md` harness list.

Do not edit:
- `src/render/**` (ws/render-5). A hook gap is a wish.
- `src/core/**`.
- `harness/decals*` and `e2e/decals.spec.ts` (ws/e2e-harden).
- `demos/**` and `templates/**`.

Branch from `main` (e23be4d or later). Use `E2E_PORT_OFFSET=810`. Gate per E-031.
