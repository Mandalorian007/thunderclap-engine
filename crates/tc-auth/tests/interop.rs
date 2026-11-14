//! tc-auth on tc-net over real WebSockets, on a free port: a session joins
//! with a session token, the token is revoked, and the session is closed
//! with 4001 (final) while others stay; the revoked token is then refused
//! at the handshake. Twice: with a Rust client, and with TypeScript's
//! `createNet` (`src/net/auth-interop.test.ts`, run by vitest), which must
//! not reconnect. The vitest part is skipped, with a notice, where node or
//! the repo's node_modules are missing.
//!
//! The game is tc-net's echo game behind a forwarder that revokes a name
//! when a client sends the command `revoke <name>`.

#[path = "../../tc-net/tests/echo/mod.rs"]
mod echo;

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tc_auth::{Claim, LiveTokens, MemoryAccounts, Revoked, SessionAuth, TokenFormat};
use tc_net::hooks::Hooks;
use tc_net::{ClientMsg, Empty, Request, Server, ServerConfig, ServerMsg, close};
use tc_wire::Wire;
use tokio_tungstenite::tungstenite::Message;

use echo::Echo;

/// The echo game behind a forwarder: `revoke <name>` revokes `name`'s
/// tokens (then echoes as usual).
fn game(auth: Arc<SessionAuth>) -> Sender<Request<Echo>> {
    let (requests, incoming) = channel::<Request<Echo>>();
    let (to_echo, echo_in) = channel();
    std::thread::spawn(move || echo::run(echo_in));
    std::thread::spawn(move || {
        for request in incoming {
            if let Request::Client {
                msg: ClientMsg::Command { command, .. },
                ..
            } = &request
                && let Some(name) = command.strip_prefix("revoke ")
            {
                auth.revoke(name).expect("revokes");
            }
            if to_echo.send(request).is_err() {
                break;
            }
        }
    });
    requests
}

async fn start(auth: Arc<SessionAuth>) -> Server<Echo> {
    start_with(auth, Hooks::default()).await
}

async fn start_with(auth: Arc<SessionAuth>, hooks: Hooks<Echo>) -> Server<Echo> {
    let mut config = ServerConfig::new(echo::schema().hash());
    config.auth = auth.clone();
    config.deflate_threads = Some(1);
    Server::start_with(config, game(auth), hooks)
        .await
        .expect("the server starts")
}

fn auth() -> Arc<SessionAuth> {
    Arc::new(SessionAuth::new(
        "interop-secret",
        TokenFormat::default(),
        Arc::new(MemoryAccounts::default()),
    ))
}

fn token(auth: &SessionAuth, name: &str) -> String {
    auth.issue(&Claim::name(name), &[]).unwrap().token
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn join(server: &Server<Echo>, token: &str) -> (Ws, ServerMsg<Echo>) {
    let url = format!("ws://{}", server.local_addr());
    let mut ws = tokio_tungstenite::connect_async(url)
        .await
        .expect("connects")
        .0;
    send(
        &mut ws,
        ClientMsg::Hello {
            token: token.into(),
            schema_hash: echo::schema().hash(),
            bulk: None,
            ext: Empty,
        },
    )
    .await;
    let first = msg(&mut ws).await.expect("an answer");
    (ws, first)
}

async fn send(ws: &mut Ws, msg: ClientMsg<Echo>) {
    ws.send(Message::Binary(msg.to_bytes().into()))
        .await
        .unwrap();
}

async fn msg(ws: &mut Ws) -> Option<ServerMsg<Echo>> {
    loop {
        let next = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("an answer in time");
        match next {
            Some(Ok(Message::Binary(b))) => {
                return Some(ServerMsg::from_bytes(&b).expect("decodes"));
            }
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
            Some(Ok(_)) => {}
        }
    }
}

async fn command(ws: &mut Ws, seq: u32, text: &str) {
    send(
        ws,
        ClientMsg::Command {
            seq,
            command: text.into(),
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_revoked_token_closes_its_session_with_4001() {
    let auth = auth();
    let server = start(auth.clone()).await;
    let ada = token(&auth, "ada");
    let bob = token(&auth, "bob");

    let (mut ws, first) = join(&server, &ada).await;
    assert!(matches!(first, ServerMsg::Welcome { .. }), "{first:?}");
    let (mut other, first) = join(&server, &bob).await;
    assert!(matches!(first, ServerMsg::Welcome { .. }), "{first:?}");

    command(&mut ws, 1, "revoke ada").await;
    let closed = loop {
        match msg(&mut ws).await.expect("a Closed before the end") {
            ServerMsg::Closed { code, reason } => break (code, reason),
            _ => continue,
        }
    };
    assert_eq!(closed.0, close::REVOKED);
    assert!(close::is_final(closed.0));
    assert!(closed.1.contains("revoked"), "{}", closed.1);
    assert!(msg(&mut ws).await.is_none(), "closed after Closed");

    // Bob's session verified again and stays.
    command(&mut other, 2, "still").await;
    loop {
        match msg(&mut other).await.expect("bob stays") {
            ServerMsg::CommandResult { seq: 2, result } => {
                assert_eq!(result, "STILL");
                break;
            }
            ServerMsg::Closed { .. } => panic!("bob was closed"),
            _ => {}
        }
    }

    // The revoked token is refused at the handshake; a new one joins.
    let (_, first) = join(&server, &ada).await;
    match first {
        ServerMsg::Rejected {
            reason,
            stale_schema,
        } => {
            assert!(!stale_schema);
            assert!(reason.contains("revoked"), "{reason}");
        }
        other => panic!("{other:?}"),
    }
    let (_, first) = join(&server, &token(&auth, "ada")).await;
    assert!(matches!(first, ServerMsg::Welcome { .. }), "{first:?}");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_tokens_count_the_sessions_a_revoke_closes() {
    let auth = auth();
    let live = LiveTokens::new();
    let hooks = Hooks {
        hello: Some(live.hook()),
        ..Hooks::default()
    };
    let server = start_with(auth.clone(), hooks).await;
    let ada = token(&auth, "ada");
    let (_a1, first) = join(&server, &ada).await;
    assert!(matches!(first, ServerMsg::Welcome { .. }), "{first:?}");
    let (_a2, _) = join(&server, &ada).await;
    let (_b, _) = join(&server, &token(&auth, "bob")).await;
    assert_eq!((live.len(), live.on("ada").len()), (3, 2));
    assert_eq!(live.on("ada")[0].1, ada, "the token each joined on");

    // Revoked in the store, as an operator's tool would.
    auth.accounts().claim(&Claim::name("ada").reset()).unwrap();
    let revoked = live
        .revoke(auth.as_ref(), "ada", Duration::from_secs(5))
        .await;
    assert_eq!(
        revoked,
        Some(Revoked {
            generation: 2,
            closed: 2,
            closing: 0
        })
    );
    assert_eq!(live.len(), 1);
    server.stop().await;
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn typescript_create_net_is_closed_for_good_on_revoke() {
    let vitest = repo().join("node_modules/vitest/vitest.mjs");
    let node_ok = Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !node_ok || !vitest.exists() {
        eprintln!("tc-auth interop: node or node_modules missing; skipping the TypeScript client");
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let auth = auth();
    let server = runtime.block_on(start(auth.clone()));
    let out = Command::new("node")
        .arg(&vitest)
        .args(["run", "src/net/auth-interop.test.ts"])
        .current_dir(repo())
        .env(
            "TC_AUTH_INTEROP_URL",
            format!("ws://{}", server.local_addr()),
        )
        .env("TC_AUTH_INTEROP_HASH", echo::schema().hash())
        .env("TC_AUTH_INTEROP_TOKEN", token(&auth, "ada"))
        .env("NO_COLOR", "1")
        .output()
        .expect("vitest runs");
    let text = String::from_utf8_lossy(&out.stdout);
    eprintln!("{text}{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "vitest failed");
    assert!(text.contains("2 passed"), "every interop test ran");
    runtime.block_on(server.stop());
}
