# Brief: ws/core-3

Read `docs/briefs/common.md` first, then the ws/core-2 and ws/adopt-sweep rows and notes in `docs/STATUS.md`. Then read `src/core/{random,noise}.ts`, their tests, and `src/core/README.md` (*Random*, *Noise*).

## Goal

Positional hashing is a core call, not a per-game helper. Today each demo and template that wants "a stable random value for cell (x, z)" writes its own.

STATUS row, *done when*:

- **The functions.** `hash2(seed, x, z)` and `hash3(seed, x, y, z)` return a uint32, and `hash2f` and `hash3f` return a float in [0, 1).
  - They use the same seed hash as `Random`, and integer inputs are truncated.
  - They allocate nothing.
  - They are pure, with the same output on every platform. Pin a few golden values in tests.
  - Neighbouring cells must not correlate. Test this with a mean and a lag-1 correlation bound over a 256×256 grid.
- **Noise reuses it.** If `noise.ts` already has an internal lattice hash, re-express it on these helpers only if the noise goldens stay bit-identical. Otherwise leave noise alone and say why.
- **Adoption.** grep `demos/` and `templates/` for hand-rolled positional hashes, such as `Math.sin(x*12.9898…)`, `imul` chains and `fract`. Replace each one with `hash2f`/`hash3f`, but only where the visual output may change and no spec pins it.
  - List every replaced and skipped site in the report.
  - The demo specs you touch stay green, each run alone.
- **Docs.** The core README gets a *Hash* section, plus the types list and a CHANGELOG line.

## Files owned

You own:
- `src/core/{random,noise,hash}.ts` and their tests. `hash.ts` is new.
- `src/core/index.ts`, append only
- `src/core/README.md`, `CHANGELOG.md`
- the hash sites in `demos/**` and `templates/**`, swaps only, no other edits

Do not edit:
- `demos/arpg/**` and `templates/third-person/**` (ws/ui-6)
- `src/**` outside core
- e2e specs, except to read them

Branch from `main` (cd856e0 or later). Use `E2E_PORT_OFFSET=880`. Gate per E-031.
