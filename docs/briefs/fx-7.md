# Brief: ws/fx-7

Read `docs/briefs/common.md` first. Then read the ws/fx-6 row and notes in `docs/STATUS.md`. This brief closes the wish for *an unpacked readback option*. Then read:
- `src/fx/README.md`, especially *Debug readback*
- the fx-6 readback code and its tests
- `harness/fx3*` and `e2e/fx3.spec.ts`

## Goal

Tests and tools read particle state by field, with no knowledge of the GPU packing.

STATUS row, *done when*:

- **Unpacked readback.** `debugReadback({ unpacked: true })`, or a separate `readbackFields()`, if that reads cleaner, resolves to named typed arrays per live particle: `position`, `velocity`, `age`, `life`, `radius`, plus whatever else the packed layout carries. Each is the right length for the live count.
  - The packed form stays the default and is unchanged.
  - It remains opt-in, and costs nothing when unused.
- **Tests.**
  - Unit test, on the fake GPU: unpack a known packed buffer and get exactly the expected per-field values.
  - fx3 state moves its drift and radius computation onto the unpacked fields, with values unchanged within 1e-6.
- **Docs.** The fx README *Debug readback* section, the types list and one CHANGELOG line.

## Files owned

You own:
- `src/fx/**`
- `harness/fx3*` (state only)
- `e2e/fx3.spec.ts` (additive)
- `CHANGELOG.md`

Do not edit:
- `src/render/**`
- `src/core/test-utils/**` (a core/test-utils sweep is queued; make any fake GPU need a wish)
- `demos/**`
- `templates/**`

Branch from `main` (56e0840 or later). Use `E2E_PORT_OFFSET=1130`. Gate per E-031, with fx, fx2, fx3 and particles each run alone (whichever of these exist).
