//! Dev hot reload: [`Builder::watch`](crate::Builder::watch) polls the
//! game's data files, waits for them to go quiet, and reloads through the
//! builder's loader; a load that fails leaves the game running as it was.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use tc_admin::DataLoader;
use tc_sim::{Game, ReloadReport, SimHandle};
use tracing::{info, warn};

/// How often the files are looked at, by default.
pub const WATCH_POLL: Duration = Duration::from_millis(100);
/// How long they must stay unchanged before a reload, by default (an
/// editor saves in steps).
pub const WATCH_QUIET: Duration = Duration::from_millis(300);

/// A reload the watcher did.
#[derive(Clone, Debug)]
pub struct WatchEvent {
    /// The files that changed (added, changed or removed) since the last.
    pub changed: Vec<PathBuf>,
    /// The reload's report, or why the data didn't load (the game runs on
    /// as it was).
    pub result: Result<ReloadReport, String>,
}

type OnReload = Arc<dyn Fn(&WatchEvent) + Send + Sync>;

/// How [`Builder::watch`](crate::Builder::watch) watches.
#[derive(Clone)]
pub struct WatchConfig {
    /// How often the files are looked at.
    pub poll: Duration,
    /// How long they must stay unchanged before a reload.
    pub quiet: Duration,
    on_reload: Option<OnReload>,
}

impl Default for WatchConfig {
    fn default() -> WatchConfig {
        WatchConfig {
            poll: WATCH_POLL,
            quiet: WATCH_QUIET,
            on_reload: None,
        }
    }
}

impl std::fmt::Debug for WatchConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchConfig")
            .field("poll", &self.poll)
            .field("quiet", &self.quiet)
            .field("on_reload", &self.on_reload.is_some())
            .finish()
    }
}

impl WatchConfig {
    /// Calls `f` after every reload, done or failed (on the watcher's
    /// thread), besides the log line: a game's report of what changed.
    pub fn on_reload(mut self, f: impl Fn(&WatchEvent) + Send + Sync + 'static) -> Self {
        self.on_reload = Some(Arc::new(f));
        self
    }
}

/// A file's size and time: a change is told by either.
type Seen = BTreeMap<PathBuf, (u64, Option<SystemTime>)>;

/// Every file under `paths` (directories walked), with its size and time.
fn scan(paths: &[PathBuf]) -> Seen {
    fn walk(path: &Path, out: &mut Seen, depth: u32) {
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        if meta.is_dir() {
            if depth > 32 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(path) else {
                return;
            };
            for e in entries.flatten() {
                walk(&e.path(), out, depth + 1);
            }
        } else {
            out.insert(path.to_path_buf(), (meta.len(), meta.modified().ok()));
        }
    }
    let mut out = Seen::new();
    for p in paths {
        walk(p, &mut out, 0);
    }
    out
}

fn diff(a: &Seen, b: &Seen, into: &mut BTreeSet<PathBuf>) {
    for (p, v) in b {
        if a.get(p) != Some(v) {
            into.insert(p.clone());
        }
    }
    for p in a.keys() {
        if !b.contains_key(p) {
            into.insert(p.clone());
        }
    }
}

/// The watcher's thread, stopped when dropped.
pub(crate) struct Watcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub(crate) fn spawn<G: Game>(
        paths: Vec<PathBuf>,
        config: WatchConfig,
        handle: SimHandle<G>,
        load: DataLoader<G>,
    ) -> Result<Watcher, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::Builder::new()
            .name("tc-watch".into())
            .spawn(move || watch(&paths, &config, &handle, &load, &stopped))
            .map_err(|e| format!("starting the watcher: {e}"))?;
        Ok(Watcher {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn watch<G: Game>(
    paths: &[PathBuf],
    config: &WatchConfig,
    handle: &SimHandle<G>,
    load: &DataLoader<G>,
    stop: &AtomicBool,
) {
    let poll = config.poll.max(Duration::from_millis(1));
    let mut seen = scan(paths);
    let mut changed = BTreeSet::new();
    let mut last_change: Option<Instant> = None;
    info!(files = seen.len(), "watching the game's data");
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(poll);
        let now = scan(paths);
        if now != seen {
            diff(&seen, &now, &mut changed);
            seen = now;
            last_change = Some(Instant::now());
            continue;
        }
        if last_change.is_none_or(|t| t.elapsed() < config.quiet) {
            continue;
        }
        last_change = None;
        let result = load().and_then(|data| {
            handle
                .reload(data)
                .recv()
                .unwrap_or_else(|_| Err("the game's loop stopped".into()))
        });
        let event = WatchEvent {
            changed: std::mem::take(&mut changed).into_iter().collect(),
            result,
        };
        match &event.result {
            Ok(r) => info!(
                files = event.changed.len(),
                time = r.time,
                version = r.version,
                "reloaded the game's data"
            ),
            Err(e) => warn!(
                files = event.changed.len(),
                "the game's data didn't reload (running on as it was): {e}"
            ),
        }
        if let Some(f) = &config.on_reload {
            f(&event);
        }
    }
}
