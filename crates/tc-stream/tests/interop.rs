//! The section stream behind a real tc-net server, to TypeScript's
//! `createNet` filling the voxel `SectionStore`
//! (`src/net/stream-interop.test.ts`, run by vitest; `pnpm
//! test:stream-interop` runs just this test). The client loads its area,
//! is dropped while a cell changes, and resumes holding what it had: only
//! the changed section comes again; then it moves away, and what it left
//! goes in an `UnloadBox`. Skipped, with a notice, where node or
//! the repo's node_modules are missing.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::Duration;

use tc_net::envelope::Protocol;
use tc_net::{
    ClientMsg, ConnId, Empty, Outbound, Request, Server, ServerConfig, ServerMsg, close,
    schema_builder,
};
use tc_stream::{
    SectionPos, SectionSource, SectionStream, StreamConfig, StreamInterest, StreamMsg, decode_raw,
    encode_raw, game_frame,
};
use tc_wire::Wire;
use tc_wire::schema::Schema;

/// Cells per section edge (the client's `sectionSize`).
const SIZE: usize = 4;

#[derive(Debug, Clone, PartialEq)]
struct Streamed;

impl Protocol for Streamed {
    type Hello = Empty;
    type Welcome = Empty;
    type Command = String;
    type Result = String;
    type Interest = StreamInterest;
    type Input = Empty;
    type State = Empty;
    type Client = Empty;
    type Server = StreamMsg;
}

fn schema() -> Schema {
    schema_builder::<Streamed>().finish().expect("valid")
}

/// Stone below section y 0, a pattern at y 0, air above; edits on top.
#[derive(Default)]
struct World {
    edits: BTreeMap<SectionPos, Vec<u32>>,
}

impl World {
    fn cells(&self, pos: SectionPos) -> Vec<u32> {
        if let Some(c) = self.edits.get(&pos) {
            return c.clone();
        }
        let n = SIZE.pow(3);
        match pos.y {
            y if y < 0 => vec![1; n],
            0 => (0..n).map(|i| u32::from(i % 3 == 0)).collect(),
            _ => vec![0; n],
        }
    }
}

impl SectionSource for World {
    fn build(&mut self, pos: SectionPos, out: &mut Vec<u8>) {
        encode_raw(&self.cells(pos), out);
    }

    fn exists(&self, pos: SectionPos) -> bool {
        (-2..=2).contains(&pos.y)
    }

    fn cells(&self, bytes: &[u8], out: &mut Vec<u32>) -> bool {
        decode_raw(bytes, SIZE.pow(3), out)
    }
}

/// The game loop: the stream over every connection's lanes, flushed every
/// few milliseconds. Commands: `set x y z index cell` changes a cell;
/// `drop x y z index cell` changes one and drops the connection before
/// the change is flushed (it reconnects).
fn run(requests: Receiver<Request<Streamed>>) {
    let mut world = World::default();
    let mut stream = SectionStream::new(
        StreamConfig {
            unload_boxes: true,
            ..StreamConfig::default()
        },
        game_frame::<Streamed>(),
    );
    let mut lanes: BTreeMap<ConnId, Outbound> = BTreeMap::new();
    loop {
        match requests.recv_timeout(Duration::from_millis(5)) {
            Ok(Request::Connect { conn, out, .. }) => {
                let welcome = ServerMsg::<Streamed>::Welcome {
                    player: conn,
                    time: 0,
                    paused: false,
                    step_us: 50_000,
                    ext: Empty,
                };
                let _ = out.try_send(welcome.to_bytes());
                lanes.insert(conn, out);
                stream.connect(conn);
            }
            Ok(Request::Disconnect { conn }) => {
                lanes.remove(&conn);
                stream.disconnect(conn);
            }
            Ok(Request::Client { conn, msg, .. }) => match msg {
                ClientMsg::SetInterest { interest } => {
                    if let Err(e) = stream.set_stream_interest(conn, &interest)
                        && let Some(out) = lanes.get(&conn)
                    {
                        let reason = e.to_string();
                        let _ = out.try_send(
                            ServerMsg::<Streamed>::InterestRejected { reason }.to_bytes(),
                        );
                    }
                }
                ClientMsg::Command { seq, command } => {
                    let w: Vec<&str> = command.split_whitespace().collect();
                    let n: Vec<i64> = w.iter().skip(1).filter_map(|s| s.parse().ok()).collect();
                    let result = if let [x, y, z, index, cell] = n[..] {
                        let pos = SectionPos::new(x as i32, y as i32, z as i32);
                        let mut cells = world.cells(pos);
                        cells[index as usize] = cell as u32;
                        world.edits.insert(pos, cells);
                        stream.changed(pos);
                        "ok".to_string()
                    } else {
                        format!("error: {command}")
                    };
                    if let Some(out) = lanes.get(&conn) {
                        let _ = out.try_send(
                            ServerMsg::<Streamed>::CommandResult { seq, result }.to_bytes(),
                        );
                        if w.first() == Some(&"drop") {
                            let _ = out.try_send(
                                ServerMsg::<Streamed>::Closed {
                                    code: close::RESTART,
                                    reason: "dropped".into(),
                                }
                                .to_bytes(),
                            );
                            lanes.remove(&conn);
                            stream.disconnect(conn);
                        }
                    }
                }
                _ => {}
            },
            Ok(Request::Wake) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if stream.has_work() {
            stream.flush(&mut world, &mut lanes);
            for out in lanes.values() {
                out.wake();
            }
        }
    }
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn typescript_section_store_interop() {
    let vitest = repo().join("node_modules/vitest/vitest.mjs");
    let node_ok = Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !node_ok || !vitest.exists() {
        eprintln!(
            "tc-stream interop: node or node_modules missing; skipping the TypeScript client"
        );
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let (tx, rx) = channel();
    // The game loop ends once the server's senders are gone.
    std::thread::spawn(move || run(rx));
    let mut config = ServerConfig::new(schema().hash());
    config.deflate_threads = Some(1);
    let server = runtime
        .block_on(Server::<Streamed>::start(config, tx))
        .expect("the server starts");
    let out = Command::new("node")
        .arg(&vitest)
        .args(["run", "src/net/stream-interop.test.ts"])
        .current_dir(repo())
        .env(
            "TC_STREAM_INTEROP_URL",
            format!("ws://{}", server.local_addr()),
        )
        .env("TC_STREAM_INTEROP_HASH", schema().hash())
        .env("NO_COLOR", "1")
        .output()
        .expect("vitest runs");
    let text = String::from_utf8_lossy(&out.stdout);
    eprintln!("{text}{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "vitest failed");
    assert!(text.contains("2 passed"), "every interop test ran");
    runtime.block_on(server.stop());
}
