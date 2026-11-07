# Brief: ws/harden-api

Read `docs/briefs/common.md` first. Then read `package.json` `exports`, `scripts/check-boundaries.mjs`, `scripts/check-docs.mjs`, every `src/*/index.ts`, and the *Backlog* section of `docs/STATUS.md`, in particular the prune, texture-registry, pick, gltf-anim and skinning lines.

## Goal

Before `engine-v1.0.0`, the public surface becomes something we change on purpose, not by accident. Know what we export. Make every change to it visible in review. Fix the small inconsistencies a first-time reader trips over.

The STATUS row is done when:

- **API surface snapshot**
  - Add `scripts/api-surface.mjs`, using Node built-ins plus the repo's `tsc` declaration emit. For each `exports` entry it writes `api/<entry>.api.txt`: every exported name and its declared signature, sorted and stable.
  - Add `pnpm check:api`, wired into `pnpm check`. It fails when the emitted surface differs from the committed files, and prints the diff.
  - Add `pnpm api:update`, which rewrites the files.
  - Test: adding an export fails the check, and `api:update` makes it pass.
  - Add a `common.md` bullet as a proposal in your report, not an edit: *a branch that changes the API commits the updated `api/*.api.txt`*.
- **Audit table** in your report. List every export that looks internal, for example `BindingSet` or `CAMERA_BLOCK_FLOATS`. Also list every naming inconsistency across modules, for example `mipFilter` versus `filter`, `Renderer.white` versus `defaultTextures`, options named `*Opts` versus `*Options`, and getters versus methods. For each one give the file and line, who uses it (demos, templates, tests), and a proposed fix.
- **Safe fixes only.** Apply a fix only when nothing in `demos/**` or `templates/**` uses the name and the change is a rename with a deprecated alias kept for one minor version, or the removal of an export used only by tests. Everything else stays a proposal for me to schedule.
- **Docs**
  - Add one *API surface* paragraph to `ARCHITECTURE.md`.
  - Add one CHANGELOG line.
  - Mention every alias in its module README, so `check:docs` stays green.

## Files owned

You own:
- `scripts/api-surface.mjs` and its test
- `api/**` (new)
- the `check:api` and `api:update` lines in `package.json` and their place in `check`
- the safe fixes in `src/*/index.ts` and their source lines
- the module README alias notes
- the one ARCHITECTURE paragraph
- `CHANGELOG.md`

Do not edit:
- `demos/**` and `templates/**`
- the root `README.md` and `docs/**`

Branch from `origin/main`. Use `E2E_PORT_OFFSET=1240`. Gate per E-031: `pnpm check`, `snap:check`, and any spec of a module you renamed in, each run alone.
