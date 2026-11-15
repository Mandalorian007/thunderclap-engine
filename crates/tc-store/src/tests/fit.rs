//! Opening under a lock already held and from a scan, open-time checks
//! (leftovers, a foreign archive), marks with a wall time, a backup of a
//! log holding only marks, the archive read, and kills inside `tidy`.

use std::fs;
use std::path::Path;
use std::process::Command;

use super::*;
use crate::{
    ArchivePolicy, Log, MemoryLog, StoreError, StoreLock, backup, gen_dir, prepare, read_archive,
    summary, tidy,
};

/// Entries 1 to 3 in generation 0 (the second in `t.0.log`), marked and
/// rotated to generation 1, which holds entries 4 and 5 then (unless
/// `tail` is false) and a mark: the shape a game with a base has.
fn two_gens(label: &str, tail: bool) -> (Log<Tables>, PathBuf) {
    let (mut log, dir) = new_log(label);
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 0, "pawn")).unwrap();
    log.append(&say(3, "b")).unwrap();
    mark(&mut log, 30);
    let (next, keys) = log.to_prepare();
    log.rotate(prepare(&dir, &Tables, next, &keys).unwrap(), 30)
        .unwrap();
    if tail {
        log.append(&put(4, 0, "rook")).unwrap();
        log.append(&say(5, "c")).unwrap();
    }
    mark(&mut log, 50);
    log.sync_frozen().unwrap();
    log.note_base(1);
    (log, dir)
}

/// The wall marks in a `main.log`: time, covers, wall.
fn wall_marks(path: &Path) -> Vec<(u64, u64, u64)> {
    let bytes = fs::read(path).unwrap();
    format::scan(&bytes)
        .unwrap()
        .records
        .iter()
        .filter(|r| r.kind == KIND_WALL_MARK)
        .map(|r| format::decode_wall_mark(r.payload).unwrap())
        .collect()
}

/// A scan read under a lock opens under it without reading again, and
/// appends after its last entry even when the caller took the entries;
/// another lock, or one that isn't the store's, is refused.
#[test]
fn a_scan_opens_under_its_lock() {
    let (mut log, dir) = new_log("scan");
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 0, "pawn")).unwrap();
    mark(&mut log, 20);
    drop(log);

    let lock = StoreLock::acquire(&dir).unwrap();
    assert_eq!(lock.dir(), dir);
    let mut scan = Log::scan(&lock, &Tables, 0, 0).unwrap();
    assert_eq!((scan.meta.as_slice(), scan.clock), (&b"meta"[..], 20));
    assert!(scan.report.is_clean() && scan.leftovers.is_empty());
    let entries = std::mem::take(&mut scan.entries);
    assert_eq!(entries, [say(1, "a"), put(2, 0, "pawn")]);
    // Another process can't open it meanwhile.
    assert!(matches!(
        Log::open(&dir, Tables),
        Err(StoreError::InUse { .. })
    ));
    let (mut log, opened) = Log::open_scanned(lock, Tables, scan).unwrap();
    assert!(opened.entries.is_empty());
    log.append(&say(3, "b")).unwrap();
    mark(&mut log, 30);
    drop(log);

    // A scan under one lock doesn't open under another.
    let lock = StoreLock::acquire(&dir).unwrap();
    let scan = Log::scan(&lock, &Tables, 0, 0).unwrap();
    drop(lock);
    let other = StoreLock::acquire(&dir).unwrap();
    let err = Log::open_scanned(other, Tables, scan)
        .err()
        .expect("refused");
    assert!(err.to_string().contains("lock it was read under"), "{err}");

    let named = StoreLock::acquire_named(&dir, "game.lock").unwrap();
    assert!(matches!(
        Log::scan(&named, &Tables, 0, 0),
        Err(StoreError::Meta { .. })
    ));
    drop(named);

    let lock = StoreLock::acquire(&dir).unwrap();
    let (log, opened) = Log::open_locked(lock, Tables, 0, 0).unwrap();
    assert_eq!(opened.entries.len(), 3);
    assert_eq!(log.last_seq(), 3);
    drop(log);
    let _ = fs::remove_dir_all(&dir);
}

/// Marks with the caller's wall time are each written as asked, never
/// folded together, on disk and in memory.
#[test]
fn a_mark_with_a_wall_time_is_written_as_asked() {
    let (mut log, dir) = new_log("mark-wall");
    log.append(&say(1, "a")).unwrap();
    log.mark_wall(10, 1_000).unwrap();
    log.append(&say(2, "b")).unwrap();
    log.mark_wall(20, 2_000).unwrap();
    log.mark_wall(25, 2_500).unwrap();
    log.wait().unwrap();
    assert_eq!(
        wall_marks(&dir.join("log/main.log")),
        [(10, 1, 1_000), (20, 2, 2_000), (25, 2, 2_500)]
    );
    drop(log);
    let _ = fs::remove_dir_all(&dir);

    let mut memory = MemoryLog::new(Tables);
    memory.append(&say(1, "a")).unwrap();
    memory.mark_wall(10, 1_000);
    assert_eq!(memory.marks().unwrap(), [(10, 1, Some(1_000))]);
}

/// A backup of a store whose live log holds only marks (every entry
/// archived) copies it, and the copy opens after the archived entries.
#[test]
fn a_backup_of_a_log_holding_only_marks_opens() {
    let (log, dir) = two_gens("backup-marks", false);
    assert_eq!(
        tidy(&dir, &Tables, 1, &ArchivePolicy::default())
            .unwrap()
            .archived,
        [0]
    );
    drop(log);
    let out = temp("backup-marks-out");
    let report = backup(&dir, &out, true).unwrap();
    assert_eq!((report.last_seq, report.archive_files), (3, 3));
    let (mut log, opened) = Log::open_from(&out, Tables, 1, 3).unwrap();
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert!(opened.entries.is_empty());
    assert_eq!(opened.clock, 50);
    log.append(&say(4, "d")).unwrap();
    drop(log);
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&out);
}

/// The archive reads back as it was in `log/`, by generation.
#[test]
fn the_archive_reads_back() {
    let (log, dir) = two_gens("read-archive", true);
    let live: Vec<Vec<u8>> = ["log/main.log", "log/t.0.log"]
        .iter()
        .map(|p| fs::read(dir.join(p)).unwrap())
        .collect();
    tidy(&dir, &Tables, 1, &ArchivePolicy::default()).unwrap();
    drop(log);
    let files = read_archive(&dir, &Tables, ..).unwrap();
    assert_eq!(
        files
            .iter()
            .map(|f| (f.generation, f.key, f.path.clone()))
            .collect::<Vec<_>>(),
        [
            (0, None, dir.join("log/main.log")),
            (0, Some(0), dir.join("log/t.0.log")),
        ]
    );
    assert_eq!(files[0].bytes, live[0]);
    assert_eq!(files[1].bytes, live[1]);
    assert!(read_archive(&dir, &Tables, 1..).unwrap().is_empty());
    let _ = fs::remove_dir_all(&dir);
}

/// A table built by the caller decodes as one read from a file.
#[test]
fn a_name_table_is_built_from_names() {
    let table: NameTable = [(1, "pawn".to_string()), (1, "rook".to_string())]
        .into_iter()
        .collect();
    assert_eq!((table.get(1), table.get(2)), (Some("pawn"), None));
    let mut table = NameTable::new();
    assert!(table.define(3, "king".into()));
    assert!(!table.define(3, "queen".into()));
    assert_eq!(table.get(3), Some("king"));
}

/// Another store's archive, copied in or left over, is refused at open:
/// one holding the generation appended to, or one whose live copy of a
/// generation differs.
#[test]
fn a_foreign_archive_is_refused_at_open() {
    let (log, other) = two_gens("foreign-src", true);
    tidy(&other, &Tables, 1, &ArchivePolicy::default()).unwrap();
    drop(log);

    // A store created over another's archive: generation 0 is appended to.
    let (mut log, dir) = new_log("foreign-new");
    log.append(&say(1, "x")).unwrap();
    mark(&mut log, 10);
    drop(log);
    copy_dir(&other.join("archive"), &dir.join("archive"));
    let err = Log::open(&dir, Tables).err().expect("refused");
    assert!(matches!(err, StoreError::Meta { .. }), "{err}");
    assert!(err.to_string().contains("not this log's archive"), "{err}");
    let _ = fs::remove_dir_all(&dir);

    // A rotated store whose live generation 0 differs from the archive's.
    let (mut log, dir) = new_log("foreign-gen");
    log.append(&say(1, "x")).unwrap();
    mark(&mut log, 10);
    let (next, keys) = log.to_prepare();
    log.rotate(prepare(&dir, &Tables, next, &keys).unwrap(), 10)
        .unwrap();
    drop(log);
    copy_dir(&other.join("archive"), &dir.join("archive"));
    let err = Log::open_from(&dir, Tables, 1, 1).err().expect("refused");
    assert!(
        err.to_string().contains("differs from the live copy"),
        "{err}"
    );
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&other);
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for item in fs::read_dir(from).unwrap() {
        let item = item.unwrap();
        if item.file_type().unwrap().is_dir() {
            copy_dir(&item.path(), &to.join(item.file_name()));
        } else {
            fs::copy(item.path(), to.join(item.file_name())).unwrap();
        }
    }
}

/// What an archiving cut short left is cleared at open, and reported.
#[test]
fn leftovers_are_cleared_at_open() {
    let (log, dir) = two_gens("leftovers", true);
    drop(log);
    let made = [
        dir.join("archive/.g0.tmp"),
        dir.join("archive/.g3.del"),
        dir.join("log/.g0.del"),
    ];
    for path in &made {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("main.log.z"), b"torn").unwrap();
    }
    fs::write(dir.join(".store.meta.tmp"), b"torn").unwrap();
    let lock = StoreLock::acquire(&dir).unwrap();
    let scan = Log::scan(&lock, &Tables, 0, 0).unwrap();
    assert_eq!(scan.leftovers.len(), 4, "{:?}", scan.leftovers);
    assert!(scan.report.is_clean());
    for path in &made {
        assert!(!path.exists(), "{}", path.display());
    }
    assert!(!dir.join(".store.meta.tmp").exists());
    assert_eq!(scan.entries.len(), 5);
    let _ = fs::remove_dir_all(&dir);
}

/// The env var naming the store [`tidy_child`] tidies.
const CHILD_DIR: &str = "TC_STORE_TEST_TIDY_DIR";

/// Not a test of its own: [`a_kill_inside_tidy_recovers`] runs it in a
/// child process, killed at a crash point.
#[test]
fn tidy_child() {
    let Ok(dir) = std::env::var(CHILD_DIR) else {
        return;
    };
    let tight = ArchivePolicy {
        keep_days: 7,
        max_bytes: 0,
    };
    tidy(Path::new(&dir), &Tables, 1, &tight).unwrap();
}

/// A process killed at each crash point inside `tidy` (archiving
/// generation 0, then pruning it): the store opens from generation 1 with
/// every entry since, opening clears what was left, and `tidy` finishes.
#[test]
fn a_kill_inside_tidy_recovers() {
    let exe = std::env::current_exe().unwrap();
    for point in ["tidy.tmp", "tidy.archived", "tidy.moved", "tidy.prune"] {
        let (log, dir) = two_gens(&format!("kill-{point}"), true);
        drop(log);
        let status = Command::new(&exe)
            .args([
                "tests::fit::tidy_child",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("TC_STORE_CRASH_AT", point)
            .env(CHILD_DIR, &dir)
            .output()
            .unwrap();
        assert!(!status.status.success(), "{point}: the child wasn't killed");
        assert!(
            String::from_utf8_lossy(&status.stderr).contains(&format!("={point}: aborting")),
            "{point}: {}",
            String::from_utf8_lossy(&status.stderr)
        );
        let (log, opened) = Log::open_from(&dir, Tables, 1, 3).unwrap();
        assert!(opened.report.is_clean(), "{point}: {:?}", opened.report);
        assert_eq!(opened.entries, [put(4, 0, "rook"), say(5, "c")], "{point}");
        let tight = ArchivePolicy {
            keep_days: 7,
            max_bytes: 0,
        };
        let tidied = tidy(&dir, &Tables, 1, &tight).unwrap();
        assert!(tidied.leftovers.is_empty(), "{point}: {tidied:?}");
        assert!(summary(&dir).unwrap().is_empty(), "{point}");
        assert!(!dir.join("log/main.log").exists(), "{point}");
        assert!(gen_dir(&dir, 1).join("main.log").is_file(), "{point}");
        let names: Vec<String> = fs::read_dir(dir.join("archive"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.is_empty(), "{point}: {names:?}");
        drop(log);
        let _ = fs::remove_dir_all(&dir);
    }
}
