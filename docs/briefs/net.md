# Brief: ws/net (C9)

Read `common.md`, `wave-2.0-1.md` (you join it; E2E_PORT_OFFSET 180), E-041, E-042, `docs/design/2.0/server.md` §4 (the C9 client API) and §3 (protocol), VISION rule 4. Forge source (read only): the client net code server.md names (socket, handshake, liveness, clock, live queries, entity stream, `SnapshotBuffer`, `Predictor`, edit rollback) and their tests.

## Goal

`@thunderclap-engine/engine/net`: the client side of the network seam for any networked game. ROADMAP *done when*: "A two-client demo over an in-page transport; Forge's SDK tests' generic half ported."

1. Sessions over a **host-supplied** transport (`connect` is handed in; the engine opens no connection itself). Ship only an in-page transport pair for tests and the demo.
2. Game-declared message schemas via `defineSchema` (TS side of server.md §3; produce the schema hash exactly as specified there, with a test vector the Rust side will reuse later).
3. Handshake, liveness, clock sync; live queries; snapshot buffers with interpolation; prediction and reconciliation (rollback); interest.
4. Harness page `harness/net.html`: two clients and an in-page authoritative host running a tiny 2D co-op game (not voxels), with injected latency and loss; e2e on the matrix.
5. Port the generic half of Forge's net tests.

## Files owned

New `src/net/**`, `package.json` (one `./net` export + publishConfig twin), `harness/net*`, its spec.

## Gate

common.md.
