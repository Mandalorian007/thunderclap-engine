//! Repair, rollback, the archive, online backup, the tail reader and the
//! memory store.

use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;
use crate::{
    ArchivePolicy, Log, LogReader, MemoryLog, Output, RECOVERED_DIR, RollbackTo, Store, StoreError,
    backup, check, gen_dir, prepare, read, repair, rollback, summary, tidy,
};

/// Entries 1 to 5 in `dir`, the fifth in `t.0.log`.
fn five(label: &str, fifth: LogEntry<Ev>) -> PathBuf {
    let (mut log, dir) = new_log(label);
    for s in 1..5 {
        log.append(&say(s, "a")).unwrap();
    }
    log.append(&fifth).unwrap();
    drop(log);
    dir
}

/// Two writers both wrote entry 5: opening refuses, `check` changes
/// nothing and says why, and a repair keeps the entries before it (which
/// copy is the game's can't be known).
#[test]
fn a_double_written_store_is_checked_and_repaired() {
    let dir = five("double", put(5, 0, "pawn"));
    let other = five("double-other", say(5, "b"));
    fs::copy(other.join("log/main.log"), dir.join("log/main.log")).unwrap();
    let main_before = fs::read(dir.join("log/main.log")).unwrap();

    let err = Log::open(&dir, Tables).err().expect("refuses to open");
    assert!(err.to_string().contains("twice"), "{err}");
    let report = check(&dir, &Tables).unwrap();
    assert!(!report.is_clean());
    assert!(report.open.is_err());
    assert_eq!((report.salvage.keep, report.salvage.found), (4, 5));
    assert!(
        report
            .salvage
            .reasons
            .iter()
            .any(|r| r.contains("entry 5 appears 2 times")),
        "{:?}",
        report.salvage.reasons
    );
    assert_eq!(fs::read(dir.join("log/main.log")).unwrap(), main_before);

    let out = temp("double-out");
    let repaired = repair(&dir, &Tables, Output::Copy(&out)).unwrap();
    assert_eq!((repaired.salvage.keep, repaired.moved), (4, None));
    let (log, opened) = Log::open(&out, Tables).unwrap();
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries.len(), 4);
    assert_eq!(log.last_seq(), 4);
    drop(log);
    assert!(check(&out, &Tables).unwrap().is_clean());
    // A repair never writes over a store.
    assert!(matches!(
        repair(&dir, &Tables, Output::Copy(&out)),
        Err(StoreError::Exists(_))
    ));
}

/// Damage in a batch's keyed file: a repair in place keeps the entries
/// before the batch and none of it, and moves the old log to
/// `recovered/`.
#[test]
fn repair_keeps_batches_whole() {
    let (mut log, dir) = new_log("repair-batch");
    for s in 1..4 {
        log.append(&say(s, "a")).unwrap();
    }
    mark(&mut log, 30);
    log.append_all(&[put(4, 0, "pawn"), put(5, 1, "rook"), say(6, "b")])
        .unwrap();
    mark(&mut log, 60);
    drop(log);
    // Entry 5's record, damaged in its middle.
    let t1 = dir.join("log/t.1.log");
    let mut bytes = fs::read(&t1).unwrap();
    let mid = format::HEADER_LEN + (bytes.len() - format::HEADER_LEN) / 2;
    bytes[mid] ^= 0xff;
    fs::write(&t1, &bytes).unwrap();

    let repaired = repair(&dir, &Tables, Output::InPlace).unwrap();
    assert_eq!(repaired.salvage.keep, 3, "{:?}", repaired.salvage);
    assert_eq!(repaired.salvage.clock, 30);
    let moved = repaired.moved.expect("in place");
    assert!(moved.starts_with(dir.join(RECOVERED_DIR)));
    assert!(moved.join("log/t.1.log").is_file());
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!((log.last_seq(), opened.clock), (3, 30));
    assert!(!dir.join(crate::SWAP_DIR).exists());
}

/// The brief's rollback: append, mark, append, roll back to the mark,
/// reopen: the state is the mark's.
#[test]
fn a_rollback_to_a_mark_reopens_at_the_mark() {
    let (mut log, dir) = new_log("rollback");
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 0, "pawn")).unwrap();
    log.append(&say(3, "b")).unwrap();
    mark(&mut log, 30);
    let at_mark = read(&dir, &Tables).unwrap().entries;
    log.append(&put(4, 0, "rook")).unwrap();
    log.append_all(&[say(5, "c"), put(6, 2, "king")]).unwrap();
    mark(&mut log, 60);
    // Not while it is open.
    assert!(rollback(&dir, &Tables, RollbackTo::Seq(3), Output::InPlace).is_err());
    drop(log);

    // Into a batch: back to just before it.
    let out = temp("rollback-copy");
    let copy = rollback(&dir, &Tables, RollbackTo::Seq(5), Output::Copy(&out)).unwrap();
    assert_eq!((copy.kept, copy.was, copy.clock), (4, 6, 30));
    let report = rollback(&dir, &Tables, RollbackTo::Time(35), Output::InPlace).unwrap();
    assert_eq!((report.kept, report.was, report.clock), (3, 6, 30));
    assert!(report.moved.is_some());
    let (mut log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries, at_mark);
    assert_eq!((log.last_seq(), opened.clock), (3, 30));
    assert_eq!(marks(&dir), [(30, 3)]);
    assert!(!dir.join("log/t.2.log").exists());
    // The log goes on from the mark.
    log.append(&say(4, "again")).unwrap();
    drop(log);
    assert_eq!(read(&dir, &Tables).unwrap().entries.len(), 4);
}

/// Backups taken while another thread appends (batches and marks) each
/// open with nothing to recover.
#[test]
fn a_backup_taken_while_appending_opens_cleanly() {
    let (mut log, dir) = new_log("backup");
    log.append(&say(1, "a")).unwrap();
    mark(&mut log, 1);
    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut seq = 1;
            while !stop.load(Ordering::Relaxed) || seq < 200 {
                let t = (seq % 5) as u32;
                log.append_all(&[put(seq + 1, t, "pawn"), say(seq + 2, "b")])
                    .unwrap();
                seq += 2;
                if seq % 10 == 1 {
                    log.mark(seq).unwrap();
                }
            }
            log.wait().unwrap();
            seq
        })
    };
    let mut last = 0;
    for n in 0..5 {
        let out = temp(&format!("backup-{n}"));
        let report = backup(&dir, &out, false).unwrap();
        assert!(report.last_seq >= last);
        last = report.last_seq;
        let checked = check(&out, &Tables).unwrap();
        assert!(
            checked.is_clean(),
            "{:?} {:?}",
            checked.open,
            checked.salvage
        );
        let (copy, opened) = Log::open(&out, Tables).unwrap();
        assert_eq!(copy.last_seq(), report.last_seq);
        assert_eq!(opened.entries.len() as u64, report.last_seq);
    }
    stop.store(true, Ordering::Relaxed);
    let written = writer.join().unwrap();
    let out = temp("backup-last");
    assert_eq!(backup(&dir, &out, true).unwrap().last_seq, written);
}

/// A store rotated to generation 1, generation 0 archived: it opens from
/// generation 1 (and says why not from 0), a backup copies the archive, a
/// rollback reaches into it, and pruning keeps the archive small.
#[test]
fn the_archive_takes_old_generations_and_a_rollback_reaches_them() {
    let (mut log, dir) = new_log("archive");
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 0, "pawn")).unwrap();
    log.append(&say(3, "b")).unwrap();
    mark(&mut log, 30);
    let (next, keys) = log.to_prepare();
    log.rotate(prepare(&dir, &Tables, next, &keys).unwrap(), 30)
        .unwrap();
    log.append(&put(4, 0, "rook")).unwrap();
    log.append(&say(5, "c")).unwrap();
    mark(&mut log, 50);
    log.sync_frozen().unwrap();
    log.note_base(1);
    let policy = ArchivePolicy::default();
    let tidied = tidy(&dir, &Tables, 1, &policy).unwrap();
    assert_eq!(tidied.archived, [0]);
    assert!(tidied.pruned.is_empty());
    assert!(!dir.join("log/main.log").exists());
    assert!(gen_dir(&dir, 1).join("main.log").is_file());
    let archived = summary(&dir).unwrap();
    assert_eq!(archived.len(), 1);
    assert_eq!(
        (archived[0].generation, archived[0].entries),
        (0, Some((1, 3)))
    );
    // Running it again changes nothing.
    assert!(tidy(&dir, &Tables, 1, &policy).unwrap().archived.is_empty());
    drop(log);

    let err = Log::open(&dir, Tables)
        .err()
        .expect("generation 0 is archived");
    assert!(err.to_string().contains("archived"), "{err}");
    let (log, opened) = Log::open_from(&dir, Tables, 1, 3).unwrap();
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries.len(), 2);
    drop(log);
    assert!(check(&dir, &Tables).unwrap().is_clean());

    let out = temp("archive-backup");
    let copied = backup(&dir, &out, true).unwrap();
    assert_eq!((copied.last_seq, copied.archive_files), (5, 3));
    assert_eq!(summary(&out).unwrap(), archived);

    // Back into generation 0: the archive is read, and moved aside.
    let report = rollback(&dir, &Tables, RollbackTo::Seq(2), Output::InPlace).unwrap();
    assert_eq!((report.kept, report.clock), (2, 0));
    let moved = report.moved.unwrap();
    assert!(moved.join("archive/g0/info").is_file());
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries, [say(1, "a"), put(2, 0, "pawn")]);
    drop(log);

    // The backup's archive, pruned by size: the log then starts later.
    let tight = ArchivePolicy {
        keep_days: 7,
        max_bytes: 0,
    };
    let pruned = tidy(&out, &Tables, 1, &tight).unwrap();
    assert_eq!(pruned.pruned, [0]);
    assert!(summary(&out).unwrap().is_empty());
    let checked = check(&out, &Tables).unwrap();
    assert!(checked.is_clean(), "{:?}", checked.salvage);
    assert_eq!((checked.salvage.after, checked.salvage.keep), (3, 5));
    assert!(matches!(
        rollback(&out, &Tables, RollbackTo::Seq(2), Output::InPlace),
        Err(StoreError::Sequence(_))
    ));
}

/// The tail reader reads each cut's new entries, across a rotation.
#[test]
fn the_tail_reader_follows_the_log() {
    let (mut log, dir) = new_log("tail");
    let mut reader = LogReader::after(&dir, 0);
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 3, "pawn")).unwrap();
    mark(&mut log, 20);
    let got = reader.read_to(&log.cut(20), &Tables).unwrap();
    assert_eq!(got, [say(1, "a"), put(2, 3, "pawn")]);
    assert_eq!(
        reader.last_mark().map(|m| (m.time, m.covers)),
        Some((20, 2))
    );
    // Nothing new: nothing read.
    assert!(reader.read_to(&log.cut(20), &Tables).unwrap().is_empty());
    log.append_all(&[put(3, 3, "rook"), say(4, "b")]).unwrap();
    let (next, keys) = log.to_prepare();
    log.rotate(prepare(&dir, &Tables, next, &keys).unwrap(), 40)
        .unwrap();
    log.append(&put(5, 3, "king")).unwrap();
    let got = reader.read_to(&log.cut(50), &Tables).unwrap();
    let seqs: Vec<u64> = got.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, [3, 4, 5]);
    assert_eq!(reader.last_seq(), 5);
    // A reader from a base in generation 1.
    let mut late = LogReader::after(&dir, 4);
    let got = late
        .read_to(&log.cut(50).since_generation(1), &Tables)
        .unwrap();
    assert_eq!(got, [put(5, 3, "king")]);
    // A reader that missed entries says so.
    let mut wrong = LogReader::after(&dir, 2);
    assert!(
        wrong
            .read_to(&log.cut(50).since_generation(1), &Tables)
            .is_err()
    );
}

/// The memory store: appends all or none and in order, marks, reading
/// back, and a rollback that keeps batches whole.
#[test]
fn the_memory_store_appends_marks_and_rolls_back() {
    let mut store = Store::memory(Tables);
    assert!(store.is_memory());
    store.append(&say(1, "a")).unwrap();
    store.append(&put(2, 0, "pawn")).unwrap();
    store.mark(20).unwrap();
    store.wait().unwrap();
    assert!(matches!(
        store.append(&say(4, "x")),
        Err(StoreError::Sequence(_))
    ));
    let unencodable = LogEntry {
        seq: 4,
        time: 40,
        event: Ev::Unencodable,
    };
    assert!(store.append_all(&[say(3, "b"), unencodable]).is_err());
    assert_eq!(store.last_seq(), 2);
    store
        .append_all(&[put(3, 0, "rook"), put(4, 1, "king"), say(5, "c")])
        .unwrap();
    store.mark(50).unwrap();
    let log: &mut MemoryLog<Tables> = store.as_memory().unwrap();
    assert_eq!(log.entries().unwrap().len(), 5);
    assert_eq!(
        log.marks()
            .unwrap()
            .iter()
            .map(|m| (m.0, m.1))
            .collect::<Vec<_>>(),
        [(20, 2), (50, 5)]
    );
    assert_eq!(log.clock(), 50);
    assert_eq!(log.rollback_to(4).unwrap(), 2);
    assert_eq!(log.clock(), 20);
    assert_eq!(log.entries().unwrap(), [say(1, "a"), put(2, 0, "pawn")]);
    // Names written again after the rollback read back.
    log.append(&put(3, 0, "pawn")).unwrap();
    assert_eq!(log.entries().unwrap()[2], put(3, 0, "pawn"));
}
