//! The loop behind a real tc-net server, on its own thread:
//!
//! - two Rust clients (tokio-tungstenite) send commands; the log on disk,
//!   replayed, reaches the live game's state hash;
//! - TypeScript's `createNet` (`src/net/sim-interop.test.ts`, run by
//!   vitest; `pnpm test:sim-interop` runs just this test) joins,
//!   commands and sees the flush before the result, follows a live
//!   query's patches and the entity stream. Skipped, with a
//!   notice, where node or the repo's node_modules are missing.

mod tally;

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tc_net::{ClientMsg, Empty, Server, ServerConfig, ServerMsg};
use tc_sim::{Core, Running, Sim, SimConfig};
use tc_wire::Wire;
use tokio_tungstenite::tungstenite::Message;

use tally::{Tally, TallyProto};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-sim-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

async fn start(dir: &std::path::Path) -> (Server<TallyProto>, Running<Tally>) {
    let sim = Sim::create(dir, Tally::new(false), b"tally", SimConfig::default()).unwrap();
    let running = sim.spawn().unwrap();
    let mut config = ServerConfig::new(tally::schema().hash());
    config.deflate_threads = Some(1);
    let server = Server::start(config, running.requests.clone())
        .await
        .expect("the server starts");
    (server, running)
}

async fn connect(server: &Server<TallyProto>, name: &str) -> Ws {
    let url = format!("ws://{}", server.local_addr());
    let mut ws = tokio_tungstenite::connect_async(url)
        .await
        .expect("connects")
        .0;
    send(
        &mut ws,
        ClientMsg::Hello {
            token: name.into(),
            schema_hash: tally::schema().hash(),
            bulk: None,
            ext: Empty,
        },
    )
    .await;
    ws
}

async fn send(ws: &mut Ws, msg: ClientMsg<TallyProto>) {
    ws.send(Message::Binary(msg.to_bytes().into()))
        .await
        .unwrap();
}

async fn msg(ws: &mut Ws) -> ServerMsg<TallyProto> {
    loop {
        let next = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("an answer in time");
        match next {
            Some(Ok(Message::Binary(b))) => return ServerMsg::from_bytes(&b).expect("decodes"),
            Some(Ok(_)) => {}
            other => panic!("closed: {other:?}"),
        }
    }
}

/// A client and what it was sent but nobody has looked at yet.
struct Client {
    ws: Ws,
    seen: Vec<ServerMsg<TallyProto>>,
}

impl Client {
    /// Waits for a message `want` picks, keeping the others.
    async fn until<T>(&mut self, mut want: impl FnMut(&ServerMsg<TallyProto>) -> Option<T>) -> T {
        if let Some(i) = self.seen.iter().position(|m| want(m).is_some()) {
            return want(&self.seen.remove(i)).unwrap();
        }
        loop {
            let m = msg(&mut self.ws).await;
            match want(&m) {
                Some(t) => return t,
                None => self.seen.push(m),
            }
        }
    }

    /// Sends a command and waits for its result.
    async fn command(&mut self, seq: u32, text: &str) -> String {
        send(
            &mut self.ws,
            ClientMsg::Command {
                seq,
                command: text.into(),
            },
        )
        .await;
        self.until(|m| match m {
            ServerMsg::CommandResult { seq: s, result } if *s == seq => Some(result.clone()),
            _ => None,
        })
        .await
    }

    async fn game(&mut self, text: &str) {
        self.until(|m| (*m == ServerMsg::Game(text.into())).then_some(()))
            .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_clients_play_and_the_log_replays_to_the_same_hash() {
    let dir = temp_dir("net");
    let (server, running) = start(&dir).await;
    let status = running.handle.status();

    let mut ada = Client {
        ws: connect(&server, "ada").await,
        seen: Vec::new(),
    };
    assert!(matches!(
        msg(&mut ada.ws).await,
        ServerMsg::Welcome { player: 1, .. }
    ));
    let mut bo = Client {
        ws: connect(&server, "bo").await,
        seen: Vec::new(),
    };
    assert!(matches!(
        msg(&mut bo.ws).await,
        ServerMsg::Welcome { player: 2, .. }
    ));
    assert_eq!(ada.command(1, "add 3").await, "3");
    assert_eq!(bo.command(1, "later 4").await, "0");
    assert_eq!(ada.command(2, "add 5").await, "8");
    assert!(bo.command(2, "nonsense").await.starts_with("error"));
    // bo sees ada's flush, and the later add lands five steps on.
    bo.game("ada 8").await;
    ada.game("bo 4").await;
    let s = status.get();
    assert_eq!(s.players, vec![1, 2], "{s}");
    assert_eq!(s.connections, 2);

    server.stop().await;
    let live = running.stop();
    assert_eq!(live.game().tally_of("bo"), Some(4));

    let read = tc_store::read(&dir, &tally::TallyLog).unwrap();
    let (mut replayed, _) = Core::replayed(Tally::new(false), &read.entries).unwrap();
    replayed.advance_to(live.time());
    assert_eq!(replayed.state_hash(), live.state_hash());
    let _ = std::fs::remove_dir_all(&dir);
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
        eprintln!("tc-sim interop: node or node_modules missing; skipping the TypeScript client");
        return;
    }
    let dir = temp_dir("interop");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let (server, running) = runtime.block_on(start(&dir));
    let out = Command::new("node")
        .arg(&vitest)
        .args(["run", "src/net/sim-interop.test.ts"])
        .current_dir(repo())
        .env(
            "TC_SIM_INTEROP_URL",
            format!("ws://{}", server.local_addr()),
        )
        .env("TC_SIM_INTEROP_HASH", tally::schema().hash())
        .env("NO_COLOR", "1")
        .output()
        .expect("vitest runs");
    let text = String::from_utf8_lossy(&out.stdout);
    eprintln!("{text}{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "vitest failed");
    assert!(text.contains("4 passed"), "every interop test ran");
    runtime.block_on(server.stop());
    let core = running.stop();
    assert_eq!(core.game().tally_of("cy"), Some(7));
    let _ = std::fs::remove_dir_all(&dir);
}
