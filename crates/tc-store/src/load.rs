//! Reading a store directory to open it: every log file of every generation
//! it needs, merged by sequence and cut back to the durable prefix, changing
//! nothing ([`Log::open`](crate::Log::open) then cuts the files).
//!
//! # Recovery
//!
//! A process crash loses nothing that was written, except a mark asked for
//! whose syncs hadn't finished. An OS crash or power loss can lose any
//! unsynced suffix of each file independently, so a later entry in one file
//! can survive while an earlier one in another file is lost. The durable
//! log is therefore the longest gap-free prefix of sequence numbers, and
//! opening a store:
//!
//! - cuts a torn record (or torn header) off the end of a file;
//! - fails if a clock mark covers an entry that isn't there;
//! - if the sequence has a gap that lost writes explain, drops every entry
//!   after the gap and cuts the files back to that prefix. Lost writes
//!   explain a gap when the first missing entry could have been at the end
//!   of some file (one file has no entry after it, or a keyed file whose
//!   name was lost with it) and no clock mark covers it. A mark cut off
//!   with the dropped entries (written after them but covering none of
//!   them) is written again after the cut, so the clock never goes back
//!   past a mark on disk;
//! - drops a batch the durable prefix ends inside of: entries appended
//!   together are all or none. Each file a batch writes gets a batch
//!   record (its first and last entry) in the same write as its first
//!   entry of the batch, so a batch entry that survived always has its
//!   batch record before it, and the prefix can be moved back to just
//!   before the batch;
//! - fails on any other gap, a duplicate entry, or damage before a file's
//!   tail, and then changes no log file.
//!
//! Every byte cut off a file is first saved to `recovered/` in the store
//! directory (`<file>.<from>-<to>.<unix time>.tail`, synced), never
//! destroyed; the [`OpenReport`] names it.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::codec::{LogCodec, LogEntry};
use crate::error::StoreError;
use crate::gens::{self, Generation, Listing};
use crate::log_file::FileState;
use crate::read::{FileLog, Item, read_logs};
use crate::{MAIN_LOG, META_FILE, OpenReport, Truncated, log_dir};

/// A store directory's contents, read without changing anything.
pub(crate) struct Loaded<E, K> {
    pub meta: Vec<u8>,
    /// The durable entries, in sequence order, gap-free from `after + 1`.
    pub entries: Vec<LogEntry<E>>,
    /// The latest clock mark's time (0 if none). Every mark covers only
    /// durable entries, so this includes a mark [`Log::open`](crate::Log::open)
    /// cuts off and writes again.
    pub clock: u64,
    /// What [`Log::open`](crate::Log::open) will cut back.
    pub report: OpenReport,
    /// The log directory as listed: the store appends to the newest
    /// generation and keeps the others' files frozen.
    pub listing: Listing<K>,
    /// The first generation read (older ones weren't).
    pub from_gen: u64,
    pub files: Vec<FileState<K>>,
}

/// A store's log as opening would read it, changing nothing (see [`read`]).
#[derive(Debug)]
pub struct ReadLog<E> {
    /// The game's metadata bytes.
    pub meta: Vec<u8>,
    /// The durable entries, in sequence order.
    pub entries: Vec<LogEntry<E>>,
    /// The latest clock mark's time (0 if none).
    pub clock: u64,
    /// What opening would recover from (no file is cut, so no
    /// [`Truncated::saved`] is set).
    pub report: OpenReport,
}

/// Reads the store in `dir` as [`Log::open`](crate::Log::open) would,
/// changing nothing: for tools and tests that look at a log without
/// taking it over. Takes no lock.
pub fn read<C: LogCodec>(dir: &Path, codec: &C) -> Result<ReadLog<C::Event>, StoreError> {
    let loaded = load(dir, codec, 0, 0)?;
    Ok(ReadLog {
        meta: loaded.meta,
        entries: loaded.entries,
        clock: loaded.clock,
        report: loaded.report,
    })
}

/// The game's metadata bytes in `dir`.
pub(crate) fn read_meta(dir: &Path) -> Result<Vec<u8>, StoreError> {
    let path = dir.join(META_FILE);
    match fs::read(&path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StoreError::Meta {
            path,
            reason: format!("not a store: it has no {META_FILE}"),
        }),
        Err(error) => Err(StoreError::Io { path, error }),
    }
}

/// Reads a store directory, the generations from `from_gen` on, whose
/// entries must all come after entry `after` (0 for the whole log; a game
/// that keeps a base through `after` opens the tail after it). Merges them
/// by sequence and cuts back to the durable prefix, gap-free from
/// `after + 1`. Changes nothing.
pub(crate) fn load<C: LogCodec>(
    dir: &Path,
    codec: &C,
    after: u64,
    from_gen: u64,
) -> Result<Loaded<C::Event, C::Key>, StoreError> {
    let meta = read_meta(dir)?;
    let listing = gens::list(codec, dir)?.strict()?;
    check_generations_listed(&listing, from_gen)?;
    let has_main_log = listing.gens.iter().any(Generation::has_main_log);
    if !has_main_log && listing.gens.len() <= 1 {
        let path = log_dir(dir).join(MAIN_LOG);
        return Err(StoreError::Io {
            path,
            error: std::io::ErrorKind::NotFound.into(),
        });
    }
    let files = read_logs(codec, listing.files_from(from_gen))?;

    let mut seqs: Vec<u64> = files.iter().flat_map(FileLog::seqs).collect();
    seqs.sort_unstable();
    if let Some(pair) = seqs.windows(2).find(|pair| pair[0] == pair[1]) {
        return Err(StoreError::Sequence(format!(
            "entry {} appears twice (two processes wrote the log at once?)",
            pair[0]
        )));
    }
    check_generations(&files)?;
    if let Some(first) = seqs.first().filter(|s| **s <= after) {
        return Err(StoreError::Sequence(format!(
            "entry {first} is in a generation that should start after entry {after}"
        )));
    }
    let batches = check_batches(&files)?;
    // The gap-free prefix.
    let whole = after
        + seqs
            .iter()
            .zip(after + 1..)
            .take_while(|(seq, want)| *seq == want)
            .count() as u64;
    check_marks(&files, whole)?;
    let mut report = OpenReport::default();
    // A batch the prefix ends inside of lost its later entries: the
    // durable log ends before it.
    let partial = batches
        .range(..=whole)
        .next_back()
        .map(|(first, last)| (*first, *last))
        .filter(|(_, last)| whole < *last);
    let mut durable = whole;
    if whole - after < seqs.len() as u64 || partial.is_some() {
        check_lost_tail(&files, whole)?;
        report.missing = Some(whole + 1);
    }
    if let Some((first, last)) = partial {
        if first <= after {
            return Err(StoreError::Sequence(format!(
                "the batch of entries {first} to {last} starts at or before entry {after}"
            )));
        }
        check_marks_before_batch(&files, first, last)?;
        report.partial_batch = Some((first, last));
        durable = first - 1;
    }
    report.dropped = seqs[(durable - after) as usize..].to_vec();

    let mut entries = Vec::with_capacity((durable - after) as usize);
    let mut clock = 0;
    let mut states = Vec::with_capacity(files.len());
    for file in files {
        let (state, file_entries, file_clock) = file.keep_through(durable);
        if state.valid_len < state.file_len {
            report.truncated.push(Truncated {
                path: state.path.clone(),
                from: state.file_len,
                to: state.valid_len,
                saved: None,
            });
        }
        entries.extend(file_entries);
        clock = clock.max(file_clock);
        states.push(state);
    }
    // Sequence numbers are unique (checked above).
    entries.sort_unstable_by_key(|e| e.seq);
    Ok(Loaded {
        meta,
        entries,
        clock,
        report,
        listing,
        from_gen,
        files: states,
    })
}

/// Checks that the generations from `from_gen` on are all there, in
/// order, each but the newest with its `main.log` (a generation is made
/// with one): a generation missing from the middle of the log would read
/// as entries lost.
fn check_generations_listed<K: Clone>(
    listing: &Listing<K>,
    from_gen: u64,
) -> Result<(), StoreError> {
    let newest = listing.newest();
    let mut want = from_gen;
    for g in listing.gens.iter().filter(|g| g.number >= from_gen) {
        if g.number != want {
            return Err(StoreError::Sequence(format!(
                "log generation {want} is missing from log/"
            )));
        }
        if g.number < newest && !g.has_main_log() {
            return Err(StoreError::Sequence(format!(
                "log generation {} has no {MAIN_LOG}",
                g.number
            )));
        }
        want = g.number + 1;
    }
    if want == from_gen && from_gen > 0 {
        return Err(StoreError::Sequence(format!(
            "log generation {from_gen} is missing from log/"
        )));
    }
    Ok(())
}

/// Checks that each generation's entries all come after the older ones':
/// the store never writes an older generation again.
fn check_generations<E, K>(files: &[FileLog<E, K>]) -> Result<(), StoreError> {
    let mut ranges: BTreeMap<u64, (u64, u64)> = BTreeMap::new();
    for file in files {
        if let (Some(first), Some(last)) = (file.seqs().next(), file.seqs().last()) {
            let range = ranges.entry(file.generation).or_insert((first, last));
            range.0 = range.0.min(first);
            range.1 = range.1.max(last);
        }
    }
    let mut before: Option<(u64, u64)> = None;
    for (generation, (first, last)) in ranges {
        if let Some((older, older_last)) = before
            && first <= older_last
        {
            return Err(StoreError::Sequence(format!(
                "log generation {generation} holds entry {first}, but generation {older} \
                 holds entries through {older_last}"
            )));
        }
        before = Some((generation, last));
    }
    Ok(())
}

/// Checks that no clock mark covers an entry after `durable`, the end of
/// the gap-free prefix: a mark is written only once the entries it covers
/// are on disk, so such an entry wasn't lost in a crash.
fn check_marks<E, K>(files: &[FileLog<E, K>], durable: u64) -> Result<(), StoreError> {
    let missing = durable + 1;
    for file in files {
        for item in &file.items {
            if let Item::Clock { time, covers, .. } = item.what
                && covers > durable
            {
                return Err(StoreError::Sequence(format!(
                    "entry {missing} is missing, but the clock mark at {time}, which covers \
                     the entries through {covers}, shows it reached the disk"
                )));
            }
        }
    }
    Ok(())
}

/// The batches the files' batch records name, `first -> last`. Every
/// file's records for a batch must agree, batches can't overlap, and an
/// entry inside a batch must follow its batch record in its file (the
/// writer puts it there in the same write).
fn check_batches<E, K>(files: &[FileLog<E, K>]) -> Result<BTreeMap<u64, u64>, StoreError> {
    let bad = |reason: String| Err(StoreError::Sequence(reason));
    let mut batches: BTreeMap<u64, u64> = BTreeMap::new();
    for file in files {
        for record in &file.items {
            if let Item::Batch { first, last } = record.what
                && let Some(other) = batches.insert(first, last)
                && other != last
            {
                return bad(format!(
                    "batch records disagree: entries {first} to {other}, and {first} to {last}"
                ));
            }
        }
    }
    let mut end = 0;
    for (first, last) in &batches {
        if *first <= end {
            return bad(format!(
                "the batch of entries {first} to {last} overlaps the one before it"
            ));
        }
        end = *last;
    }
    for file in files {
        for record in &file.items {
            if let Item::Entry { entry, batch } = &record.what {
                let within = batches
                    .range(..=entry.seq)
                    .next_back()
                    .filter(|(_, last)| entry.seq <= **last)
                    .map(|(first, last)| (*first, *last));
                if within.is_some() && within != *batch {
                    let (first, last) = within.unwrap_or_default();
                    return Err(StoreError::Corrupt {
                        path: file.path.clone(),
                        offset: record.offset,
                        reason: format!(
                            "entry {} is in the batch of entries {first} to {last}, but no batch \
                             record comes before it in this file",
                            entry.seq
                        ),
                    });
                }
            }
        }
    }
    Ok(batches)
}

/// Checks that no clock mark covers part of the batch `first..=last` that
/// a crash left incomplete: marks are asked for between batches, so one
/// that does is damage.
fn check_marks_before_batch<E, K>(
    files: &[FileLog<E, K>],
    first: u64,
    last: u64,
) -> Result<(), StoreError> {
    for file in files {
        for item in &file.items {
            if let Item::Clock { time, covers, .. } = item.what
                && covers >= first
            {
                return Err(StoreError::Sequence(format!(
                    "the clock mark at {time} covers the entries through {covers}, part of the \
                     batch of entries {first} to {last}, which isn't all there"
                )));
            }
        }
    }
    Ok(())
}

/// Checks that the gap after entry `durable` can be writes lost in an OS
/// crash: the first missing entry must be able to sit at the lost end of
/// some file. (No clock mark covers it; see [`check_marks`].) With several
/// generations, that file's generation must be the one the entry was
/// written in: every older generation's entries come before it, and every
/// newer one's after.
///
/// The file may be gone: a keyed file's name is made durable by the first
/// clock mark after it was created (see the `writer` module), so a crash
/// before that can lose the file, entries and all, while a later entry in
/// another file survives. Such a file holds nothing a mark covers and
/// could be in any generation read, so what is left to check is the
/// generations' order.
fn check_lost_tail<E, K>(files: &[FileLog<E, K>], durable: u64) -> Result<(), StoreError> {
    let missing = durable + 1;
    // Per generation: the first entry after `durable`, and the last entry.
    let mut ranges: BTreeMap<u64, (Option<u64>, u64)> = BTreeMap::new();
    for file in files {
        let range = ranges.entry(file.generation).or_insert((None, 0));
        if let Some(first) = file.seqs().next() {
            range.0 = Some(range.0.map_or(first, |f: u64| f.min(first)));
        }
        range.1 = range.1.max(file.last_seq());
    }
    // Could the entry have been written in generation `generation`?
    let fits = |generation: u64| {
        ranges
            .iter()
            .all(|(g, (first, last))| match g.cmp(&generation) {
                std::cmp::Ordering::Less => *last <= durable,
                std::cmp::Ordering::Greater => first.is_none_or(|s| s > durable),
                std::cmp::Ordering::Equal => true,
            })
    };
    if !ranges.keys().any(|g| fits(*g)) {
        return Err(StoreError::Sequence(format!(
            "entry {missing} is missing, and no log generation could have lost it: for each, \
             an older generation has a later entry or a newer one an earlier entry"
        )));
    }
    Ok(())
}
