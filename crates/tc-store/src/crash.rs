//! Crash injection for tests: `TC_STORE_CRASH_AT=<point>` aborts the
//! process at that point, as a power cut there would leave the files (less
//! what the OS hadn't written back, which the syncs around each point are
//! for).
//!
//! The points: `rotate` (the new generation's files are made and swapped
//! in, nothing appended to them yet) and `create` (a store's log written,
//! its metadata not yet); and in [`crate::tidy`], `tidy.tmp` (a
//! generation's archive written to its `.tmp` directory, not yet renamed),
//! `tidy.archived` (renamed into the archive, its live files not yet
//! moved), `tidy.moved` (its live files moved to a `.del` directory, not
//! yet removed) and `tidy.prune` (an archived generation pruned to a `.del`
//! name, not yet removed). Every one recovers: opening clears the `.tmp`
//! and `.del` leftovers, and the next `tidy` finishes the generation.

use std::sync::OnceLock;

/// Aborts the process if `TC_STORE_CRASH_AT` names `name`.
pub(crate) fn point(name: &str) {
    static AT: OnceLock<Option<String>> = OnceLock::new();
    let at = AT.get_or_init(|| std::env::var("TC_STORE_CRASH_AT").ok());
    if at.as_deref() == Some(name) {
        eprintln!("TC_STORE_CRASH_AT={name}: aborting");
        std::process::abort();
    }
}
