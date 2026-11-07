# Brief: ws/fx-6

Read these first:
- `docs/briefs/common.md`
- the ws/fx-4 and ws/fx-5 rows and notes in `docs/STATUS.md` (the wish for a GPU readback of particle drift)
- `src/fx/README.md`, `src/fx/particles*.ts`
- `harness/fx3*`, `e2e/fx3.spec.ts`

## Goal

Particle findings are measured directly. The harness and tests can read particle state back from the GPU.

STATUS row, *done when*:

- **Debug readback.** `ParticleSystem.debugReadback(): Promise<{ alive, positions: Float32Array, velocities: Float32Array }>` copies the live buffers into a mapped staging buffer.
  - It is opt-in: create the system with `debug: true`. Without it there is no staging buffer and no cost.
  - It never runs on its own.
  - Unit test against the CPU shadow path.
- **Harness.** `fx3?collide` and `fx3?forces` gain state from a readback every 500 ms:
  - `meanDriftPerSec`: the mean horizontal speed of particles resting on the slab
  - `meanRadius`: for forces
- **Specs.**
  - `fx3` asserts `meanDriftPerSec < 0.05` on collide.
  - `fx3` asserts the forces `meanRadius` settles below 0.3 within 3 s.
  - Keep the leak and pixel assertions.
- **Docs.** The fx README *Debugging* section, the types list and a CHANGELOG line.

## Files owned

You own:
- `src/fx/**`
- `harness/fx3*`, `e2e/fx3.spec.ts`
- `CHANGELOG.md`

Branch from `main` (9fbc59d or later). Use `E2E_PORT_OFFSET=1020`. Gate per E-031 with fx3, fx4 and decals each run alone.
