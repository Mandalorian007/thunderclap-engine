//! The facade end to end: tc-sim's tally game served by
//! `Server::builder()...start()`, a client joining with an issued token,
//! and the admin channel's status, pause, resume, backup, reload, revoke
//! (the client closed with 4001) and stop; then the store reopened, and
//! the CLI's offline backup and rollback.

#[path = "../../tc-sim/tests/tally/mod.rs"]
mod tally;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tc_admin::{AdminError, ENDPOINT_FILE, Endpoint, Reply, Reports, ReportsConfig, Request};
use tc_auth::Claim;
use tc_net::{ClientMsg, Empty, ServerMsg, close};
use tc_wire::Wire;
use thunderclap_server::{Builder, Server, cli};
use tokio_tungstenite::tungstenite::Message;

use tally::{Tally, TallyProto};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-server-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn builder(dir: &Path) -> Builder<Tally> {
    Server::builder(Tally::new(false))
        .data_dir(dir)
        .build("tally-test")
        .reload_with(|| Ok(Arc::new(3)))
        .net(|c| c.deflate_threads = Some(1))
}

/// Asks the server holding `store`, off the runtime's threads.
async fn ask(store: &Path, request: Request) -> Result<Reply, AdminError> {
    let store = store.to_path_buf();
    tokio::task::spawn_blocking(move || tc_admin::ask(&store, &request))
        .await
        .unwrap()
}

async fn send(ws: &mut Ws, msg: ClientMsg<TallyProto>) {
    ws.send(Message::Binary(msg.to_bytes().into()))
        .await
        .unwrap();
}

/// The next message, or the close code if the connection ends.
async fn next(ws: &mut Ws) -> Result<ServerMsg<TallyProto>, Option<u16>> {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("something in time");
        match m {
            Some(Ok(Message::Binary(b))) => match ServerMsg::from_bytes(&b).expect("decodes") {
                ServerMsg::Closed { code, .. } => return Err(Some(code)),
                m => return Ok(m),
            },
            Some(Ok(Message::Close(frame))) => return Err(frame.map(|f| u16::from(f.code))),
            Some(Ok(_)) => {}
            None | Some(Err(_)) => return Err(None),
        }
    }
}

async fn join(addr: std::net::SocketAddr, token: &str) -> Ws {
    let mut ws = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("connects")
        .0;
    send(
        &mut ws,
        ClientMsg::Hello {
            token: token.into(),
            schema_hash: tally::schema().hash(),
            bulk: None,
            ext: Empty,
        },
    )
    .await;
    ws
}

async fn command(ws: &mut Ws, seq: u32, text: &str) -> String {
    send(
        ws,
        ClientMsg::Command {
            seq,
            command: text.into(),
        },
    )
    .await;
    loop {
        if let Ok(ServerMsg::CommandResult { seq: s, result }) = next(ws).await
            && s == seq
        {
            return result;
        }
    }
}

/// The status, once `ok` holds of it (it is published up to a second
/// late).
async fn status_until(store: &Path, ok: impl Fn(&tc_admin::Status) -> bool) -> tc_admin::Status {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let Ok(Reply::Status(s)) = ask(store, Request::Status).await else {
            panic!("no status");
        };
        if ok(&s) {
            return s;
        }
        assert!(Instant::now() < deadline, "the status never came: {s}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_admin_channel_drives_a_served_game() {
    let dir = temp_dir("admin");
    let reports = Reports::open(dir.join("reports"), ReportsConfig::default()).unwrap();
    let mut running = builder(&dir)
        .reports(reports.clone())
        .start()
        .await
        .expect("starts");
    let store = running.store_dir().to_path_buf();
    assert!(store.join(ENDPOINT_FILE).exists());

    // A client with an issued token plays.
    let auth = running.auth().expect("dev guests").clone();
    let token = auth.issue(&Claim::name("ada"), &[]).unwrap().token;
    let mut ada = join(running.addr(), &token).await;
    assert!(matches!(
        next(&mut ada).await,
        Ok(ServerMsg::Welcome { player: 1, .. })
    ));
    assert_eq!(command(&mut ada, 1, "add 2").await, "2");

    // Status.
    let s = status_until(&store, |s| s.players == [1] && s.version >= 2).await;
    assert_eq!((s.connections, s.build.as_str()), (1, "tally-test"));
    assert_eq!(s.port, running.addr().port());
    assert!(s.frames_sent > 0 && !s.paused && !s.stopping, "{s}");

    // Pause and resume the clock.
    let Ok(Reply::Clock { paused: true, .. }) = ask(&store, Request::Pause).await else {
        panic!("not paused");
    };
    status_until(&store, |s| s.paused).await;
    let Ok(Reply::Clock { paused: false, .. }) = ask(&store, Request::Resume).await else {
        panic!("not resumed");
    };
    status_until(&store, |s| !s.paused).await;

    // Backup, online, into the data's backups; the endpoint's token stays
    // behind.
    let Ok(Reply::BackedUp {
        dir: out,
        last_seq,
        files,
        ..
    }) = ask(&store, Request::Backup { out: None }).await
    else {
        panic!("no backup");
    };
    assert!(last_seq >= 2 && files >= 1, "{last_seq} {files}");
    let out = PathBuf::from(out);
    assert!(out.starts_with(dir.join("backups")), "{}", out.display());
    assert!(out.join("store.meta").exists());
    assert!(!out.join(ENDPOINT_FILE).exists());

    // Reload: the multiplier is 3 now.
    let reload = ask(&store, Request::Reload).await;
    assert!(matches!(reload, Ok(Reply::Reloaded { .. })), "{reload:?}");
    assert_eq!(command(&mut ada, 2, "add 1").await, "9");

    // Reports the game wrote are listed.
    reports.submit(tc_admin::Report {
        from: "ada".into(),
        kind: "error".into(),
        text: "it broke".into(),
        ..Default::default()
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let Ok(Reply::Reports(r)) = ask(
            &store,
            Request::Reports {
                since: None,
                kind: None,
            },
        )
        .await
        else {
            panic!("no reports");
        };
        if r.count == 1 {
            assert_eq!((r.received, r.newest[0].text.as_str()), (1, "it broke"));
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // A wrong token, a game request with no handler, a name the rules
    // refuse.
    let mut wrong = Endpoint::read(&store).unwrap();
    wrong.token = tc_admin::new_token();
    let refused =
        tokio::task::spawn_blocking(move || tc_admin::ask_endpoint(&wrong, &Request::Status))
            .await
            .unwrap();
    assert_eq!(refused, Ok(Reply::Refused("a wrong token".into())));
    let game = ask(
        &store,
        Request::Game {
            name: "kick".into(),
            args: serde_json::Value::Null,
        },
    )
    .await;
    assert!(matches!(game, Ok(Reply::Unknown(_))), "{game:?}");
    let bad = ask(
        &store,
        Request::Revoke {
            name: "Not A Name".into(),
        },
    )
    .await;
    assert!(matches!(bad, Ok(Reply::Refused(_))), "{bad:?}");

    // Revoke: ada's session closes with 4001, and the token is refused.
    let Ok(Reply::Revoked { name, generation }) =
        ask(&store, Request::Revoke { name: "ada".into() }).await
    else {
        panic!("not revoked");
    };
    assert_eq!(name, "ada");
    assert!(generation >= 1);
    let code = loop {
        if let Err(code) = next(&mut ada).await {
            break code;
        }
    };
    assert_eq!(code, Some(close::REVOKED));
    let mut again = join(running.addr(), &token).await;
    let answer = next(&mut again).await;
    assert!(
        matches!(answer, Ok(ServerMsg::Rejected { .. }) | Err(_)),
        "the old token still joins: {answer:?}"
    );

    // Stop, through the channel.
    let Ok(Reply::Stopping { already: false }) = ask(&store, Request::Stop).await else {
        panic!("not stopping");
    };
    tokio::time::timeout(Duration::from_secs(5), running.stopped())
        .await
        .expect("stop arrives");
    let core = running.stop().await.expect("the game");
    assert_eq!(core.game().tally_of("ada"), Some(9));
    assert!(!store.join(ENDPOINT_FILE).exists());
    assert!(matches!(
        ask(&store, Request::Status).await,
        Err(AdminError::NoChannel(_))
    ));

    // Started again, the store reopens where it was.
    let running = builder(&dir).start().await.expect("starts again");
    let s = status_until(&store, |s| s.version > 0).await;
    assert!(s.version >= 3, "{s}");
    let core = running.stop().await.expect("the game");
    // Replayed under the builder's data (a multiplier of 1): 2 + 1.
    assert_eq!(core.game().tally_of("ada"), Some(3));

    // Offline, the CLI backs up and rolls back a copy.
    let data = dir.display().to_string();
    let cli = |line: &str| {
        let args = std::iter::once("tally".to_string())
            .chain(line.split_whitespace().map(String::from))
            .chain(["--data".to_string(), data.clone()]);
        cli::main(args, || builder(&dir))
    };
    assert_eq!(cli("backup"), 0);
    let copy = dir.join("rolled");
    assert_eq!(
        cli(&format!("rollback --seq 1 --copy {}", copy.display())),
        0
    );
    assert!(copy.join("store.meta").exists());
    assert_eq!(cli("status"), 1, "nothing runs");
    assert_eq!(cli("rollback"), 2);
    assert_eq!(cli("seal"), 2);
    // Two backups kept so far (one online, one offline).
    assert_eq!(builder(&dir).backups().list().len(), 2);

    reports.close();
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn generate_ts_writes_the_client_typescript_once() {
    let out = temp_dir("gen");
    let written =
        thunderclap_server::generate_ts::<Tally>(&out, &tc_tsgen::Config::default()).unwrap();
    assert_eq!(written, [out.join("generated.ts")]);
    let text = std::fs::read_to_string(&written[0]).unwrap();
    assert!(text.contains(&tally::schema().hash()));
    let again =
        thunderclap_server::generate_ts::<Tally>(&out, &tc_tsgen::Config::default()).unwrap();
    assert!(again.is_empty());
    std::fs::remove_dir_all(&out).unwrap();
}
