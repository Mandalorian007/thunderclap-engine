//! Syncs off the appending thread: appends held while the I/O or the
//! background thread syncs, a new file that syncs nothing where it is
//! made, and a hold that can't be written.

use std::fs::{self, OpenOptions};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use super::*;
use crate::durable;
use crate::format::HEADER_LEN;
use crate::hold::Hold;
use crate::io::Step;
use crate::{Log, MAIN_LOG};

/// Every log file's bytes in generation 0, but `main.log`'s records
/// without its clock marks (where a mark lands among appends made while
/// it syncs depends on timing, unless they are held).
fn log_bytes(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = fs::read_dir(dir.join("log"))
        .unwrap()
        .map(|f| f.unwrap().path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let bytes = fs::read(path).unwrap();
            if name != MAIN_LOG {
                return (name, bytes);
            }
            let mut kept = Vec::new();
            for r in format::scan(&bytes).unwrap().records {
                if r.kind != KIND_WALL_MARK && r.kind != KIND_MARK {
                    kept.push(r.kind);
                    kept.extend_from_slice(r.payload);
                }
            }
            (name, kept)
        })
        .collect()
}

/// Waits until `done` (at most 30 s).
fn wait_until(what: &str, done: impl Fn() -> bool) {
    let mut tries = 0;
    while !done() {
        tries += 1;
        assert!(tries < 30_000, "{what} never happened");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Appends and marks, then appends to `main.log` and two keyed files
/// while the next mark syncs (held there if `stall`). Returns how many
/// bytes were held, and whether the files were unchanged then.
fn append_during_a_sync(log: &mut Log<Tables>, dir: &Path, stall: bool) -> (usize, bool) {
    log.append(&say(1, "a")).unwrap();
    mark(log, 0);
    // Both keyed files exist first: creating one writes it at once.
    log.append_all(&[put(2, 0, "a"), put(3, 1, "a")]).unwrap();
    log.io().stall_syncs(stall);
    log.mark(0).unwrap();
    if stall {
        wait_until("the stall", || log.io().stalled());
    }
    let before = log_bytes(dir);
    log.append(&say(4, "b")).unwrap();
    log.append(&put(5, 0, "b")).unwrap();
    log.append(&put(6, 1, "b")).unwrap();
    let held = (log.hold().held_len(), log_bytes(dir) == before);
    log.io().stall_syncs(false);
    log.wait().unwrap();
    assert_eq!(log.hold().held_len(), 0);
    held
}

/// An append made while the I/O thread syncs doesn't wait for the sync:
/// it is held, and written when the sync returns, before the mark. The
/// files end up byte for byte as if nothing had been held.
#[test]
fn an_append_during_a_sync_is_held_and_written_as_it_returns() {
    let (mut plain, plain_dir) = new_log("held-plain");
    // Its appends may be held too (if the real sync is still running).
    append_during_a_sync(&mut plain, &plain_dir, false);
    drop(plain);

    let (mut log, dir) = new_log("held");
    let (held, unchanged) = append_during_a_sync(&mut log, &dir, true);
    assert!(held > 0, "nothing was held");
    assert!(unchanged, "a held append reached a file during the sync");
    drop(log);
    assert_eq!(log_bytes(&dir), log_bytes(&plain_dir));
    assert_eq!(marks(&dir), [(0, 1), (0, 3)]);
    // The appends held during its sync are written before the mark.
    let bytes = fs::read(dir.join("log/main.log")).unwrap();
    let last = format::scan(&bytes).unwrap().records.last().unwrap().kind;
    assert!(matches!(last, KIND_MARK | KIND_WALL_MARK), "{last}");
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(log.last_seq(), 6);
    drop(log);
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&plain_dir);
}

/// What doesn't fit in the hold waits for the sync, then is written after
/// what was held, in order, in every file.
#[test]
fn an_append_that_does_not_fit_in_the_hold_waits_for_the_sync() {
    let dir = temp("hold-full");
    fs::create_dir_all(&dir).unwrap();
    let open = |name: &str| {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(name))
            .unwrap();
        Arc::new(file)
    };
    let (a, b) = (open("a"), open("b"));
    let hold = Arc::new(Hold::new());
    let half = vec![1u8; hold.room() / 2];
    hold.write(&a, b"before").unwrap();
    let (began, go) = (mpsc::channel(), mpsc::channel());
    let syncer = std::thread::spawn({
        let hold = hold.clone();
        let (began, go) = (began.0, go.1);
        move || {
            let ((), released) = hold.during(|| {
                began.send(()).unwrap();
                go.recv().unwrap();
                std::thread::sleep(Duration::from_millis(50));
            });
            released.unwrap();
        }
    });
    began.1.recv().unwrap();
    hold.write(&a, &half).unwrap();
    hold.write(&b, b"b1").unwrap();
    hold.write(&a, b"a2").unwrap();
    assert_eq!(hold.held_len(), half.len() + 4);
    assert_eq!(fs::read(dir.join("a")).unwrap(), b"before");
    go.0.send(()).unwrap();
    let started = std::time::Instant::now();
    hold.write(&a, &half).unwrap();
    assert!(started.elapsed() >= Duration::from_millis(40));
    syncer.join().unwrap();
    assert_eq!(hold.held_len(), 0);
    let mut want = b"before".to_vec();
    want.extend_from_slice(&half);
    want.extend_from_slice(b"a2");
    want.extend_from_slice(&half);
    assert_eq!(fs::read(dir.join("a")).unwrap(), want);
    assert_eq!(fs::read(dir.join("b")).unwrap(), b"b1");
    let _ = fs::remove_dir_all(&dir);
}

/// Creating a keyed file syncs nothing on the appending thread (a
/// directory's sync takes milliseconds on macOS): the file is made and its
/// header written, held like any append while the I/O thread syncs. The
/// next mark syncs the directory, before `main.log`'s sync and the mark:
/// a mark on disk never covers an entry in a file whose name might not be.
#[test]
fn a_new_file_syncs_nothing_on_the_appending_thread() {
    let (mut log, dir) = new_log("new-file");
    log.append(&say(1, "a")).unwrap();
    mark(&mut log, 0);
    log.io().stall_syncs(true);
    log.mark(0).unwrap();
    wait_until("the stall", || log.io().stalled());
    // Entry 2, the file's first.
    log.append(&put(2, 0, "pawn")).unwrap();
    let keyed = dir.join("log/t.0.log");
    assert_eq!(len(&keyed), 0);
    assert!(log.hold().held_len() > HEADER_LEN, "the header wasn't held");
    log.io().stall_syncs(false);
    log.wait().unwrap();
    let counters = log.counters();
    assert_eq!((counters.files_created, counters.syncs_here), (1, 0));
    // The mark asked for while it was made didn't sync its directory; the
    // next one does, once, before main.log and the mark.
    mark(&mut log, 0);
    let trace = log.io().trace();
    let at = |step: &Step| trace.iter().position(|s| s == step).unwrap();
    let named = at(&Step::Dir(dir.join("log")));
    let marked = at(&Step::Mark(2));
    assert!(at(&Step::Pushed(keyed.clone())) < named, "{trace:?}");
    assert!(named < marked, "{trace:?}");
    assert!(
        trace[named..marked].contains(&Step::SyncedMain),
        "{trace:?}"
    );
    let dirs = trace.iter().filter(|s| matches!(s, Step::Dir(_))).count();
    assert_eq!(dirs, 1, "{trace:?}");
    assert_eq!(log.counters().syncs_here, 0);
    drop(log);
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(log.last_seq(), 2);
    drop(log);
    let _ = fs::remove_dir_all(&dir);
}

/// The background thread's durable syncs hold appends, as the I/O
/// thread's do: an append made during one is held, and written as it
/// returns. A clock mark asked for meanwhile waits for its turn, off the
/// appending thread, and covers the held append. The sync is a file's,
/// which every platform makes (Windows syncs no directory).
#[test]
fn a_background_sync_holds_appends_and_a_mark_waits_its_turn() {
    let (mut log, dir) = new_log("bg-hold");
    log.append(&say(1, "a")).unwrap();
    mark(&mut log, 0);
    assert_eq!(log.counters().background_syncs, 0);
    log.hold().stall_background(true);
    let (tx, rx) = mpsc::channel();
    let synced = dir.with_extension("synced");
    fs::write(&synced, b"synced").unwrap();
    log.background()
        .run({
            let synced = synced.clone();
            move || {
                assert!(durable::holds_appends_here());
                let file = crate::open_to_sync(&synced);
                tx.send(file.and_then(|f| durable::full(&f, &synced)))
                    .unwrap();
            }
        })
        .unwrap();
    wait_until("the background stall", || log.hold().background_stalled());
    let main = dir.join("log/main.log");
    let before = fs::read(&main).unwrap();
    log.append(&say(2, "held")).unwrap();
    log.mark(0).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    assert!(log.hold().held_len() > 0, "nothing was held");
    assert_eq!(fs::read(&main).unwrap(), before);
    assert!(log.marks_pending(), "the mark didn't wait its turn");
    log.hold().stall_background(false);
    rx.recv().unwrap().unwrap();
    log.wait().unwrap();
    assert_eq!(log.hold().held_len(), 0);
    let counters = log.counters();
    assert_eq!((counters.background_syncs, counters.syncs_here), (1, 0));
    drop(log);
    assert_eq!(marks(&dir), [(0, 1), (0, 2)]);
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(log.last_seq(), 2);
    drop(log);
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_file(&synced);
}

/// A held append that can't be written when a sync returns is a failed
/// sync, whichever thread held it: the store saves nothing more.
#[test]
fn a_held_append_that_cannot_be_written_fails_the_hold() {
    let dir = temp("held-fails");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("read-only");
    fs::write(&path, b"").unwrap();
    // Writes through a read-only handle fail.
    let file = Arc::new(fs::File::open(&path).unwrap());
    let hold = Hold::new();
    assert!(hold.failed().is_none());
    let (held, released) = hold.during(|| hold.write(&file, b"held"));
    held.unwrap();
    assert!(released.is_err());
    assert!(hold.failed().is_some());
    let _ = fs::remove_dir_all(&dir);
}
