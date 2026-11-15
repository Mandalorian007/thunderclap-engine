//! What a game like Forge Wilds builds its `serve`, `dev` and command line
//! on: the game's own status, a started hook whose guard lives until stop,
//! a backup before a new build opens the store, hot reload of watched data
//! (a bad load leaving the game running), the game's own commands and
//! `serve` options on the CLI, and the stop file.

#[path = "../../tc-sim/tests/tally/mod.rs"]
mod tally;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde_json::json;
use tc_admin::{Reply, Request};
use thunderclap_server::cli::{Cli, Command};
use thunderclap_server::{
    AUTO_BACKUPS_DIR, BACKUPS_DIR, Builder, LAST_OPEN_FILE, STOP_FILE, Server, WatchConfig,
    WatchEvent,
};

use tally::Tally;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-serve-fit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn builder(dir: &Path, build: &str) -> Builder<Tally> {
    Server::builder(Tally::new(false))
        .data_dir(dir)
        .build(build)
        .net(|c| c.deflate_threads = Some(1))
}

async fn ask(store: &Path, request: Request) -> Reply {
    let store = store.to_path_buf();
    tokio::task::spawn_blocking(move || tc_admin::ask(&store, &request).expect("answers"))
        .await
        .unwrap()
}

/// Drops set a flag: the started hook's guard.
struct Guard(Arc<AtomicBool>);

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_started_hook_and_a_backup_before_a_new_build() {
    let dir = temp_dir("status");
    let dropped = Arc::new(AtomicBool::new(false));
    let announced = Arc::new(Mutex::new(None));
    let (d, a) = (dropped.clone(), announced.clone());
    let running = builder(&dir, "v1")
        .backup_on_new_build(2)
        .game_status(|| json!({ "names": ["ada"], "sections": 12 }))
        .on_started(move |r| {
            *a.lock().unwrap() = Some(r.addr());
            Box::new(Guard(d))
        })
        .start()
        .await
        .expect("starts");
    assert_eq!(*announced.lock().unwrap(), Some(running.addr()));
    assert_eq!(
        running.open_backup(),
        None,
        "a new store: nothing to back up"
    );
    assert!(!running.loop_ended());
    let store = running.store_dir().to_path_buf();
    let Reply::Status(s) = ask(&store, Request::Status).await else {
        panic!("a status");
    };
    assert_eq!(s.game, Some(json!({ "names": ["ada"], "sections": 12 })));
    assert!(s.to_string().contains("game {"), "{s}");
    assert!(!dropped.load(Ordering::Relaxed));
    running.stop().await.expect("the game");
    assert!(dropped.load(Ordering::Relaxed), "the guard goes at stop");
    assert_eq!(
        std::fs::read_to_string(dir.join(LAST_OPEN_FILE)).unwrap(),
        "v1"
    );

    // The same build: no backup. A new one: backed up first, the newest two
    // kept, apart from the admin channel's backups.
    let running = builder(&dir, "v1")
        .backup_on_new_build(2)
        .start()
        .await
        .unwrap();
    assert_eq!(running.open_backup(), None);
    running.stop().await;
    let auto = dir.join(BACKUPS_DIR).join(AUTO_BACKUPS_DIR);
    for (i, build) in ["v2", "v3", "v4"].into_iter().enumerate() {
        let running = builder(&dir, build)
            .backup_on_new_build(2)
            .start()
            .await
            .unwrap();
        let backup = running.open_backup().expect("backed up").to_path_buf();
        assert!(backup.starts_with(&auto));
        assert!(backup.join("store.meta").exists());
        running.stop().await;
        let kept = std::fs::read_dir(&auto).unwrap().count();
        assert_eq!(kept, (i + 1).min(2));
    }
    assert!(builder(&dir, "v4").backups().list().is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watched_data_reloads_and_a_bad_load_keeps_the_game() {
    let dir = temp_dir("watch");
    let content = dir.join("content");
    std::fs::create_dir_all(&content).unwrap();
    let file = content.join("multiplier.txt");
    std::fs::write(&file, "1").unwrap();
    let loads = Arc::new(AtomicU64::new(0));
    let (tx, events) = mpsc::channel::<WatchEvent>();
    let tx = Mutex::new(tx);
    let (path, counted) = (file.clone(), loads.clone());
    let mut config = WatchConfig::default().on_reload(move |e| {
        let _ = tx.lock().unwrap().send(e.clone());
    });
    config.poll = Duration::from_millis(20);
    config.quiet = Duration::from_millis(60);
    // Without a loader, watching is refused before anything opens.
    let refused = builder(&dir, "w")
        .watch([content.clone()], config.clone())
        .start()
        .await;
    assert!(refused.is_err());
    let running = builder(&dir, "w")
        .reload_with(move || {
            counted.fetch_add(1, Ordering::Relaxed);
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            text.trim()
                .parse::<u64>()
                .map(Arc::new)
                .map_err(|_| format!("{text:?} is not a number"))
        })
        .watch([content.clone()], config)
        .start()
        .await
        .expect("starts");
    let next = || {
        events
            .recv_timeout(Duration::from_secs(5))
            .expect("a reload in time")
    };

    std::fs::write(&file, "x").unwrap();
    let e = next();
    assert_eq!(e.changed, std::slice::from_ref(&file));
    assert!(e.result.unwrap_err().contains("not a number"));
    assert!(!running.loop_ended(), "the game runs on");

    // Several saves close together: one reload.
    std::fs::write(content.join("other.txt"), "a").unwrap();
    std::fs::write(&file, "30").unwrap();
    let e = next();
    assert_eq!(e.changed.len(), 2, "{:?}", e.changed);
    let report = e.result.expect("reloaded");
    assert!(report.version < u64::MAX);
    assert_eq!(loads.load(Ordering::Relaxed), 2);
    assert!(events.recv_timeout(Duration::from_millis(300)).is_err());
    running.stop().await.expect("the game");
    std::fs::remove_dir_all(&dir).unwrap();
}

fn args(line: &str) -> Vec<String> {
    std::iter::once("tally")
        .chain(line.split_whitespace())
        .map(String::from)
        .collect()
}

#[test]
fn the_cli_takes_the_games_commands_serve_options_and_the_stop_file() {
    let dir = temp_dir("cli");
    let data = dir.display().to_string();
    let applied = Arc::new(Mutex::new(None));
    let seen = applied.clone();
    let serve_dir = dir.clone();
    let serve_data = data.clone();
    let server = std::thread::spawn(move || {
        Cli::new(move || {
            builder(&serve_dir, "cli").game_requests(|name, args| match name {
                "where" => Ok(json!({ "asked": args })),
                _ => Err(format!("no {name}")),
            })
        })
        .serve_options(
            &["seed"],
            &["fresh"],
            "[--seed N] [--fresh]",
            move |b, given| {
                let seed: Option<u64> = given.number("seed")?;
                *seen.lock().unwrap() = Some((seed, given.flag("fresh")));
                Ok(b)
            },
        )
        .main(args(&format!("serve --seed 7 --fresh --data {serve_data}")))
    });
    let store = dir.join("store");
    let deadline = Instant::now() + Duration::from_secs(10);
    while tc_admin::ask(&store, &Request::Status).is_err() {
        assert!(Instant::now() < deadline, "it never served");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(*applied.lock().unwrap(), Some((Some(7), true)));

    let cli = |line: &str| {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c = calls.clone();
        let code = Cli::new(|| builder(&dir, "cli"))
            .command(
                Command::ask_game("where", "where NAME [--near]", "where")
                    .words(1, 1)
                    .flags(&["near"]),
            )
            .command(
                Command::new("count", "count [WORDS..] [--twice]", move |inv| {
                    let n = inv.words().len() * if inv.flag("twice") { 2 } else { 1 };
                    c.lock().unwrap().push(n);
                    match inv.ask(&Request::Status)? {
                        Reply::Status(_) => Ok(n.to_string()),
                        _ => Err("no status".into()),
                    }
                })
                .words(0, 9)
                .flags(&["twice"]),
            )
            .main(args(&format!("{line} --data {data}")));
        let calls = calls.lock().unwrap().clone();
        (code, calls)
    };
    assert_eq!(cli("count a b --twice"), (0, vec![4]));
    assert_eq!(cli("count --thrice").0, 2, "an unknown flag");
    assert_eq!(cli("where ada --near").0, 0);
    assert_eq!(cli("where").0, 2, "a word short");
    assert_eq!(cli("status").0, 0, "the built-ins stay");

    // The stop file stops it, cleanly.
    std::fs::write(dir.join(STOP_FILE), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !server.is_finished() {
        assert!(Instant::now() < deadline, "the stop file didn't stop it");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(server.join().unwrap(), 0);
    assert!(!dir.join(STOP_FILE).exists(), "taken");
    std::fs::remove_dir_all(&dir).unwrap();
}
