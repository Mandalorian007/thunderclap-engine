//! The turn-based test game (E7, tc-sim's `tests/turns_game/`) served by
//! the facade, `Server::builder(game)...start()`, and played by
//! TypeScript's `createNet` (`src/net/turns-interop.test.ts`, by vitest):
//! a round, a board watched as a live query, and a resume after a dropped
//! link. Then the store replays to the live state hash. Skipped, with a
//! notice, where node or `node_modules` is missing.

#[path = "../../tc-sim/tests/turns_game/mod.rs"]
mod turns_game;

use std::path::{Path, PathBuf};
use std::process::Command;

use tc_sim::Core;
use thunderclap_server::{AuthMode, Server};

use turns_game::{Turns, TurnsLog};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The state hash the log in `store` replays to at step `time`.
fn replayed_hash(store: &Path, time: u64) -> u64 {
    let read = tc_store::read(store, &TurnsLog).unwrap();
    let (mut core, replayed) = Core::replayed(Turns::new(), &read.entries).unwrap();
    assert_eq!(replayed.skipped, 0);
    core.advance_to(time);
    core.state_hash()
}

#[test]
fn typescript_create_net_plays_a_round() {
    let vitest = repo().join("node_modules/vitest/vitest.mjs");
    let node_ok = Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !node_ok || !vitest.exists() {
        eprintln!("turns interop: node or node_modules missing; skipping the TypeScript client");
        return;
    }
    let dir = std::env::temp_dir().join(format!("tc-server-turns-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    // The page's token is its name: no issued tokens in a test.
    let running = runtime
        .block_on(
            Server::builder(Turns::new())
                .data_dir(&dir)
                .port(0)
                .auth(AuthMode::Open)
                .meta(b"turns".to_vec())
                .net(|c| c.deflate_threads = Some(1))
                .start(),
        )
        .expect("the server starts");
    let store = running.store_dir().to_path_buf();
    let out = Command::new("node")
        .arg(&vitest)
        .args(["run", "src/net/turns-interop.test.ts"])
        .current_dir(repo())
        .env("TC_TURNS_URL", format!("ws://{}", running.addr()))
        .env("TC_TURNS_HASH", turns_game::schema().hash())
        .env("NO_COLOR", "1")
        .output()
        .expect("vitest runs");
    let text = String::from_utf8_lossy(&out.stdout);
    eprintln!("{text}{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "vitest failed");
    assert!(text.contains("3 passed"), "every interop test ran");
    let live = runtime
        .block_on(running.stop())
        .expect("the loop hands back its state");
    assert_eq!(live.game().wins, [0, 1], "O won the TypeScript round");
    assert_eq!(live.game().round, 2, "and O started the next");
    assert_eq!(replayed_hash(&store, live.time()), live.state_hash());
    let _ = std::fs::remove_dir_all(&dir);
}
