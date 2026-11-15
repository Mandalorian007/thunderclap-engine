//! Reports from players' clients: an error a client hit, a problem a
//! player describes, a telemetry sample, whatever kinds a game names. Each
//! is written to `<dir>/<unix secs>-<from>-<kind>[-n].json` (a JPEG beside
//! it as `.jpg`) by a thread of its own, so the game's loop never waits on
//! the disk, and the control channel's `reports` lists them.
//!
//! The directory cleans itself up: reports older than
//! [`ReportsConfig::keep_days`] go when the writer starts and once a day
//! after, and past [`ReportsConfig::budget`] bytes the oldest go until it
//! holds three quarters of it. Reports never change the game.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tracing::{debug, info, warn};

use crate::proto::ReportBrief;

/// The subdirectory of a server's data that holds its reports, by
/// convention.
pub const REPORTS_DIR: &str = "reports";

/// The most characters of a report's text a [`ReportBrief`] keeps.
pub const BRIEF_CHARS: usize = 100;

/// A report as it arrived.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    /// Who sent it (a player's name).
    pub from: String,
    /// What it is, in the game's own word: `error`, `player`,
    /// `telemetry`, .... Letters, digits and `_` (anything else becomes
    /// `_`).
    pub kind: String,
    /// What happened, in the client's or the player's words.
    pub text: String,
    /// Anything else the game keeps with it (builds, the game's time, the
    /// client's numbers), as JSON.
    pub fields: Value,
    /// A JPEG of the player's screen; empty for none.
    pub image: Vec<u8>,
}

/// How a reports directory is kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportsConfig {
    /// The most bytes it holds; past it, the oldest reports go.
    pub budget: u64,
    /// Reports older than this many days go.
    pub keep_days: u64,
    /// The most bytes one report (text, fields and image) may carry; a
    /// larger one is dropped.
    pub max_report: usize,
    /// Reports waiting to be written; past this, new ones are dropped.
    pub queue: usize,
    /// How many reports one sender (a [`Report::from`]) may send: none,
    /// as many as it likes.
    pub rate: Option<ReportRate>,
}

/// A sender's report budget ([`ReportsConfig::rate`]): `burst` at once,
/// then one each `every`. Reports over it are dropped and counted
/// ([`ReportCounts::rate_limited`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReportRate {
    /// Reports a sender may send at once.
    pub burst: u32,
    /// How long one more takes to earn.
    pub every: Duration,
}

impl Default for ReportsConfig {
    /// 64 MiB, two weeks, 256 KiB a report, 16 waiting, no rate.
    fn default() -> ReportsConfig {
        ReportsConfig {
            budget: 64 * 1024 * 1024,
            keep_days: 14,
            max_report: 256 * 1024,
            queue: 16,
            rate: None,
        }
    }
}

/// What became of the reports since the writer started.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReportCounts {
    /// Handed to [`Reports::submit`].
    pub received: u64,
    /// Written.
    pub saved: u64,
    /// Dropped over their sender's rate ([`ReportsConfig::rate`]).
    pub rate_limited: u64,
    /// Dropped otherwise: too big, the queue full, a failed write.
    pub dropped: u64,
    /// Removed for age or to stay in the budget.
    pub pruned: u64,
}

#[derive(Debug, Default)]
struct Counters {
    received: AtomicU64,
    saved: AtomicU64,
    rate_limited: AtomicU64,
    dropped: AtomicU64,
    pruned: AtomicU64,
}

/// The senders' budgets left: each one's reports in hand (a fraction
/// earned so far) and when it last sent.
#[derive(Debug, Default)]
struct Budgets(HashMap<String, (f64, Instant)>);

/// Senders whose budgets are kept before the full ones are forgotten.
const MAX_SENDERS: usize = 4096;

impl Budgets {
    /// Takes one report from `from`'s budget: false if it has none left.
    fn take(&mut self, rate: ReportRate, from: &str, now: Instant) -> bool {
        let burst = f64::from(rate.burst.max(1));
        let refill = |(left, at): (f64, Instant)| {
            let earned = now.saturating_duration_since(at).as_secs_f64()
                / rate.every.as_secs_f64().max(f64::MIN_POSITIVE);
            (left + earned).min(burst)
        };
        if self.0.len() >= MAX_SENDERS && !self.0.contains_key(from) {
            self.0.retain(|_, b| refill(*b) < burst);
        }
        let left = self.0.get(from).map_or(burst, |b| refill(*b));
        if left < 1.0 {
            return false;
        }
        self.0.insert(from.to_string(), (left - 1.0, now));
        true
    }
}

fn add(c: &AtomicU64, n: u64) {
    c.fetch_add(n, Ordering::Relaxed);
}

#[derive(Debug)]
struct Inner {
    dir: PathBuf,
    config: ReportsConfig,
    counts: Counters,
    budgets: Mutex<Budgets>,
    tx: Mutex<Option<mpsc::SyncSender<Report>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// A reports directory and the thread writing into it. Clones share it;
/// [`Reports::close`] (or the last clone dropped) writes what waits and
/// stops the thread.
#[derive(Clone, Debug)]
pub struct Reports(Arc<Inner>);

impl Reports {
    /// Starts the writer for `dir` (created now), pruning what is past
    /// `config`'s age and budget.
    pub fn open(dir: impl Into<PathBuf>, config: ReportsConfig) -> io::Result<Reports> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let (tx, rx) = mpsc::sync_channel::<Report>(config.queue);
        let inner = Arc::new(Inner {
            dir,
            config,
            counts: Counters::default(),
            budgets: Mutex::new(Budgets::default()),
            tx: Mutex::new(Some(tx)),
            thread: Mutex::new(None),
        });
        // The thread holds a weak link: the last `Reports` dropped closes
        // the channel and the thread ends.
        let weak = Arc::downgrade(&inner);
        let (dir, config) = (inner.dir.clone(), inner.config.clone());
        let thread = std::thread::Builder::new()
            .name("tc-reports".into())
            .spawn(move || {
                let pruned = |n: u64| {
                    if let Some(i) = weak.upgrade() {
                        add(&i.counts.pruned, n);
                    }
                };
                let mut used = prune(&dir, &config, &pruned);
                let mut last_age_check = std::time::Instant::now();
                for report in rx {
                    let saved = save(&dir, &report, config.max_report);
                    let Some(inner) = weak.upgrade() else { break };
                    match saved {
                        Ok((path, bytes)) => {
                            used += bytes;
                            add(&inner.counts.saved, 1);
                            debug!(from = %report.from, kind = %report.kind, file = %path.display(), "report saved");
                        }
                        Err(e) => {
                            add(&inner.counts.dropped, 1);
                            warn!(from = %report.from, kind = %report.kind, "could not save a report in {}: {e}", dir.display());
                        }
                    }
                    drop(inner);
                    if used > config.budget
                        || last_age_check.elapsed() > Duration::from_secs(86_400)
                    {
                        used = prune(&dir, &config, &pruned);
                        last_age_check = std::time::Instant::now();
                    }
                }
            })?;
        *inner.thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(thread);
        Ok(Reports(inner))
    }

    /// The directory.
    pub fn dir(&self) -> &Path {
        &self.0.dir
    }

    /// Queues `report` to be written. False if it was dropped: over its
    /// sender's rate, too big, the queue full, or the writer closed.
    pub fn submit(&self, report: Report) -> bool {
        let c = &self.0.counts;
        add(&c.received, 1);
        if let Some(rate) = self.0.config.rate {
            let mut budgets = self.0.budgets.lock().unwrap_or_else(|e| e.into_inner());
            if !budgets.take(rate, &report.from, Instant::now()) {
                add(&c.rate_limited, 1);
                debug!(from = %report.from, "dropped a report: over its sender's rate");
                return false;
            }
        }
        let size = report.text.len() + report.image.len() + report.fields.to_string().len();
        if size > self.0.config.max_report {
            add(&c.dropped, 1);
            debug!(from = %report.from, size, "dropped a report: too big");
            return false;
        }
        let tx = self.0.tx.lock().unwrap_or_else(|e| e.into_inner());
        let Some(tx) = tx.as_ref() else {
            add(&c.dropped, 1);
            return false;
        };
        match tx.try_send(report) {
            Ok(()) => true,
            Err(TrySendError::Full(r)) => {
                add(&c.dropped, 1);
                debug!(from = %r.from, "dropped a report: the queue is full");
                false
            }
            Err(TrySendError::Disconnected(r)) => {
                add(&c.dropped, 1);
                warn!(from = %r.from, "dropped a report: the writer stopped");
                false
            }
        }
    }

    /// What became of the reports so far.
    pub fn counts(&self) -> ReportCounts {
        let c = &self.0.counts;
        let get = |a: &AtomicU64| a.load(Ordering::Relaxed);
        ReportCounts {
            received: get(&c.received),
            saved: get(&c.saved),
            rate_limited: get(&c.rate_limited),
            dropped: get(&c.dropped),
            pruned: get(&c.pruned),
        }
    }

    /// Writes what waits and stops the thread; later reports are dropped.
    pub fn close(&self) {
        self.0.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        let thread = self
            .0
            .thread
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(t) = thread {
            let _ = t.join();
        }
    }

    /// The reports held that match: see [`held`].
    pub fn held(
        &self,
        since: Option<u64>,
        kind: Option<&str>,
        newest: usize,
    ) -> (u64, Vec<ReportBrief>) {
        held(&self.0.dir, since, kind, newest)
    }
}

/// What the control channel's `reports` request reads
/// ([`Live::reports`](crate::Live::reports)): [`Reports`], or a game's own
/// reports kept its own way. Asked off the runtime's threads.
pub trait ReportsSource: Send + Sync {
    /// The reports held that arrived at or after `since` (Unix seconds)
    /// and are of `kind`: how many, and the `newest` latest, newest first.
    /// `Err` refuses the request (a kind the game doesn't know, say).
    fn held(
        &self,
        since: Option<u64>,
        kind: Option<&str>,
        newest: usize,
    ) -> Result<(u64, Vec<ReportBrief>), String>;

    /// What became of the reports since the server started.
    fn counts(&self) -> ReportCounts;

    /// The game's own numbers about its reports (per player, per build,
    /// ...), carried as [`ReportsReply::extra`](crate::ReportsReply::extra).
    fn extra(&self) -> Option<Value> {
        None
    }
}

impl ReportsSource for Reports {
    fn held(
        &self,
        since: Option<u64>,
        kind: Option<&str>,
        newest: usize,
    ) -> Result<(u64, Vec<ReportBrief>), String> {
        Ok(Reports::held(self, since, kind, newest))
    }

    fn counts(&self) -> ReportCounts {
        Reports::counts(self)
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The thread holds only a weak link and ends once the channel
        // closes; it isn't waited for here (it may be this thread).
        self.tx.get_mut().unwrap_or_else(|e| e.into_inner()).take();
    }
}

/// `kind` or a name as it may appear in a file name: letters, digits and
/// `_` kept (and `-` in a name), anything else `_`, at most 32 characters.
pub fn file_safe(text: &str, dash: bool) -> String {
    let safe: String = text
        .chars()
        .take(32)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || (dash && c == '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() { "_".into() } else { safe }
}

/// Writes `report` into `dir`: its JSON, and its image beside it. Returns
/// the JSON's path and the bytes written.
fn save(dir: &Path, report: &Report, max: usize) -> io::Result<(PathBuf, u64)> {
    let secs = tc_store::unix_now();
    let stem = format!(
        "{secs}-{}-{}",
        file_safe(&report.from, true),
        file_safe(&report.kind, false)
    );
    let mut n = 1;
    let (json_path, stem) = loop {
        let stem = if n == 1 {
            stem.clone()
        } else {
            format!("{stem}-{n}")
        };
        let path = dir.join(format!("{stem}.json"));
        if !path.exists() {
            break (path, stem);
        }
        n += 1;
    };
    let mut written = 0;
    let image = if report.image.is_empty() {
        None
    } else {
        let name = format!("{stem}.jpg");
        fs::write(dir.join(&name), &report.image)?;
        written += report.image.len() as u64;
        Some(name)
    };
    let mut text = json!({
        "kind": report.kind,
        "from": report.from,
        "received_unix": secs,
        "text": report.text,
        "image": image,
        "fields": report.fields,
    })
    .to_string();
    if text.len() > 2 * max {
        text = json!({
            "kind": report.kind,
            "from": report.from,
            "received_unix": secs,
            "text": report.text.chars().take(max / 4).collect::<String>(),
            "image": image,
            "fields": null,
            "cut": true,
        })
        .to_string();
    }
    fs::write(&json_path, &text)?;
    written += text.len() as u64;
    Ok((json_path, written))
}

/// One report's files, as the directory holds them.
struct Held {
    secs: u64,
    stem: String,
    bytes: u64,
    files: Vec<PathBuf>,
}

/// Removes reports past `config`'s age, then the oldest past its budget
/// (down to three quarters). Returns the bytes left.
fn prune(dir: &Path, config: &ReportsConfig, pruned: &dyn Fn(u64)) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut held: Vec<Held> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(stem) = name
            .strip_suffix(".json")
            .or_else(|| name.strip_suffix(".jpg"))
        else {
            continue;
        };
        let Some(secs) = stem
            .split_once('-')
            .and_then(|(s, _)| s.parse::<u64>().ok())
        else {
            continue;
        };
        let bytes = fs::symlink_metadata(e.path()).map(|m| m.len()).unwrap_or(0);
        match held.iter_mut().find(|h| h.stem == stem) {
            Some(h) => {
                h.bytes += bytes;
                h.files.push(e.path());
            }
            None => held.push(Held {
                secs,
                stem: stem.to_string(),
                bytes,
                files: vec![e.path()],
            }),
        }
    }
    held.sort_by(|a, b| (a.secs, &a.stem).cmp(&(b.secs, &b.stem)));
    let oldest = tc_store::unix_now().saturating_sub(config.keep_days.saturating_mul(86_400));
    let mut used: u64 = held.iter().map(|h| h.bytes).sum();
    let target = config.budget / 4 * 3;
    let over = used > config.budget;
    let mut gone = 0;
    for h in &held {
        if h.secs >= oldest && !(over && used > target) {
            break;
        }
        for f in &h.files {
            let _ = fs::remove_file(f);
        }
        used -= h.bytes;
        gone += 1;
    }
    if gone > 0 {
        info!(dir = %dir.display(), gone, "old reports removed");
        pruned(gone);
    }
    used
}

/// The reports in `dir` that arrived at or after `since` (Unix seconds)
/// and are of `kind`, as their file names say: how many, and the `newest`
/// latest, newest first, each read for its text's first line. Only names
/// are read for the count, so a full directory stays cheap. No directory
/// is none.
pub fn held(
    dir: &Path,
    since: Option<u64>,
    kind: Option<&str>,
    newest: usize,
) -> (u64, Vec<ReportBrief>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, Vec::new());
    };
    let mut found: Vec<ReportBrief> = entries
        .flatten()
        .filter_map(|e| brief_of(&e.file_name().to_string_lossy()))
        .filter(|b| since.is_none_or(|s| b.received >= s))
        .filter(|b| kind.is_none_or(|k| b.kind == k))
        .collect();
    let count = found.len() as u64;
    found.sort_by(|a, b| (b.received, &b.file).cmp(&(a.received, &a.file)));
    found.truncate(newest);
    for b in &mut found {
        let text = fs::read_to_string(dir.join(&b.file))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["text"].as_str().map(String::from))
            .unwrap_or_default();
        b.text = text
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(BRIEF_CHARS)
            .collect();
    }
    (count, found)
}

/// A report file's name read: `None` for anything else.
fn brief_of(file: &str) -> Option<ReportBrief> {
    let stem = file.strip_suffix(".json")?;
    let (secs, rest) = stem.split_once('-')?;
    // A taken name's `-2`, `-3`, ... after the kind.
    let rest = match rest.rsplit_once('-') {
        Some((head, n)) if n.parse::<u32>().is_ok() && head.contains('-') => head,
        _ => rest,
    };
    let (from, kind) = rest.rsplit_once('-')?;
    if from.is_empty() || kind.is_empty() {
        return None;
    }
    Some(ReportBrief {
        file: file.to_string(),
        received: secs.parse().ok()?,
        from: from.to_string(),
        kind: kind.to_string(),
        text: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tc-admin-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn report(from: &str, kind: &str, text: &str) -> Report {
        Report {
            from: from.into(),
            kind: kind.into(),
            text: text.into(),
            fields: json!({ "build": "b1" }),
            image: Vec::new(),
        }
    }

    #[test]
    fn reports_are_written_listed_and_counted() {
        let dir = temp("reports");
        let reports = Reports::open(&dir, ReportsConfig::default()).unwrap();
        assert!(reports.submit(report("ada-b", "error", "it broke\nat line 2")));
        assert!(reports.submit(report("ada-b", "error", "again")));
        assert!(reports.submit(Report {
            image: vec![0xff, 0xd8, 1, 2],
            ..report("bo", "player", "a hole in the floor")
        }));
        let big = "x".repeat(300 * 1024);
        assert!(!reports.submit(report("bo", "player", &big)));
        reports.close();
        assert!(!reports.submit(report("bo", "player", "late")));
        assert_eq!(
            reports.counts(),
            ReportCounts {
                received: 5,
                saved: 3,
                rate_limited: 0,
                dropped: 2,
                pruned: 0
            }
        );
        let (count, newest) = reports.held(None, Some("error"), 5);
        assert_eq!(count, 2);
        assert!(
            newest
                .iter()
                .all(|b| b.from == "ada-b" && b.kind == "error")
        );
        assert!(newest.iter().any(|b| b.text == "it broke"));
        let (count, newest) = held(&dir, None, Some("player"), 5);
        assert_eq!((count, newest[0].text.as_str()), (1, "a hole in the floor"));
        let jpgs = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".jpg"))
            .count();
        assert_eq!(jpgs, 1);
        assert_eq!(held(&dir, Some(u64::MAX), None, 5).0, 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_sender_over_its_rate_is_dropped_and_counted() {
        let rate = ReportRate {
            burst: 2,
            every: Duration::from_secs(10),
        };
        let mut b = Budgets::default();
        let t0 = Instant::now();
        assert!(b.take(rate, "ada", t0));
        assert!(b.take(rate, "ada", t0));
        assert!(!b.take(rate, "ada", t0), "the burst is spent");
        assert!(b.take(rate, "bo", t0), "each sender has its own");
        assert!(!b.take(rate, "ada", t0 + Duration::from_secs(9)));
        assert!(
            b.take(rate, "ada", t0 + Duration::from_secs(10)),
            "one earned"
        );
        assert!(b.take(rate, "bo", t0 + Duration::from_secs(60)));
        assert!(
            b.take(rate, "bo", t0 + Duration::from_secs(60)),
            "back to its burst"
        );
        assert!(
            !b.take(rate, "bo", t0 + Duration::from_secs(60)),
            "and no more"
        );

        let dir = temp("rate");
        let reports = Reports::open(
            &dir,
            ReportsConfig {
                rate: Some(rate),
                ..ReportsConfig::default()
            },
        )
        .unwrap();
        for _ in 0..3 {
            reports.submit(report("ada", "error", "again"));
        }
        reports.close();
        let c = reports.counts();
        assert_eq!(
            (c.received, c.saved, c.rate_limited, c.dropped),
            (3, 2, 1, 0)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_directory_keeps_to_its_age_and_budget() {
        let dir = temp("prune");
        fs::create_dir_all(&dir).unwrap();
        let now = tc_store::unix_now();
        // Two old ones (one with an image) and five recent, 1000 bytes each.
        let old = now - 30 * 86_400;
        fs::write(dir.join(format!("{old}-a-error.json")), vec![b' '; 1000]).unwrap();
        fs::write(dir.join(format!("{old}-a-error.jpg")), vec![0; 1000]).unwrap();
        fs::write(
            dir.join(format!("{}-a-error.json", old + 1)),
            vec![b' '; 1000],
        )
        .unwrap();
        for i in 0..5 {
            fs::write(
                dir.join(format!("{}-b-player.json", now - 100 + i)),
                vec![b' '; 1000],
            )
            .unwrap();
        }
        fs::write(dir.join("notes.txt"), "kept").unwrap();
        let config = ReportsConfig {
            budget: 4000,
            ..ReportsConfig::default()
        };
        let reports = Reports::open(&dir, config).unwrap();
        reports.close();
        // The old ones for age, then the oldest recent down to 3000.
        assert_eq!(reports.counts().pruned, 4);
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left.len(), 4, "{left:?}");
        assert!(left.contains(&"notes.txt".to_string()));
        assert!(left.contains(&format!("{}-b-player.json", now - 96)));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_are_read_back() {
        let b = brief_of("1793000000-ada-b-error-2.json").unwrap();
        assert_eq!((b.from.as_str(), b.kind.as_str()), ("ada-b", "error"));
        let b = brief_of("1793000000-ada-error.json").unwrap();
        assert_eq!((b.from.as_str(), b.kind.as_str()), ("ada", "error"));
        assert!(brief_of("1793000000-ada-error.jpg").is_none());
        assert!(brief_of("notes.json").is_none());
        assert_eq!(file_safe("a b/c-d", true), "a_b_c-d");
        assert_eq!(file_safe("a-b", false), "a_b");
        assert_eq!(file_safe("", false), "_");
    }
}
