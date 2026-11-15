//! Readers change nothing (E26): every file's bytes and every name in a
//! store are the same after each reader as before, even on a store an
//! open would recover, clear and upgrade; an upgrade happens only in an
//! open, and says so.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use super::*;
use crate::{
    ArchivePolicy, Log, Output, RollbackTo, StoreError, StoreLock, Upgrade, backup, bases, check,
    holder, prepare, read, read_archive, read_from, repair, rollback, summary, tidy, upgrade,
    upgrade_due,
};

/// Every path under `dir` (directories too) with its bytes' hash: what a
/// reader must leave as it was.
fn tree(dir: &Path) -> BTreeMap<String, Option<u64>> {
    fn walk(root: &Path, at: &Path, out: &mut BTreeMap<String, Option<u64>>) {
        let mut items: Vec<_> = fs::read_dir(at).unwrap().flatten().collect();
        items.sort_by_key(|i| i.file_name());
        for item in items {
            let path = item.path();
            let name = path.strip_prefix(root).unwrap().display().to_string();
            if path.is_dir() {
                out.insert(name, None);
                walk(root, &path, out);
            } else {
                let bytes = fs::read(&path).unwrap();
                // FNV-1a: enough to tell any change in a test's files.
                let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
                    (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
                });
                out.insert(name, Some(hash ^ bytes.len() as u64));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// A store with two generations (the first archived), a torn tail on the
/// live `main.log`, and the leftovers an archiving and a metadata write
/// cut short leave: everything an open would change.
fn store_an_open_would_change(label: &str) -> std::path::PathBuf {
    let (mut log, dir) = new_log(label);
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 0, "pawn")).unwrap();
    mark(&mut log, 20);
    let (next, keys) = log.to_prepare();
    log.rotate(prepare(&dir, &Tables, next, &keys).unwrap(), 20)
        .unwrap();
    log.append(&say(3, "b")).unwrap();
    mark(&mut log, 30);
    log.sync_frozen().unwrap();
    log.note_base(1);
    drop(log);
    tidy(&dir, &Tables, 1, &ArchivePolicy::default()).unwrap();
    // A torn record at the live main log's end.
    let main = crate::gen_dir(&dir, 1).join(crate::MAIN_LOG);
    let mut bytes = fs::read(&main).unwrap();
    bytes.extend_from_slice(&[9, 0, 0]);
    fs::write(&main, bytes).unwrap();
    // Leftovers of an archiving and a metadata write cut short.
    fs::create_dir_all(dir.join("archive/.g7.tmp")).unwrap();
    fs::write(dir.join("archive/.g7.tmp/main.log.z"), b"half").unwrap();
    fs::write(dir.join(".store.meta.tmp"), b"half").unwrap();
    dir
}

/// Every reader, on a store an open would cut, clear and tidy: not a byte
/// or a name changes. The open after them does change it (the fixture is
/// one a writer must touch).
#[test]
fn readers_change_nothing() {
    let dir = store_an_open_would_change("read-only");
    let out = temp("read-only-out");
    let before = tree(&dir);

    // Generation 0 is archived: a plain read refuses, a base's tail reads.
    assert!(read(&dir, &Tables).is_err());
    let r = read_from(&dir, &Tables, 1, 2).unwrap();
    assert_eq!(r.entries.len(), 1, "generation 1's tail: entry 3");
    assert!(!r.report.truncated.is_empty(), "the torn tail is reported");
    assert!(r.report.upgraded.is_none());
    let c = check(&dir, &Tables).unwrap();
    assert!(c.open.is_ok());
    read_archive(&dir, &Tables, ..).unwrap();
    summary(&dir).unwrap();
    bases(&dir).unwrap();
    holder(&dir);
    upgrade_due(&dir, &Tables);
    backup(&dir, &out.join("backup"), true).unwrap();
    repair(&dir, &Tables, Output::Copy(&out.join("repair"))).unwrap();
    rollback(
        &dir,
        &Tables,
        RollbackTo::Seq(2),
        Output::Copy(&out.join("rollback")),
    )
    .unwrap();
    assert_eq!(tree(&dir), before, "a reader changed the store");

    let (_log, opened) = Log::open_from(&dir, Tables, 1, 2).unwrap();
    assert!(opened.report.upgraded.is_none());
    assert_ne!(tree(&dir), before, "an open recovers and clears");
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&out);
}

/// The old layout [`Legacy`] upgrades: the main log named `old.log`, and
/// no `store.meta`.
const OLD_MAIN: &str = "old.log";

/// The test codec with an [`Upgrade`]: an old layout's `log/old.log` is
/// renamed `main.log` and `store.meta` written.
struct Legacy;

struct RenameOld;

impl Upgrade for RenameOld {
    fn due(&self, dir: &Path) -> Option<String> {
        dir.join("log")
            .join(OLD_MAIN)
            .exists()
            .then(|| format!("renames log/{OLD_MAIN} main.log"))
    }

    fn apply(&self, lock: &StoreLock) -> Result<String, StoreError> {
        let dir = lock.dir();
        let from = dir.join("log").join(OLD_MAIN);
        fs::rename(&from, dir.join("log").join(crate::MAIN_LOG)).unwrap();
        fs::write(dir.join(crate::META_FILE), b"meta").unwrap();
        Ok(format!("renamed log/{OLD_MAIN} main.log"))
    }
}

impl crate::LogCodec for Legacy {
    type Event = Ev;
    type Key = u32;

    fn key(&self, event: &Ev) -> Option<u32> {
        Tables.key(event)
    }

    fn file_name(&self, key: &u32) -> String {
        Tables.file_name(key)
    }

    fn parse_file_name(&self, name: &str) -> Option<u32> {
        Tables.parse_file_name(name)
    }

    fn encode(
        &self,
        event: &Ev,
        names: &mut crate::Names<'_>,
        out: &mut Vec<u8>,
    ) -> Result<(), String> {
        Tables.encode(event, names, out)
    }

    fn decode(&self, bytes: &[u8], names: &crate::NameTable) -> Result<Ev, String> {
        Tables.decode(bytes, names)
    }

    fn upgrade(&self) -> Option<&dyn Upgrade> {
        Some(&RenameOld)
    }
}

/// A store in the old layout: two entries and a mark.
fn old_layout(label: &str) -> std::path::PathBuf {
    let (mut log, dir) = new_log(label);
    log.append(&say(1, "a")).unwrap();
    log.append(&put(2, 0, "pawn")).unwrap();
    mark(&mut log, 20);
    drop(log);
    fs::rename(dir.join("log/main.log"), dir.join("log").join(OLD_MAIN)).unwrap();
    fs::remove_file(dir.join(crate::META_FILE)).unwrap();
    dir
}

/// On an old layout every reader refuses with `UpgradeDue`, naming the
/// upgrade and changing nothing; an open upgrades it, under the lock, and
/// says so once; a game holding the lock runs it with `upgrade`.
#[test]
fn an_upgrade_happens_only_in_an_open() {
    let dir = old_layout("upgrade");
    let out = temp("upgrade-out");
    let before = tree(&dir);
    let due = |r: Result<(), StoreError>| match r {
        Err(StoreError::UpgradeDue { what, .. }) => assert!(what.contains(OLD_MAIN), "{what}"),
        other => panic!("expected UpgradeDue, got {other:?}"),
    };
    due(read(&dir, &Legacy).map(drop));
    due(read_from(&dir, &Legacy, 0, 0).map(drop));
    due(check(&dir, &Legacy).map(drop));
    due(read_archive(&dir, &Legacy, ..).map(drop));
    due(repair(&dir, &Legacy, Output::Copy(&out)).map(drop));
    due(rollback(&dir, &Legacy, RollbackTo::Seq(1), Output::InPlace).map(drop));
    due(tidy(&dir, &Legacy, 0, &ArchivePolicy::default()).map(drop));
    let error = read(&dir, &Legacy).unwrap_err().to_string();
    assert!(error.contains("nothing was changed"), "{error}");
    assert!(upgrade_due(&dir, &Legacy).is_some());
    assert!(upgrade_due(&dir, &Tables).is_none(), "no upgrade, no due");
    assert_eq!(tree(&dir), before, "a reader upgraded the store");
    assert!(!out.exists());

    let (log, opened) = Log::open(&dir, Legacy).unwrap();
    assert_eq!(opened.entries.len(), 2);
    assert_eq!(
        opened.report.upgraded.as_deref(),
        Some("renamed log/old.log main.log")
    );
    assert!(opened.report.is_clean(), "an upgrade isn't recovery");
    drop(log);
    let (_log, again) = Log::open(&dir, Legacy).unwrap();
    assert!(again.report.upgraded.is_none(), "upgraded once");
    drop(_log);
    assert_eq!(read(&dir, &Legacy).unwrap().entries.len(), 2);

    // Under a lock the game holds.
    let dir2 = old_layout("upgrade-locked");
    let lock = StoreLock::acquire(&dir2).unwrap();
    assert_eq!(
        upgrade(&lock, &Legacy).unwrap().as_deref(),
        Some("renamed log/old.log main.log")
    );
    assert!(upgrade(&lock, &Legacy).unwrap().is_none());
    let named = StoreLock::acquire_named(&dir2, "other.lock").unwrap();
    assert!(matches!(
        upgrade(&named, &Legacy),
        Err(StoreError::Meta { .. })
    ));
    drop((lock, named));
    for d in [dir, dir2] {
        let _ = fs::remove_dir_all(d);
    }
}
