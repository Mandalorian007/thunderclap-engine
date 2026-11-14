//! Appending: keyed files opened on demand, batches all or none, the
//! record limit, file names, creating and locking a store.

use std::fs;

use super::*;
use crate::format::{HEADER_LEN, KIND_BATCH, KIND_ENTRY, KIND_NAME, MAX_PAYLOAD};
use crate::{Log, MAX_OPEN_FILES, StoreError, read};

/// Keyed files are opened as they are written, at most
/// [`MAX_OPEN_FILES`] at once; closing one to make room syncs nothing,
/// and a mark syncs every file written since the last.
#[test]
fn keyed_files_are_opened_on_demand_and_synced_only_when_written() {
    let (mut log, dir) = new_log("lru");
    let tables = MAX_OPEN_FILES as u32 + 36;
    for t in 0..tables {
        log.append(&put(t as u64 + 1, t, "pawn")).unwrap();
        assert!(log.keyed_handles().0 <= MAX_OPEN_FILES);
    }
    assert_eq!(log.keyed_handles(), (MAX_OPEN_FILES, tables as usize));
    mark(&mut log, 1);
    assert_eq!(log.keyed_handles(), (MAX_OPEN_FILES, 0));
    // An open file and a closed one: only those two need a sync.
    let mut seq = tables as u64;
    for t in [tables - 1, 0] {
        seq += 1;
        log.append(&put(seq, t, "rook")).unwrap();
    }
    assert_eq!(log.keyed_handles(), (MAX_OPEN_FILES, 2));
    drop(log);

    let (mut log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries.len() as u64, seq);
    assert_eq!(opened.entries[0], put(1, 0, "pawn"));
    assert_eq!(log.keyed_handles(), (0, 0));
    log.append(&put(seq + 1, 2, "pawn")).unwrap();
    assert_eq!(log.keyed_handles(), (1, 1));
    drop(log);
    let (_, opened) = open(&dir);
    assert_eq!(opened.entries.last(), Some(&put(seq + 1, 2, "pawn")));
    let _ = fs::remove_dir_all(&dir);
}

/// A batch whose second entry can't be written leaves no trace of the
/// first: its file is cut back and its name table restored, and the log
/// carries on.
#[test]
fn append_all_writes_all_or_none() {
    let (mut log, dir) = new_log("all-or-none");
    log.append(&put(1, 0, "pawn")).unwrap();
    log.append(&put(2, 1, "pawn")).unwrap();
    let near = dir.join("log/t.0.log");
    let far = dir.join("log/t.1.log");
    log.close_keyed(&1);
    set_writable(&far, false);

    let before = len(&near);
    let names = log.keyed_names(&0);
    // A new name in the near file, then the far file can't be opened.
    let batch = [put(3, 0, "queen"), put(4, 1, "king")];
    assert!(log.append_all(&batch).is_err());
    assert_eq!(len(&near), before, "cut back");
    assert_eq!(log.keyed_names(&0), names);
    assert!(!log.is_poisoned());
    assert_eq!(log.last_seq(), 2);

    // Writable again, the same batch goes in whole, names and all.
    set_writable(&far, true);
    log.append_all(&batch).unwrap();
    drop(log);
    let loaded = read(&dir, &Tables).unwrap();
    assert!(loaded.report.is_clean(), "{:?}", loaded.report);
    assert_eq!(loaded.entries.len(), 4);
    assert_eq!(loaded.entries[2..], batch);
    let _ = fs::remove_dir_all(&dir);
}

/// The records of `file` in generation 0, but names, with each batch
/// record's range.
fn kinds(dir: &Path, file: &str) -> Vec<(u8, Option<(u64, u64)>)> {
    let bytes = fs::read(dir.join("log").join(file)).unwrap();
    format::scan(&bytes)
        .unwrap()
        .records
        .iter()
        .filter(|r| r.kind != KIND_NAME)
        .map(|r| {
            let batch = (r.kind == KIND_BATCH).then(|| format::decode_batch(r.payload).unwrap());
            (r.kind, batch)
        })
        .collect()
}

/// Several entries appended together get a batch record in every file
/// they go to, before their first entry there.
#[test]
fn a_batch_is_recorded_in_every_file_it_writes() {
    let (mut log, dir) = new_log("batch-records");
    // Entries 1 and 3 (and later 4) in t.0, 2 in t.1.
    let batch = [put(1, 0, "a"), put(2, 1, "b"), put(3, 0, "c")];
    log.append_all(&batch).unwrap();
    log.append(&put(4, 0, "a")).unwrap();
    drop(log);
    let b = Some((1, 3));
    assert_eq!(
        kinds(&dir, "t.0.log"),
        [
            (KIND_BATCH, b),
            (KIND_ENTRY, None),
            (KIND_ENTRY, None),
            (KIND_ENTRY, None)
        ]
    );
    assert_eq!(
        kinds(&dir, "t.1.log"),
        [(KIND_BATCH, b), (KIND_ENTRY, None)]
    );
    let loaded = read(&dir, &Tables).unwrap();
    assert!(loaded.report.is_clean());
    assert_eq!(loaded.entries.len(), 4);
    let _ = fs::remove_dir_all(&dir);
}

/// A batch cut short in one file (a torn write, or a crash between the
/// files) is dropped whole: the entries that reached the other file go
/// too, and so do the batch records. Recovery saves what it cuts.
#[test]
fn a_torn_batch_is_dropped_whole() {
    let (mut log, dir) = new_log("torn-batch");
    let near = dir.join("log/t.0.log");
    let far = dir.join("log/t.1.log");
    log.append(&put(1, 0, "a")).unwrap();
    let near_before = len(&near);
    log.append_all(&[put(2, 0, "b"), put(3, 1, "c"), put(4, 0, "d")])
        .unwrap();
    let far_full = len(&far);
    drop(log);
    let original: Vec<Vec<u8>> = [&near, &far].iter().map(|p| fs::read(p).unwrap()).collect();

    // Entry 4 (in the near file) is torn mid-record; or the far file
    // lost entry 3 whole (its batch record survived, or didn't).
    for (case, (path, cut)) in [
        (&near, original[0].len() as u64 - 3),
        (&far, far_full - 20),
        (&far, HEADER_LEN as u64),
    ]
    .into_iter()
    .enumerate()
    {
        for (p, bytes) in [&near, &far].iter().zip(&original) {
            fs::write(p, bytes).unwrap();
        }
        set_len(path, cut);
        let (log, opened) = open(&dir);
        let report = opened.report;
        assert_eq!(log.last_seq(), 1, "case {case}: {report:?}");
        assert_eq!(report.partial_batch, Some((2, 4)), "case {case}");
        assert!(report.dropped.contains(&2), "case {case}: {report:?}");
        assert_eq!(len(&near), near_before, "case {case}");
        for cut in &report.truncated {
            let saved = fs::read(cut.saved.as_ref().unwrap()).unwrap();
            assert_eq!(saved.len() as u64, cut.from - cut.to, "case {case}");
        }
        drop(log);
        let (log, opened) = open(&dir);
        assert!(opened.report.is_clean(), "case {case}: {:?}", opened.report);
        assert_eq!(log.last_seq(), 1);
    }
    let _ = fs::remove_dir_all(&dir);
}

/// An entry too large for a record, or one the codec can't encode, is
/// refused before anything is written.
#[test]
fn an_entry_over_the_record_limit_or_unencodable_is_refused() {
    let (mut log, dir) = new_log("too-large");
    let main = dir.join("log/main.log");
    let before = fs::read(&main).unwrap();
    let big = LogEntry {
        seq: 1,
        time: 0,
        event: Ev::Blob {
            table: None,
            bytes: vec![7; MAX_PAYLOAD],
        },
    };
    match log.append(&big) {
        Err(StoreError::RecordTooLarge { seq, len, max }) => {
            assert_eq!((seq, max), (1, MAX_PAYLOAD));
            assert!(len > max);
        }
        other => panic!("expected RecordTooLarge, got {other:?}"),
    }
    let bad = LogEntry {
        seq: 1,
        time: 0,
        event: Ev::Unencodable,
    };
    assert!(matches!(
        log.append(&bad),
        Err(StoreError::Encode { seq: 1, .. })
    ));
    assert!(!log.is_poisoned());
    assert_eq!(log.last_seq(), 0);
    assert_eq!(fs::read(&main).unwrap(), before);
    log.append(&say(1, "fits")).unwrap();
    let _ = fs::remove_dir_all(&dir);
}

/// Appends follow on from the last entry without gaps.
#[test]
fn an_entry_out_of_sequence_is_refused() {
    let (mut log, dir) = new_log("out-of-sequence");
    assert!(matches!(
        log.append(&say(2, "early")),
        Err(StoreError::Sequence(_))
    ));
    assert!(matches!(
        log.append_all(&[say(1, "a"), say(3, "c")]),
        Err(StoreError::Sequence(_))
    ));
    assert_eq!(log.last_seq(), 0);
    log.append_all(&[say(1, "a"), say(2, "b")]).unwrap();
    assert!(matches!(
        log.append(&say(2, "again")),
        Err(StoreError::Sequence(_))
    ));
    let _ = fs::remove_dir_all(&dir);
}

/// A codec whose file name for every key is a fixed string, which never
/// reads back.
struct FixedName(&'static str);

impl LogCodec for FixedName {
    type Event = Ev;
    type Key = u32;
    fn key(&self, event: &Ev) -> Option<u32> {
        Tables.key(event)
    }
    fn file_name(&self, _: &u32) -> String {
        self.0.to_string()
    }
    fn parse_file_name(&self, _: &str) -> Option<u32> {
        None
    }
    fn encode(&self, event: &Ev, names: &mut Names<'_>, out: &mut Vec<u8>) -> Result<(), String> {
        Tables.encode(event, names, out)
    }
    fn decode(&self, bytes: &[u8], names: &NameTable) -> Result<Ev, String> {
        Tables.decode(bytes, names)
    }
}

/// The codec's file names read back as their keys; the store refuses one
/// that is the main log's, hidden, in another directory or not a log, and
/// opening refuses a file in the log directory that isn't its.
#[test]
fn file_names() {
    for key in [0, 7, u32::MAX] {
        assert_eq!(Tables.parse_file_name(&Tables.file_name(&key)), Some(key));
    }
    for bad in ["t.log", "t.01.log", "t.1.2.log", "t.a.log", "t.1.log.tmp"] {
        assert_eq!(Tables.parse_file_name(bad), None, "{bad}");
    }
    for (name, why) in [
        ("t.0.txt", "doesn't end in .log"),
        ("main.log", "is the main log's"),
        (".t.0.log", "starts with a dot"),
        ("a/t.0.log", "holds a path separator"),
        ("u.0.log", "doesn't read back"),
    ] {
        let dir = temp("bad-name");
        let mut log = Log::create(&dir, FixedName(name), b"").unwrap();
        match log.append(&put(1, 0, "a")) {
            Err(StoreError::Sequence(reason)) => assert!(reason.contains(why), "{reason}"),
            other => panic!("{name}: expected a sequence error, got {other:?}"),
        }
        drop(log);
        let _ = fs::remove_dir_all(&dir);
    }

    let (log, dir) = new_log("stray");
    drop(log);
    fs::write(dir.join("log/stray.log"), b"").unwrap();
    assert!(matches!(
        Log::open(&dir, Tables),
        Err(StoreError::Meta { .. })
    ));
    let _ = fs::remove_dir_all(&dir);
}

/// An OS crash before the next mark can lose a new keyed file's name,
/// entries and all, while a later entry in `main.log` survives: opening
/// counts the gap as lost writes (no mark covers it) and resumes before
/// it.
#[test]
fn a_new_file_lost_with_its_name_is_lost_writes() {
    let (mut log, dir) = new_log("lost-name");
    log.append(&say(1, "hello")).unwrap();
    mark(&mut log, 10);
    // Entry 2 in a new keyed file, entry 3 in main.log, and no mark.
    log.append(&put(2, 0, "pawn")).unwrap();
    log.append(&say(3, "bye")).unwrap();
    drop(log);
    fs::remove_file(dir.join("log/t.0.log")).unwrap();

    let (log, opened) = open(&dir);
    let report = opened.report;
    assert_eq!((report.missing, report.dropped), (Some(2), vec![3]));
    assert_eq!(log.last_seq(), 1);
    assert_eq!(opened.clock, 10);
    drop(log);
    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(log.last_seq(), 1);
    drop(log);
    let _ = fs::remove_dir_all(&dir);
}

/// A store is created once, holds the game's metadata, and is held by one
/// log at a time; a creation cut short before its metadata is created
/// over.
#[test]
fn creating_and_locking_a_store() {
    let (log, dir) = new_log("create");
    assert!(matches!(
        Log::create(&dir, Tables, b"again"),
        Err(StoreError::Exists(_))
    ));
    assert!(matches!(
        Log::open(&dir, Tables),
        Err(StoreError::InUse { .. })
    ));
    drop(log);
    let (log, opened) = open(&dir);
    assert_eq!(opened.meta, b"meta");
    assert!(opened.entries.is_empty() && opened.report.is_clean());
    drop(log);

    // Cut short: an empty main.log and no store.meta.
    fs::remove_file(dir.join(crate::META_FILE)).unwrap();
    fs::write(dir.join("log/main.log"), b"").unwrap();
    assert!(matches!(
        Log::open(&dir, Tables),
        Err(StoreError::Meta { .. })
    ));
    let mut log = Log::create(&dir, Tables, b"new").unwrap();
    log.append(&say(1, "hi")).unwrap();
    drop(log);
    let (_, opened) = open(&dir);
    assert_eq!(
        (opened.meta.as_slice(), opened.entries.len()),
        (&b"new"[..], 1)
    );

    // A directory with entries in it is never created over.
    fs::remove_file(dir.join(crate::META_FILE)).unwrap();
    assert!(Log::create(&dir, Tables, b"over").is_err());
    let _ = fs::remove_dir_all(&dir);
}
