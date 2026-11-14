//! Clock marks: what a mark covers, a mark written again after a lost
//! tail, and failed syncs holding marks and writes back.

use std::fs;

use super::*;
use crate::{Log, StoreError, read};

#[test]
fn a_mark_names_the_last_entry_before_it_was_asked_for() {
    let (mut log, dir) = new_log("mark-covers");
    log.append_all(&[say(1, "a"), put(2, 0, "pawn")]).unwrap();
    log.mark(40).unwrap();
    // Appended while the mark's files sync: not covered by it.
    log.append(&put(3, 0, "rook")).unwrap();
    log.wait().unwrap();
    assert!(!log.marks_pending());
    assert_eq!(marks(&dir), [(40, 2)]);
    // Nothing written since: the next marks sync nothing but themselves.
    log.mark(50).unwrap();
    log.mark(50).unwrap();
    drop(log);
    let all = marks(&dir);
    assert_eq!(all.first(), Some(&(40, 2)));
    // (A mark covering nothing new may be skipped.)
    assert!(!all[1..].is_empty(), "{all:?}");
    assert!(all[1..].iter().all(|m| *m == (50, 3)), "{all:?}");
    let (_, opened) = open(&dir);
    assert_eq!((opened.entries.len(), opened.clock), (3, 50));
    let _ = fs::remove_dir_all(&dir);
}

/// The I/O thread writes a mark after entries appended while it synced.
/// If an OS crash then loses one of those (it covers none of them), the
/// log resumes before it, and the mark, cut off with the entries after
/// the gap, is written again: the clock doesn't go back.
#[test]
fn a_mark_cut_off_by_a_lost_tail_is_written_again() {
    let (mut log, dir) = new_log("mark-restore");
    log.append(&put(1, 0, "pawn")).unwrap();
    log.append(&say(2, "a")).unwrap();
    let keyed = dir.join("log/t.0.log");
    let before = len(&keyed);
    // Entry 3 in the keyed file, entry 4 in main.log, then the mark asked
    // for after entry 2.
    log.append(&put(3, 0, "rook")).unwrap();
    log.append(&say(4, "b")).unwrap();
    write_mark(&log, 500, 2);
    drop(log);
    set_len(&keyed, before);

    // Reading changes nothing, and says what opening will keep.
    let main_before = fs::read(dir.join("log/main.log")).unwrap();
    let loaded = read(&dir, &Tables).unwrap();
    assert_eq!((loaded.entries.len(), loaded.clock), (2, 500));
    assert_eq!(fs::read(dir.join("log/main.log")).unwrap(), main_before);

    let (log, opened) = open(&dir);
    let report = opened.report;
    assert_eq!((report.missing, report.dropped), (Some(3), vec![4]));
    assert_eq!((log.last_seq(), opened.clock), (2, 500));
    drop(log);
    assert_eq!(marks(&dir), [(500, 2)]);
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!((log.last_seq(), opened.clock), (2, 500));
    drop(log);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_mark_covering_an_entry_that_is_not_there_is_an_error() {
    let (mut log, dir) = new_log("mark-ahead");
    log.append(&say(1, "a")).unwrap();
    write_mark(&log, 0, 2);
    drop(log);
    let before = fs::read(dir.join("log/main.log")).unwrap();
    match Log::open(&dir, Tables) {
        Err(StoreError::Sequence(reason)) => {
            assert!(reason.contains("entry 2 is missing"), "{reason}");
            assert!(reason.contains("clock mark"), "{reason}");
        }
        other => panic!("expected a sequence error, got {:?}", other.err()),
    }
    assert_eq!(fs::read(dir.join("log/main.log")).unwrap(), before);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn marks_never_cover_less_than_the_one_before() {
    let (mut log, dir) = new_log("mark-order");
    log.append_all(&[say(1, "a"), say(2, "b")]).unwrap();
    write_mark(&log, 0, 2);
    write_mark(&log, 0, 1);
    drop(log);
    assert!(matches!(
        Log::open(&dir, Tables),
        Err(StoreError::Corrupt { .. })
    ));
    let _ = fs::remove_dir_all(&dir);
}

/// A file that can't be synced holds the mark back; the error comes with
/// the next call, and the next mark syncs the file again.
#[test]
fn a_failed_sync_writes_no_mark_and_is_retried() {
    let (mut log, dir) = new_log("mark-fail");
    log.append(&put(1, 1, "pawn")).unwrap();
    log.close_keyed(&1);
    let path = dir.join("log/t.1.log");
    let aside = dir.join("t.1.log.aside");
    fs::rename(&path, &aside).unwrap();

    // Reported by the call itself if the thread already failed it.
    let failed = log.mark(0).and_then(|()| log.wait());
    assert!(matches!(failed, Err(StoreError::Io { .. })), "{failed:?}");
    assert!(marks(&dir).is_empty());
    log.wait().unwrap();
    // Until a mark succeeds, nothing more is written: it might never
    // become durable.
    assert!(matches!(log.blocked(), Some(StoreError::NotDurable(_))));
    assert!(matches!(
        log.append(&say(2, "refused")),
        Err(StoreError::NotDurable(_))
    ));

    fs::rename(&aside, &path).unwrap();
    mark(&mut log, 0);
    assert_eq!(marks(&dir), [(0, 1)]);
    assert!(log.blocked().is_none());
    log.append(&say(2, "saved")).unwrap();
    drop(log);
    let _ = fs::remove_dir_all(&dir);
}

/// A sync that fails may have lost what it was to make durable, and a
/// retry could falsely succeed: the store refuses writes and marks for
/// good. A restart reads what reached the disk.
#[test]
fn a_failed_sync_stops_every_write_until_a_restart() {
    let (mut log, dir) = new_log("sync-fail");
    log.append(&say(1, "a")).unwrap();
    mark(&mut log, 0);
    log.append(&put(2, 0, "pawn")).unwrap();
    log.fail_syncs(true);
    let failed = log.mark(0).and_then(|()| log.wait());
    assert!(matches!(failed, Err(StoreError::Io { .. })), "{failed:?}");
    let refused = log.append(&say(3, "refused"));
    assert!(
        matches!(refused, Err(StoreError::NotDurable(_))),
        "{refused:?}"
    );
    // The disk "recovers", but nothing is trusted again.
    log.fail_syncs(false);
    let again = log.mark(0).and_then(|()| log.wait());
    assert!(matches!(again, Err(StoreError::NotDurable(_))), "{again:?}");
    let blocked = log.blocked().unwrap().to_string();
    assert!(blocked.contains("until a restart"), "{blocked}");
    assert_eq!(marks(&dir), [(0, 1)]);
    drop(log);
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(log.last_seq(), 2);
    drop(log);
    let _ = fs::remove_dir_all(&dir);
}
