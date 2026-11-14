//! The archive's age limit and a rollback by wall time, with the store's
//! clock set by hand (a process of their own: the clock is process-wide).

use std::convert::Infallible;
use std::fs;

use tc_store::{
    ArchivePolicy, Log, LogCodec, LogEntry, NameTable, Names, Output, RollbackTo, backup, bases,
    prepare, rollback, set_clock_for_tests, summary, tidy, write_base,
};

const DAY: u64 = 24 * 60 * 60;

/// Notes, all in `main.log`.
struct Notes;

impl LogCodec for Notes {
    type Event = String;
    type Key = Infallible;

    fn key(&self, _: &String) -> Option<Infallible> {
        None
    }
    fn file_name(&self, key: &Infallible) -> String {
        match *key {}
    }
    fn parse_file_name(&self, _: &str) -> Option<Infallible> {
        None
    }
    fn encode(&self, note: &String, _: &mut Names<'_>, out: &mut Vec<u8>) -> Result<(), String> {
        out.extend_from_slice(note.as_bytes());
        Ok(())
    }
    fn decode(&self, bytes: &[u8], _: &NameTable) -> Result<String, String> {
        String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
    }
}

fn note(seq: u64) -> LogEntry<String> {
    LogEntry {
        seq,
        time: seq,
        event: format!("note {seq}"),
    }
}

/// Generation `n` holds entries `2n + 1` and `2n + 2` and a mark asked
/// for on day `n`; generations 0 to 2 are archived, the archive keeps a
/// week, and a rollback in place goes back to day 1's mark.
#[test]
fn the_archive_keeps_a_week_and_a_rollback_goes_back_to_a_wall_time() {
    let dir = std::env::temp_dir().join(format!("tc-store-retention-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let start = 2_000_000_000;
    let mut log = Log::create(&dir, Notes, b"notes").unwrap();
    for n in 0..4u64 {
        set_clock_for_tests(Some(start + n * DAY));
        if n > 0 {
            let (next, keys) = log.to_prepare();
            log.rotate(prepare(&dir, &Notes, next, &keys).unwrap(), 2 * n)
                .unwrap();
        }
        log.append(&note(2 * n + 1)).unwrap();
        log.append(&note(2 * n + 2)).unwrap();
        log.mark(2 * n + 2).unwrap();
        log.wait().unwrap();
    }
    log.sync_frozen().unwrap();
    // The game's base through entry 6, whose tail starts in generation 3.
    write_base(&dir, 3, 6, b"state").unwrap();
    log.note_base(3);
    let week = ArchivePolicy::default();
    let tidied = tidy(&dir, &Notes, 3, &week).unwrap();
    assert_eq!((tidied.archived, tidied.pruned), (vec![0, 1, 2], vec![]));
    let walls: Vec<u64> = summary(&dir).unwrap().iter().map(|a| a.wall).collect();
    assert_eq!(walls, [start, start + DAY, start + 2 * DAY]);
    // A backup copies the base with the log after it.
    let out = dir.with_extension("backup");
    let _ = fs::remove_dir_all(&out);
    let copied = backup(&dir, &out, false).unwrap();
    assert_eq!((copied.bases, copied.last_seq), (1, 8));
    assert_eq!(fs::read(out.join("base/g3-6.base")).unwrap(), b"state");
    let (_, opened) = Log::open_from(&out, Notes, 3, 6).unwrap();
    assert_eq!(opened.entries, (7..=8).map(note).collect::<Vec<_>>());
    let _ = fs::remove_dir_all(&out);
    drop(log);

    // Back to what day 1's mark covered: entry 4, in generation 1.
    set_clock_for_tests(Some(start + 3 * DAY));
    let report = rollback(
        &dir,
        &Notes,
        RollbackTo::Wall(start + DAY + 60),
        Output::InPlace,
    )
    .unwrap();
    assert_eq!((report.kept, report.was, report.clock), (4, 8, 4));
    let moved = report.moved.unwrap();
    assert!(moved.join("archive/g2/info").is_file());
    // The base went with the old log: it is past the rolled-back point.
    assert!(moved.join("base/g3-6.base").is_file());
    assert!(bases(&dir).unwrap().is_empty());
    // Generation 0 is in the new log again: it opens from the start.
    let (log, opened) = Log::open(&dir, Notes).unwrap();
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries, (1..=4).map(note).collect::<Vec<_>>());
    assert_eq!(log.generation(), 1);
    drop(log);

    // Archived again. `recovered/` is aged by its files' times, real
    // ones, long before this test's clock (2033): the old log goes.
    let tidied = tidy(&dir, &Notes, 1, &week).unwrap();
    assert_eq!(tidied.archived, [0]);
    assert_eq!(tidied.recovered_pruned.len(), 1);
    assert_eq!(fs::read_dir(dir.join("recovered")).unwrap().count(), 0);
    // A week after day 0's mark, its generation goes.
    set_clock_for_tests(Some(start + 7 * DAY - 60));
    assert!(tidy(&dir, &Notes, 1, &week).unwrap().pruned.is_empty());
    set_clock_for_tests(Some(start + 7 * DAY + 60));
    assert_eq!(tidy(&dir, &Notes, 1, &week).unwrap().pruned, [0]);
    assert!(summary(&dir).unwrap().is_empty());
    set_clock_for_tests(None);
    let _ = fs::remove_dir_all(&dir);
}
