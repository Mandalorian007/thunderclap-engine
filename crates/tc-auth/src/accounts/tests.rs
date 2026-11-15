//! The accounts' tests, ported from Forge Wilds' sign-in store: claims,
//! reads, recovery and locking of the file store, the JSON it parses, and
//! the memory store's revisions and times.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::file::{BACKUP_FILE, NAMES_FILE};
use super::{Accounts, Claim, Claimed, Clock, FileAccounts, MemoryAccounts, Records};
use crate::names::NameRules;
use crate::token::ClaimWords;

/// A directory under the system temp dir, removed on drop.
struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> TestDir {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tc-auth-accounts-{}-{n}-{label}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TestDir(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn rules() -> NameRules {
    NameRules::default()
}

/// A fixed clock at `t`.
fn at(t: u64) -> Clock {
    Arc::new(move || t)
}

fn open(dir: &Path) -> FileAccounts {
    FileAccounts::open(dir, rules()).with_clock(at(100))
}

/// A claim as a game's CLI makes one: its own store, opened for it.
fn claim(dir: &Path, claim: &Claim) -> Result<Claimed, String> {
    open(dir).claim(claim).map_err(|e| e.0)
}

fn named(name: &str, account: Option<&str>, reset: bool) -> Claim {
    Claim {
        name: Some(name.into()),
        account: account.map(String::from),
        reset,
    }
}

fn account(account: &str, reset: bool) -> Claim {
    Claim {
        name: None,
        account: Some(account.into()),
        reset,
    }
}

fn parse(text: &str) -> Result<Records, String> {
    Records::parse(text, &rules())
}

#[test]
fn an_account_takes_one_name_once() {
    let dir = TestDir::new("once");
    let w = &dir.0;
    let a = claim(w, &named("alice", Some("chat:1"), false)).unwrap();
    assert_eq!(
        (a.name.as_str(), a.generation, a.created),
        ("alice", 1, true)
    );
    // Again: the same generation, nothing written.
    let again = claim(w, &named("alice", Some("chat:1"), false)).unwrap();
    assert_eq!((again.generation, again.created), (1, false));
    // By account alone.
    assert_eq!(claim(w, &account("chat:1", false)).unwrap().name, "alice");
    // Another name for the same account, or the same name for another.
    let err = claim(w, &named("alicia", Some("chat:1"), false)).unwrap_err();
    assert!(err.contains("already has the name alice"), "{err}");
    let err = claim(w, &named("alice", Some("chat:2"), false)).unwrap_err();
    assert!(err.contains("taken"), "{err}");
    let err = claim(w, &account("chat:3", false)).unwrap_err();
    assert!(err.contains("no name yet"), "{err}");
    // An operator without an account may claim any name.
    assert_eq!(
        claim(w, &named("alice", None, false)).unwrap().generation,
        1
    );
    let err = claim(w, &named("Alice", None, false)).unwrap_err();
    assert!(err.contains("1 to 32 of [a-z0-9_]"), "{err}");
    assert!(claim(w, &named("bob", Some("has space"), false)).is_err());
    assert!(claim(w, &Claim::default()).is_err());
}

#[test]
fn a_reset_bumps_the_generation_and_survives_reopening() {
    let dir = TestDir::new("reset");
    let w = &dir.0;
    claim(w, &named("alice", Some("chat:1"), false)).unwrap();
    // A reset of a new name is its first generation.
    assert_eq!(claim(w, &named("bob", None, true)).unwrap().generation, 1);
    assert_eq!(claim(w, &account("chat:1", true)).unwrap().generation, 2);
    assert_eq!(claim(w, &account("chat:1", true)).unwrap().generation, 3);
    let live = open(w);
    assert_eq!(live.generation("alice"), 3);
    assert_eq!(live.generation("bob"), 1);
    assert_eq!(live.generation("carol"), 0);
    let text = fs::read_to_string(w.join(NAMES_FILE)).unwrap();
    assert_eq!(
        text,
        "{\"format\":1,\"names\":{\n  \"alice\":{\"account\":\"chat:1\",\"created\":100,\"generation\":3,\"last_seen\":100},\n  \"bob\":{\"created\":100,\"generation\":1,\"last_seen\":100}\n}}\n"
    );
    // The backup is the copy before the last write.
    let backup = fs::read_to_string(w.join(BACKUP_FILE)).unwrap();
    assert_eq!(parse(&backup).unwrap().generation("alice"), 2);
}

#[test]
fn the_server_reads_changes_and_says_so() {
    let dir = TestDir::new("live");
    let w = &dir.0;
    let live = open(w);
    let mut revisions = live.subscribe();
    assert_eq!(live.generation("alice"), 0);
    assert!(!revisions.has_changed().unwrap());
    claim(w, &named("alice", None, false)).unwrap();
    assert_eq!(live.generation("alice"), 1);
    assert!(revisions.has_changed().unwrap());
    revisions.mark_unchanged();
    // Same length, same second: the rename still shows.
    claim(w, &named("alice", None, true)).unwrap();
    assert_eq!(live.generation("alice"), 2);
    assert!(revisions.has_changed().unwrap());
    revisions.mark_unchanged();
    // Reading again without a change says nothing.
    assert_eq!(live.generation("alice"), 2);
    assert!(!revisions.has_changed().unwrap());
}

#[test]
fn a_broken_store_recovers_by_itself() {
    let dir = TestDir::new("broken");
    let w = &dir.0;
    claim(w, &named("alice", None, false)).unwrap();
    claim(w, &named("alice", None, true)).unwrap();
    claim(w, &named("alice", None, true)).unwrap();
    let live = open(w);
    assert_eq!(live.generation("alice"), 3);

    // A torn names.json: the server falls back to the backup.
    fs::write(w.join(NAMES_FILE), "{\"format\":1,\"na").unwrap();
    assert_eq!(live.generation("alice"), 2);
    // Both broken: it keeps what it had.
    fs::write(w.join(BACKUP_FILE), "garbage").unwrap();
    fs::write(w.join(NAMES_FILE), "{}").unwrap();
    assert_eq!(live.generation("alice"), 2);
    // A fresh server on a broken store knows no names: every token joins.
    assert_eq!(open(w).generation("alice"), 0);

    // A writer sets the broken file aside and starts over.
    let got = claim(w, &named("alice", None, true)).unwrap();
    assert_eq!((got.generation, got.created), (1, true));
    assert!(
        got.warnings.iter().any(|w| w.contains("set it aside")),
        "{:?}",
        got.warnings
    );
    let aside = fs::read_dir(w)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("names.json.broken-")
        })
        .count();
    assert_eq!(aside, 1);
    assert_eq!(live.generation("alice"), 1);

    // A broken names.json with a good backup: the writer starts from
    // the backup and keeps it.
    claim(w, &named("alice", None, true)).unwrap();
    fs::write(w.join(NAMES_FILE), "not json").unwrap();
    let got = claim(w, &named("bob", None, false)).unwrap();
    assert!(
        got.warnings.iter().any(|w| w.contains("backup")),
        "{:?}",
        got.warnings
    );
    assert_eq!(live.generation("alice"), 1, "the backup's");
    assert_eq!(live.generation("bob"), 1);
    assert_eq!(
        parse(&fs::read_to_string(w.join(BACKUP_FILE)).unwrap())
            .unwrap()
            .generation("alice"),
        1,
        "the broken file never becomes the backup"
    );

    // A missing names.json with a backup: the backup.
    fs::remove_file(w.join(NAMES_FILE)).unwrap();
    assert_eq!(open(w).generation("alice"), 1);
}

#[test]
fn concurrent_writers_lose_nothing() {
    let dir = TestDir::new("race");
    let w = dir.0.clone();
    claim(&w, &named("alice", None, false)).unwrap();
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let w = w.clone();
            std::thread::spawn(move || {
                for _ in 0..10 {
                    claim(&w, &named("alice", None, true)).unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(open(&w).generation("alice"), 81);
}

#[test]
fn parse_refuses_what_it_never_writes() {
    for bad in [
        "",
        "[]",
        "{\"format\":2,\"names\":{}}",
        "{\"format\":1}",
        "{\"format\":1,\"names\":{\"Bad\":{\"generation\":1}}}",
        "{\"format\":1,\"names\":{\"a\":{\"generation\":-1}}}",
        "{\"format\":1,\"names\":{\"a\":{\"generation\":4294967296}}}",
        "{\"format\":1,\"names\":{\"a\":{}}}",
        "{\"format\":1,\"names\":{\"a\":{\"generation\":1,\"account\":7}}}",
        "{\"format\":1,\"names\":{\"a\":{\"generation\":1,\"created\":\"x\"}}}",
        "{\"format\":1,\"names\":{\"a\":{\"generation\":1,\"last_seen\":-3}}}",
    ] {
        assert!(parse(bad).is_err(), "{bad:?}");
    }
    // Forge Wilds' stores (no times) read; unknown fields are ignored.
    let records =
        parse("{\"format\":1,\"names\":{\"a\":{\"generation\":4,\"extra\":true}}}").unwrap();
    assert_eq!(records.generation("a"), 4);
    assert_eq!(records.get("a").unwrap().created, 0);
    let again = parse(&records.to_json()).unwrap();
    assert_eq!(again.to_json(), records.to_json());
}

#[test]
fn records_carry_times_and_last_seen_is_flushed() {
    let dir = TestDir::new("times");
    let w = &dir.0;
    let live = FileAccounts::open(w, rules()).with_clock(at(1_000));
    let mut revisions = live.subscribe();
    live.claim(&named("ada", Some("chat:9"), false)).unwrap();
    revisions.mark_unchanged();
    let rec = live.get("ada").unwrap();
    assert_eq!(
        (rec.account.as_deref(), rec.created, rec.last_seen),
        (Some("chat:9"), 1_000, 1_000)
    );
    // Seen: in memory at once, no revision, nothing written yet.
    live.seen("ada", 2_000);
    live.seen("nobody", 2_000);
    assert_eq!(live.get("ada").unwrap().last_seen, 2_000);
    assert!(!revisions.has_changed().unwrap());
    assert_eq!(open(w).get("ada").unwrap().last_seen, 1_000);
    live.flush().unwrap();
    assert_eq!(open(w).get("ada").unwrap().last_seen, 2_000);
    assert!(!revisions.has_changed().unwrap(), "times are not revisions");
    // An older sighting never moves it back; another writer's claim keeps it.
    live.seen("ada", 1_500);
    claim(w, &named("bob", None, false)).unwrap();
    assert_eq!(live.get("ada").unwrap().last_seen, 2_000);
    assert_eq!(live.get("ada").unwrap().created, 1_000);
}

#[test]
fn memory_accounts_follow_the_same_rules() {
    let mem = MemoryAccounts::new(rules()).with_clock(at(7));
    let mut revisions = mem.subscribe();
    let a = mem.claim(&named("alice", Some("chat:1"), false)).unwrap();
    assert_eq!((a.generation, a.created), (1, true));
    assert!(revisions.has_changed().unwrap());
    revisions.mark_unchanged();
    // A claim that changes nothing moves no revision.
    mem.claim(&account("chat:1", false)).unwrap();
    assert!(!revisions.has_changed().unwrap());
    assert!(mem.claim(&named("alice", Some("chat:2"), false)).is_err());
    assert_eq!(mem.claim(&account("chat:1", true)).unwrap().generation, 2);
    assert!(revisions.has_changed().unwrap());
    revisions.mark_unchanged();
    mem.seen("alice", 9);
    assert!(!revisions.has_changed().unwrap());
    let rec = mem.get("alice").unwrap();
    assert_eq!((rec.created, rec.last_seen, rec.generation), (7, 9, 2));
    assert_eq!(mem.generation("zed"), 0);
    assert!(mem.get("zed").is_none());
}

#[test]
fn a_game_sets_its_own_name_rules() {
    let mem = MemoryAccounts::new(NameRules {
        min: 3,
        max: 8,
        allowed: |c| c.is_ascii_alphabetic(),
        describe: "3 to 8 letters",
    });
    assert!(mem.claim(&named("Ada", None, false)).is_ok());
    let err = mem.claim(&named("ad", None, false)).unwrap_err();
    assert!(err.0.contains("3 to 8 letters"), "{err}");
}

#[test]
fn a_game_words_the_claim_refusals_its_own_way() {
    let words = ClaimWords {
        name_owned: "this account already plays as {name}".into(),
        name_taken: "{name} is someone else's".into(),
        bad_account: "who is {name}?".into(),
        ..ClaimWords::default()
    };
    let dir = TestDir::new("words");
    let file = open(&dir.0).with_words(words.clone());
    let memory = MemoryAccounts::new(rules()).with_words(words);
    for store in [&file as &dyn Accounts, &memory] {
        store.claim(&named("alice", Some("chat:1"), false)).unwrap();
        let err = |c: &Claim| store.claim(c).unwrap_err().0;
        assert_eq!(
            err(&named("alicia", Some("chat:1"), false)),
            "this account already plays as alice"
        );
        assert_eq!(
            err(&named("alice", Some("chat:2"), false)),
            "alice is someone else's"
        );
        assert_eq!(err(&account("a b", false)), "who is \"a b\"?");
        // The rest keep the default words.
        assert_eq!(
            err(&account("chat:3", false)),
            "this account has no name yet: give one"
        );
    }
}
