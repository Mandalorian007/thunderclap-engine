//! Log generations: a rotation, opening from a generation, and the one
//! durable sync a batch of new or frozen files takes.

use std::fs;

use super::*;
use crate::durable::{self, Synced};
use crate::{Log, StoreError, gen_dir, prepare, read, sync_frozen};

/// A store with entries in `main.log` and four keyed files, and a mark.
fn four_tables(label: &str) -> (Log<Tables>, PathBuf) {
    let (mut log, dir) = new_log(label);
    log.append(&say(1, "a")).unwrap();
    for t in 0..4 {
        log.append(&put(t as u64 + 2, t, "pawn")).unwrap();
    }
    mark(&mut log, 5);
    (log, dir)
}

/// The durable syncs in `trace`.
fn fulls(trace: &[Synced]) -> Vec<&Path> {
    trace
        .iter()
        .filter_map(|s| match s {
            Synced::Full(p) => Some(p.as_path()),
            Synced::Pushed(_) => None,
        })
        .collect()
}

/// A rotation starts generation 1: appends go to its files, generation
/// 0's are frozen, and opening merges both. Opening from generation 1
/// reads only its entries.
#[test]
fn a_rotation_starts_a_generation_and_opening_reads_every_one() {
    let (mut log, dir) = four_tables("rotate");
    let (next, keys) = log.to_prepare();
    assert_eq!((next, keys.as_slice()), (1, &[0, 1, 2, 3][..]));
    assert!(matches!(
        prepare(&dir, &Tables, 0, &[]),
        Err(StoreError::Sequence(_))
    ));
    assert!(matches!(
        log.rotate(prepare(&dir, &Tables, 2, &[]).unwrap(), 5),
        Err(StoreError::Sequence(_))
    ));
    fs::remove_dir_all(gen_dir(&dir, 2)).unwrap();
    let prepared = prepare(&dir, &Tables, next, &keys).unwrap();
    let cut = log.rotate(prepared, 6).unwrap();
    assert_eq!((cut.generation(), cut.last_seq(), cut.time()), (1, 5, 6));
    assert_eq!(cut.frozen_paths().count(), 5, "main.log and four tables");
    assert_eq!((log.generation(), log.has_entries()), (1, false));
    log.append(&put(6, 1, "rook")).unwrap();
    log.append(&say(7, "b")).unwrap();
    log.append(&put(8, 9, "king")).unwrap();
    mark(&mut log, 8);
    assert!(log.has_entries());
    log.sync_frozen().unwrap();
    log.note_base(1);
    assert_eq!(log.durable_below(), 1);
    assert!(log.cut(8).files().iter().all(|f| f.generation == 1));
    drop(log);
    let g1 = gen_dir(&dir, 1);
    assert!(g1.join("t.9.log").is_file());
    assert_eq!(marks_in(&g1.join("main.log")), [(8, 8)]);

    let (log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!((opened.entries.len(), opened.clock), (8, 8));
    assert_eq!(opened.entries[5], put(6, 1, "rook"));
    assert_eq!((log.generation(), log.last_seq()), (1, 8));
    drop(log);
    let (mut log, opened) = Log::open_from(&dir, Tables, 1, 5).unwrap();
    let seqs: Vec<u64> = opened.entries.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, [6, 7, 8]);
    assert_eq!(log.durable_below(), 1);
    log.append(&say(9, "c")).unwrap();
    drop(log);
    assert_eq!(read(&dir, &Tables).unwrap().entries.len(), 9);
    assert!(matches!(
        Log::open_from(&dir, Tables, 2, 8),
        Err(StoreError::Sequence(_))
    ));
    let _ = fs::remove_dir_all(&dir);
}

/// A generation prepared but never rotated to (a run cut short) is where
/// the next run appends; preparing it again uses its files.
#[test]
fn a_prepared_generation_never_rotated_to_is_used() {
    let (log, dir) = four_tables("prepared-only");
    drop(log);
    drop(prepare(&dir, &Tables, 1, &[0, 2]).unwrap());
    drop(prepare(&dir, &Tables, 1, &[0, 2]).unwrap());
    let (mut log, opened) = open(&dir);
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!((log.generation(), log.last_seq()), (1, 5));
    log.append(&put(6, 0, "rook")).unwrap();
    drop(log);
    let (_, opened) = open(&dir);
    assert_eq!(opened.entries.len(), 6);
    assert!(gen_dir(&dir, 1).join("t.0.log").is_file());
    let _ = fs::remove_dir_all(&dir);
}

/// A rotation's next generation and the frozen files under a base are
/// each pushed, and made durable by one durable sync however many files
/// (one cache flush on macOS), after every push. Unix only: Windows
/// syncs no directory, and each push there is durable on its own.
#[cfg(unix)]
#[test]
fn a_batch_of_files_is_pushed_and_made_durable_by_one_sync() {
    let (log, dir) = four_tables("one-sync");
    drop(log);
    let logs = dir.join("log");
    let (prepared, trace) = durable::traced(|| prepare(&dir, &Tables, 1, &[0, 1, 2, 3]));
    drop(prepared.unwrap());
    let g1 = gen_dir(&dir, 1);
    assert_eq!(fulls(&trace), [logs.as_path()], "{trace:?}");
    assert!(trace.contains(&Synced::Pushed(g1.clone())), "{trace:?}");
    assert_eq!(trace.len(), 5 + 1 + 1, "{trace:?}");
    fs::remove_dir_all(&g1).unwrap();

    let paths: Vec<PathBuf> = fs::read_dir(&logs)
        .unwrap()
        .map(|f| f.unwrap().path())
        .collect();
    assert_eq!(paths.len(), 5, "main.log and four tables");
    let (synced, trace) = durable::traced(|| sync_frozen(&dir, paths.iter().map(|p| p.as_path())));
    synced.unwrap();
    assert_eq!(fulls(&trace), [logs.as_path()], "{trace:?}");
    assert_eq!(trace.len(), 5 + 1, "{trace:?}");
    let _ = fs::remove_dir_all(&dir);
}

/// On Windows a batch's files are each pushed, durable on its own
/// (`FlushFileBuffers`), and no directory is synced: NTFS journals its
/// names itself.
#[cfg(not(unix))]
#[test]
fn on_windows_a_batch_of_files_is_pushed_file_by_file() {
    let (log, dir) = four_tables("one-sync");
    drop(log);
    let pushed = |trace: &[Synced]| {
        trace
            .iter()
            .filter(|s| matches!(s, Synced::Pushed(p) if p.is_file()))
            .count()
    };
    let (prepared, trace) = durable::traced(|| prepare(&dir, &Tables, 1, &[0, 1, 2, 3]));
    drop(prepared.unwrap());
    assert!(fulls(&trace).is_empty(), "{trace:?}");
    assert_eq!((trace.len(), pushed(&trace)), (5, 5), "{trace:?}");
    fs::remove_dir_all(gen_dir(&dir, 1)).unwrap();

    let paths: Vec<PathBuf> = fs::read_dir(dir.join("log"))
        .unwrap()
        .map(|f| f.unwrap().path())
        .collect();
    let (synced, trace) = durable::traced(|| sync_frozen(&dir, paths.iter().map(|p| p.as_path())));
    synced.unwrap();
    assert!(fulls(&trace).is_empty(), "{trace:?}");
    assert_eq!((trace.len(), pushed(&trace)), (5, 5), "{trace:?}");
    let _ = fs::remove_dir_all(&dir);
}
