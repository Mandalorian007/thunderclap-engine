# Brief: ws/flake-input

Read `docs/briefs/common.md` first, then DECISIONS E-011 (e2e determinism), E-017; `docs/briefs/flake-client.md` (the method: wait for the condition you assert); `e2e/mesh.spec.ts` (the fog test at ~l.174 and the drag test at ~l.202), `e2e/ui.spec.ts` (`menuNav`, ~l.164), `e2e/fixtures.ts`, `harness/mesh.ts` (the circling lamp, `spin`, `LAMP_RAD_PER_S`), `harness/mesh-state.ts`.

## Goal

Four e2e assertions failed today on branches that never touched their pages, every time while eight or more Playwright matrices shared one machine. The specs must pass under that load or wait for the state they assert; the engine and the pages' look stay as they are.

The failures (one run each, never retried):
- `mesh.spec` "the sun casts a shadow and distance fades the ground into the fog": `dist(fog) < dist(ground) * 0.7` failed on `phone-iphone`, `phone-android` and three more rows across ws/pbr, ws/trails, ws/shadow-cull-era runs (fog distance 59.3 vs 44.1 limit). The probe at `probes.fog` sits where the warm lamp passes: the lamp orbits on real time, so a slow frame under load puts it over the probe.
- `mesh.spec` "a pointer drag orbits the camera": `yaw < before - 0.3` got a 0.2 drop on `phone-promax` (ws/xr-post) and failed on `phone-se` (ws/pbr): CDP touch drag events are coalesced when frames are slow, so fewer deltas reach the orbit.
- `ui.spec` "menuNav: the d-pad walks the menu": focused `First` where `Second` was expected on `phone-iphone` (ws/anim): a pad press read once before the next poll.

STATUS row, *done when*: the fog probe is independent of the lamp (move the probe or park the lamp when the page is opened with `?still` and the spec passes it; the visible page without the flag is unchanged); the drag assertion waits on polled state and asserts on direction and a minimum that holds with coalesced events (or drags in steps with `steps:` so deltas arrive); menuNav polls each focus step; `pnpm test:e2e` runs green twice in a row while another matrix runs alongside (start a second `pnpm test:e2e` with `E2E_PORT_OFFSET` in another shell for the second run and report both results); no engine change.

## Scope

- `e2e/mesh.spec.ts`, `e2e/ui.spec.ts`: as above. Prefer `expect.poll` and `waitForFunction` on the state object; never a fixed sleep.
- `harness/mesh.ts`: a `still` query flag that freezes the lamp at a fixed angle away from the fog probe; or move `probes.fog` so the lamp's orbit never reaches it. Pixel-identical rule applies to 2D pages only; the mesh page may change if the flag is off by default and the e2e opens it on.
- Grep every `e2e/*.spec.ts` for a `read()` followed by a threshold assertion on a value that moves over time (`yaw`, `pitch`, `frames`, `updates`, `distance`, focus); convert each to poll. List each in the report.
- `docs/briefs/common.md`: under the gate section, one sentence: "an e2e assertion on a value that moves over time polls (`expect.poll`); a single read is a flake waiting to happen".
- `CHANGELOG.md` one line under Fixed.

## Files owned

`e2e/mesh.spec.ts`, `e2e/ui.spec.ts`, other `e2e/*.spec.ts` for the same pattern only, `e2e/fixtures.ts` (a helper if several specs share it), `harness/mesh.ts` and `harness/mesh-state.ts` (the flag only), `docs/briefs/common.md` (one sentence), `CHANGELOG.md`.

Branch from `main` (ecbb4dd or later). Running alongside: ws/snap-gate (`e2e/golden.spec.ts`, `scripts/snap.mjs`, `*-state.ts` frame counters: stay out), ws/pick (`e2e/pick.spec.ts`), ws/look-zoom (`harness/follow.ts`), integrators merging shadow-cull, xr-post, pbr, anim, trails in that order (each adds its own spec; none edits mesh.spec).
