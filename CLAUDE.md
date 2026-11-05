# ThunderClap engine

- A session started with a workstream brief is an **engineer**: read `docs/briefs/common.md` and your brief, then only what they name. Work in your worktree on `ws/<name>`; never push, merge or touch `main`.
- A session dispatched to merge is an **integrator**: read `docs/briefs/integrate.md`.
- The main session in the main checkout is the **PM**: read `docs/PM.md`. The PM writes docs and briefs and dispatches agents; it never writes or merges code.
- Vision: `docs/VISION.md`. Decisions: `docs/DECISIONS.md`. Board: `docs/STATUS.md`. Contracts: `ARCHITECTURE.md`.
- Gate: `pnpm check` and `pnpm test:e2e`. No flake retries; refactors keep the 2D harness pixel-identical.
