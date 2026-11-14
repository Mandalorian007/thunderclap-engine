# Brief: ws/server-net (E2a)

Read:
- `common.md`
- `wave-2.0-1.md` (worktree and machine rules)
- E-042
- `docs/design/2.0/server.md`: all of it, especially the E2 row and §3 (protocol)
- `crates/README.md` and the tc-wire API (E1, ws/server-wire 05969c6)
- `src/net` (C9): the client this server half must talk to

Forge sources, read only: `/Users/matthewfontana/repos/forgewilds/crates/forge-server` (transport, ws, rate, flow, deflate, outbound, session, auth, accounts, clock).

## Goal

`tc-net`, the server's connection layer for any networked game. No Forge nouns.

This step is E2a: transport, the WebSocket server, rate limits, flow control, deflate, the outbound queue, session and handshake, the clock, and the generic envelope `ClientMsg<G>` / `ServerMsg<G>` over tc-wire.

Accounts and auth are their own E2b step later. Leave a trait seam: `Auth` with an allow-all dev implementation.

1. The handshake, ping, close codes (4000–4999 final), `Rejected` (including `stale_schema`), the bulk lane and the entity-stream frame all follow C9's client exactly (`src/net`).
2. An interop test:
   - start a tc-net echo/query test server from `cargo test` or a small `examples/` binary;
   - connect TC's `createNet` client to it from a vitest or e2e test over a real WebSocket;
   - handshake, command, query patch and reconnect all work.

   Use a port from an OS-assigned ephemeral bind. Never use ports 7878, 7979, 5173 or 8686.
3. It must build on native Windows (tokio is fine; no unix-only APIs).

## Done when

- The interop test is green.
- `check:rust` is green.
- The transport and session tests ported from Forge pass.

## Files owned

`crates/tc-net/**`, plus the workspace member line, one interop test and its script.

## Size

About 4k lines.

## Not here

Forge's protocol bump and SDK move are a later Forge PR.
