# Brief: ws/input-12

Read `docs/briefs/common.md` first, then the ws/render-10, ws/core-8, ws/assets-4, ws/api-core and ws/src-v1 wish lines in `docs/STATUS.md`. **Post-v1 rule:** `api/` is frozen. Additions are allowed, but each changed module needs a CHANGELOG `## Unreleased` *Added* line, and `check:api` enforces it. No breaking changes.

## Goal

Typed games get exact types, and overlay buttons can be recorded.

STATUS row, *done when*:

- **Bindings.** A context can add actions the base map lacks, and the types now say so: context bindings take `Partial<Bindings<A>>` over the full action union. This must not break existing typed callers. Test it with `expectTypeOf` or tsd-style type tests.
- **Typed pointers.** `EngineCtx` `P` is tightened from `any` to the real router type, inferred from `createGame`, if that can be done without breaking existing callers. If it can't, write down why and leave a type test showing what works.
- **Overlay recording.** Overlay page-button events can be recorded and replayed.
  - Give each button a stable id, either a game-supplied `id` or one derived from the page and button key.
  - Record the id, not the DOM node.
  - Test: record a button press, replay it, and the handler fires on the same frame.
- **Docs.** Update the input and ui READMEs, add CHANGELOG *Added* lines, and run `api:update`.

**Files owned:**
- `src/{input,core}/**`
- `src/ui/{overlay,pages,widgets*}.ts` and their tests
- `api/` and CHANGELOG

Branch from origin/main. Use `E2E_PORT_OFFSET=1400`.

Gate:
- `pnpm check` and `snap:check`
- each run alone: replay, input, input5, ui, ui4, ui5
