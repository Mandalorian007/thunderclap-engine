//! tc-net against its clients over real WebSockets, on a free port:
//!
//! - a Rust client (tokio-tungstenite): the handshake, a stale schema, a
//!   command, the bulk lane and its acks;
//! - TypeScript's `createNet` (`src/net/interop.test.ts`, run by vitest):
//!   the handshake, a command, a live query's patch, the entity stream,
//!   the bulk lane, reconnect and close codes. Skipped, with a notice,
//!   where node or the repo's node_modules are missing.

mod echo;

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tc_net::{ClientMsg, Empty, Server, ServerConfig, ServerMsg, close, codec};
use tc_wire::{Bytes, Wire, bulk};
use tokio_tungstenite::tungstenite::Message;

use echo::Echo;

async fn start() -> Server<Echo> {
    let (requests, game) = std::sync::mpsc::channel();
    std::thread::spawn(move || echo::run(game));
    let mut config = ServerConfig::new(echo::schema().hash());
    config.deflate_threads = Some(1);
    Server::start(config, requests)
        .await
        .expect("the server starts")
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(server: &Server<Echo>) -> Ws {
    let url = format!("ws://{}", server.local_addr());
    tokio_tungstenite::connect_async(url)
        .await
        .expect("connects")
        .0
}

async fn send(ws: &mut Ws, msg: ClientMsg<Echo>) {
    ws.send(Message::Binary(msg.to_bytes().into()))
        .await
        .unwrap();
}

async fn recv(ws: &mut Ws) -> Option<Vec<u8>> {
    loop {
        let next = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("an answer in time");
        match next {
            Some(Ok(Message::Binary(b))) => return Some(b.to_vec()),
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
            Some(Ok(_)) => {}
        }
    }
}

async fn msg(ws: &mut Ws) -> ServerMsg<Echo> {
    ServerMsg::from_bytes(&recv(ws).await.expect("a message")).expect("decodes")
}

fn hello(hash: &str, bulk: Option<u8>) -> ClientMsg<Echo> {
    ClientMsg::Hello {
        token: "ada".into(),
        schema_hash: hash.into(),
        bulk,
        ext: Empty,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rust_client_handshakes_commands_and_acks_the_bulk_lane() {
    let server = start().await;
    let hash = echo::schema().hash();

    // A stale schema: Rejected, stale.
    let mut ws = connect(&server).await;
    send(&mut ws, hello("0000", None)).await;
    match msg(&mut ws).await {
        ServerMsg::Rejected { stale_schema, .. } => assert!(stale_schema),
        other => panic!("{other:?}"),
    }
    assert!(recv(&mut ws).await.is_none(), "closed after Rejected");

    // A good one, with a deflated bulk lane.
    let mut ws = connect(&server).await;
    send(&mut ws, hello(&hash, Some(codec::DEFLATE))).await;
    match msg(&mut ws).await {
        ServerMsg::Welcome { step_us, .. } => assert_eq!(step_us, 50_000),
        other => panic!("{other:?}"),
    }
    send(
        &mut ws,
        ClientMsg::Command {
            seq: 1,
            command: "hi".into(),
        },
    )
    .await;
    assert_eq!(
        msg(&mut ws).await,
        ServerMsg::CommandResult {
            seq: 1,
            result: "HI".into()
        }
    );
    // Several rounds of the bulk lane, each acked as the browser does: the
    // `Bulk`'s data length.
    for round in 0..3u32 {
        let seq = 10 + round;
        send(
            &mut ws,
            ClientMsg::Command {
                seq,
                command: "bulk 50".into(),
            },
        )
        .await;
        assert_eq!(
            msg(&mut ws).await,
            ServerMsg::CommandResult {
                seq,
                result: "50".into()
            }
        );
        let mut got = 0;
        while got < 50 {
            let ServerMsg::Bulk { codec: c, data } = msg(&mut ws).await else {
                panic!("a Bulk");
            };
            let raw = if c == codec::DEFLATE {
                tc_net::deflate::inflate(&data.0).expect("inflates")
            } else {
                data.0.clone()
            };
            for frame in bulk::frames(&raw) {
                let frame = frame.expect("a frame");
                assert!(matches!(
                    ServerMsg::<Echo>::from_bytes(frame),
                    Ok(ServerMsg::Game(_))
                ));
                got += 1;
            }
            send(
                &mut ws,
                ClientMsg::Ack {
                    bytes: data.0.len() as u64,
                },
            )
            .await;
        }
        assert_eq!(got, 50);
    }
    // An ack for data never sent ends the session.
    send(&mut ws, ClientMsg::Ack { bytes: 1 << 40 }).await;
    assert!(recv(&mut ws).await.is_none());

    // Shutting down tells clients to come back (not final).
    let mut ws = connect(&server).await;
    send(&mut ws, hello(&hash, None)).await;
    assert!(matches!(msg(&mut ws).await, ServerMsg::Welcome { .. }));
    let stop = tokio::spawn(server.stop());
    match msg(&mut ws).await {
        ServerMsg::Closed { code, .. } => assert!(!close::is_final(code)),
        other => panic!("{other:?}"),
    }
    stop.await.unwrap();
    let _ = Bytes(Vec::new());
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn typescript_create_net_interop() {
    let vitest = repo().join("node_modules/vitest/vitest.mjs");
    let node_ok = Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !node_ok || !vitest.exists() {
        eprintln!("tc-net interop: node or node_modules missing; skipping the TypeScript client");
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let server = runtime.block_on(start());
    let out = Command::new("node")
        .arg(&vitest)
        .args(["run", "src/net/interop.test.ts"])
        .current_dir(repo())
        .env(
            "TC_NET_INTEROP_URL",
            format!("ws://{}", server.local_addr()),
        )
        .env("TC_NET_INTEROP_HASH", echo::schema().hash())
        .env("NO_COLOR", "1")
        .output()
        .expect("vitest runs");
    let text = String::from_utf8_lossy(&out.stdout);
    eprintln!("{text}{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "vitest failed");
    assert!(text.contains("6 passed"), "every interop test ran");
    runtime.block_on(server.stop());
}
