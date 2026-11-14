//! Crash injection for tests: `TC_STORE_CRASH_AT=<point>` aborts the
//! process at that point, as a power cut there would leave the files (less
//! what the OS hadn't written back, which the syncs around each point are
//! for).
//!
//! The points: `rotate` (the new generation's files are made and swapped
//! in, nothing appended to them yet) and `create` (a store's log written,
//! its metadata not yet).

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
