# Brief: ws/fx-5

Read `docs/briefs/common.md` first, then the ws/fx-3, ws/fx-4 and ws/e2e-harden-2 rows and notes in `docs/STATUS.md`. Then read:
- `src/fx/README.md`, *Collision* and *Forces*
- `src/fx/particles*.ts`
- `harness/fx3*`, `e2e/fx3.spec.ts`

## Goal

This settles e2e-harden-2's two fx findings with evidence, and fixes them if they are real.

STATUS row, *done when*:

- **Collide creep.** 2.4–6.2% of resting drops leak off the `fx3?collide` slab. The suspect is the depth-collision push-back along the view ray: resting drops would creep toward the camera and fall off the front edge.
  - Prove or disprove it with a unit or harness measurement, for example the mean drift per second of resting particles against their normal.
  - If it is real, push back along the reconstructed surface normal, or zero the velocity component into the surface on rest. Then show the leak below 0.5% in harness state.
  - If it is not real, find the actual cause or report the evidence.
  - Tighten the fx3 collide limit to the new measured worst case, with a comment.
- **Forces settle.** Constant-magnitude attract with drag 0.4 makes motes orbit through the attractor instead of gathering.
  - Add `attract.falloff: 'constant' | 'linear' | 'inverse-square'` and an optional `attract.radius` dead zone, with `'constant'` as the default so nothing changes. If the harness comment promises a blob, either make `fx3?forces` use the option that delivers it or correct the comment.
  - The fx3 forces test keeps e2e-harden-2's sampling.
- **Docs.** The fx README, the types list and a CHANGELOG line.

## Files owned

You own:
- `src/fx/**`
- `harness/fx3*`
- `e2e/fx3.spec.ts`. ws/e2e-harden-2 edits it in train 4, so branch after it lands, or merge main once it does.
- `CHANGELOG.md`

Do not edit `src/render/**` (ws/render-6). Branch from `main` (f9c3764 or later). Once `git merge-base --is-ancestor 6bca4b8 origin/main` succeeds, merge main before you touch fx3.spec.

Use `E2E_PORT_OFFSET=920`. Gate per E-031 with the fx, fx2, fx3, fx4 and decals specs each run alone.
