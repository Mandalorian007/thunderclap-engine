//! Crash recovery: a torn tail is dropped and kept in `recovered/`, a
//! mark survives, and damage a crash can't explain changes nothing.

use std::fs;

use super::*;
use crate::{Log, RECOVERED_DIR, StoreError, read};

/// A crash tears `main.log`'s last record mid-frame: reopening drops the
/// torn entry, cuts the file back, saves the bytes it cut in
/// `recovered/`, and keeps the clock mark before it.
#[test]
fn a_tail_torn_mid_frame_is_dropped_and_a_mark_survives() {
    let (mut log, dir) = new_log("torn-tail");
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 0, "pawn")).unwrap();
    log.append(&say(3, "b")).unwrap();
    mark(&mut log, 30);
    log.append(&say(4, "c")).unwrap();
    let main = dir.join("log/main.log");
    let durable_len = len(&main);
    log.append(&say(5, "torn")).unwrap();
    drop(log);
    let full = fs::read(&main).unwrap();
    let torn = full.len() as u64 - 5;
    set_len(&main, torn);

    // Reading reports the cut, and changes nothing.
    let loaded = read(&dir, &Tables).unwrap();
    assert_eq!(loaded.entries.len(), 4);
    assert_eq!(loaded.report.truncated.len(), 1);
    assert_eq!(loaded.report.truncated[0].saved, None);
    assert_eq!(len(&main), torn);

    let (mut log, opened) = open(&dir);
    assert_eq!(log.last_seq(), 4);
    assert_eq!(opened.entries.last(), Some(&say(4, "c")));
    assert_eq!(opened.clock, 30);
    let cut = &opened.report.truncated[..];
    assert_eq!(cut.len(), 1, "{:?}", opened.report);
    assert_eq!(
        (cut[0].path.as_path(), cut[0].from, cut[0].to),
        (main.as_path(), torn, durable_len)
    );
    let saved = cut[0].saved.as_ref().unwrap();
    assert!(saved.starts_with(dir.join(RECOVERED_DIR)), "{saved:?}");
    assert_eq!(
        fs::read(saved).unwrap(),
        full[durable_len as usize..torn as usize]
    );
    assert_eq!(len(&main), durable_len);
    assert_eq!(marks(&dir), [(30, 3)]);

    // The log carries on from the cut.
    log.append(&say(5, "again")).unwrap();
    mark(&mut log, 50);
    drop(log);
    let (_, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries.last(), Some(&say(5, "again")));
    assert_eq!(opened.clock, 50);
    let _ = fs::remove_dir_all(&dir);
}

/// A keyed file's header torn by a crash right after it was made: the
/// file is made again, and nothing in it is lost that a mark covers.
#[test]
fn a_torn_header_is_written_again() {
    let (mut log, dir) = new_log("torn-header");
    log.append(&say(1, "a")).unwrap();
    mark(&mut log, 1);
    log.append(&put(2, 0, "pawn")).unwrap();
    drop(log);
    let keyed = dir.join("log/t.0.log");
    set_len(&keyed, 3);
    let (mut log, opened) = open(&dir);
    assert_eq!(log.last_seq(), 1);
    assert_eq!(opened.report.truncated.len(), 1, "{:?}", opened.report);
    assert_eq!(opened.report.truncated[0].to, 0);
    log.append(&put(2, 0, "rook")).unwrap();
    drop(log);
    let (_, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.entries.last(), Some(&put(2, 0, "rook")));
    let _ = fs::remove_dir_all(&dir);
}

/// Damage before a file's end isn't a crash's torn tail: opening fails
/// and changes nothing.
#[test]
fn damage_before_the_end_is_an_error_that_changes_nothing() {
    let (mut log, dir) = new_log("damage");
    log.append_all(&[say(1, "first"), say(2, "second"), say(3, "third")])
        .unwrap();
    mark(&mut log, 3);
    drop(log);
    let main = dir.join("log/main.log");
    let mut bytes = fs::read(&main).unwrap();
    // Inside the first entry's payload.
    let at = format::HEADER_LEN + 4 + 1 + 20;
    bytes[at] ^= 0xff;
    fs::write(&main, &bytes).unwrap();
    assert!(matches!(
        Log::open(&dir, Tables),
        Err(StoreError::Corrupt { .. })
    ));
    assert_eq!(fs::read(&main).unwrap(), bytes);
    assert!(!dir.join(RECOVERED_DIR).exists());
    let _ = fs::remove_dir_all(&dir);
}
