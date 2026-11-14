//! Checking a store and repairing one that won't open.
//!
//! [`check`] says, changing nothing, whether a store opens, what is wrong
//! with each file, and what a repair would keep. [`repair`] writes a new
//! log holding the longest prefix of entries it can trust: gap-free from
//! the log's start, each entry once, ending between batches (a batch is
//! all or none), and through no entry the game refuses ([`repair_with`]).
//! Each file is read up to its first problem (damage, a record that
//! doesn't decode, an entry in the wrong file); the clock marks that cover
//! no more than what is kept are kept, wall times and all. The new log has
//! the same generations, batches and files as the old.
//!
//! A repair writes a copy, or works in place ([`Output::InPlace`]): the
//! old log is then moved to `recovered/`, never destroyed.

use std::path::{Path, PathBuf};

use crate::OpenReport;
use crate::codec::{LogCodec, LogEntry};
use crate::copy::{History, plan, read_history, write_copy};
use crate::error::StoreError;
use crate::load::{load, read_meta};
use crate::lock::{Holder, holder};
use crate::swap::{Output, write_output};

/// One log file, as [`check`] read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSummary {
    /// The file (where it is, or was before it was archived).
    pub path: PathBuf,
    /// Its log generation.
    pub generation: u64,
    /// True if it is read from the archive.
    pub archived: bool,
    /// The entries it holds, up to its first problem.
    pub entries: usize,
    /// Its first and last entries, if any.
    pub range: Option<(u64, u64)>,
    /// Its length, and where its readable prefix ends.
    pub len: u64,
    /// Where its readable prefix ends.
    pub valid_len: u64,
    /// Its first problem, if any.
    pub problem: Option<String>,
}

/// What a repair keeps of a log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Salvage {
    /// The entry before the oldest one the log holds (0 unless old
    /// generations were pruned from the archive).
    pub after: u64,
    /// The last entry kept.
    pub keep: u64,
    /// The last entry found anywhere.
    pub found: u64,
    /// The latest kept clock mark's time (0 if none).
    pub clock: u64,
    /// Why entries after `keep` aren't kept, in the order found (empty if
    /// the whole log is kept).
    pub reasons: Vec<String>,
}

/// What [`check`] found.
#[derive(Debug)]
pub struct CheckReport {
    /// Who holds the store's lock, if anyone.
    pub holder: Option<Holder>,
    /// Every file, archived ones first.
    pub files: Vec<FileSummary>,
    /// What opening the live log would recover, or why it won't open.
    pub open: Result<OpenReport, StoreError>,
    /// What a repair would keep.
    pub salvage: Salvage,
}

impl CheckReport {
    /// True if the store opens with nothing to recover and every entry
    /// found would be kept.
    pub fn is_clean(&self) -> bool {
        self.open.as_ref().is_ok_and(OpenReport::is_clean)
            && self.files.iter().all(|f| f.problem.is_none())
            && self.salvage.reasons.is_empty()
    }
}

/// An entry the game refused during a repair ([`repair_with`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    /// The entry.
    pub seq: u64,
    /// Why.
    pub reason: String,
}

/// What [`repair`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepairReport {
    /// What it kept, and why it kept no more.
    pub salvage: Salvage,
    /// The entry the game refused, if it refused one.
    pub refused: Option<Refused>,
    /// In place: where the old log (and archive) went, in `recovered/`.
    pub moved: Option<PathBuf>,
}

/// Checks the store in `dir`, changing nothing (and taking no lock).
pub fn check<C: LogCodec>(dir: &Path, codec: &C) -> Result<CheckReport, StoreError> {
    read_meta(dir)?;
    let history = read_history(dir, codec)?;
    let files = summaries(&history);
    // The live log opens after the archive's last entry, from its oldest
    // live generation.
    let (salvage, _) = salvage(&history, |_| Ok(()));
    // (After a pruned archive, it starts after the entry before its first.)
    let archived_last = history
        .files
        .iter()
        .filter(|f| history.archived.contains(&f.generation))
        .map(|f| f.last_seq())
        .max()
        .unwrap_or(salvage.after);
    let from_gen = history
        .files
        .iter()
        .map(|f| f.generation)
        .filter(|g| !history.archived.contains(g))
        .min()
        .unwrap_or(0);
    let open = load(dir, codec, archived_last, from_gen).map(|l| l.report);
    Ok(CheckReport {
        holder: holder(dir),
        files,
        open,
        salvage,
    })
}

/// Repairs the store in `dir` (see the module docs): writes the log a
/// repair keeps where `output` says.
pub fn repair<C: LogCodec>(
    dir: &Path,
    codec: &C,
    output: Output<'_>,
) -> Result<RepairReport, StoreError> {
    repair_with(dir, codec, output, |_| Ok(()))
}

/// [`repair`], keeping no entry `accept` refuses, or any after it (it sees
/// each entry a repair would otherwise keep, in order, and may replay
/// them: an entry the game can't apply ends the log just before it, or
/// before its batch).
pub fn repair_with<C: LogCodec>(
    dir: &Path,
    codec: &C,
    output: Output<'_>,
    accept: impl FnMut(&LogEntry<C::Event>) -> Result<(), String>,
) -> Result<RepairReport, StoreError> {
    let meta = read_meta(dir)?;
    let history = read_history(dir, codec)?;
    let (salvage, refused) = salvage(&history, accept);
    let (first, last) = history.generations();
    let plan = plan::<C>(history.files, salvage.keep);
    let ((), moved) = write_output(dir, output, "repair", |out| {
        write_copy(out, codec, &meta, plan, first, last)
    })?;
    Ok(RepairReport {
        salvage,
        refused,
        moved,
    })
}

fn summaries<C: LogCodec>(history: &History<C>) -> Vec<FileSummary> {
    history
        .files
        .iter()
        .map(|f| {
            let mut seqs = f.seqs();
            let first = seqs.next();
            let entries = first.map_or(0, |_| 1 + seqs.count());
            FileSummary {
                path: f.path.clone(),
                generation: f.generation,
                archived: history.archived.contains(&f.generation),
                entries,
                range: first.map(|first| (first, f.last_seq())),
                len: f.file_len,
                valid_len: f.valid_len,
                problem: history
                    .problems
                    .iter()
                    .find(|(p, _)| *p == f.path)
                    .map(|(_, e)| e.to_string()),
            }
        })
        .collect()
}

/// What a repair of `history` keeps (see the module docs), and the entry
/// `accept` refused, if any.
pub(crate) fn salvage<C: LogCodec>(
    history: &History<C>,
    mut accept: impl FnMut(&LogEntry<C::Event>) -> Result<(), String>,
) -> (Salvage, Option<Refused>) {
    let mut reasons: Vec<String> = history
        .problems
        .iter()
        .map(|(path, e)| format!("{}: {e}", path.display()))
        .collect();
    let entries = history.entries();
    let found = entries.last().map_or(0, |e| e.seq);
    // The log starts at entry 1, unless its oldest generations were pruned
    // from the archive.
    let (first_gen, _) = history.generations();
    let after = match entries.first() {
        Some(e) if first_gen > 0 => e.seq - 1,
        _ => 0,
    };
    let mut keep = after;
    let mut refused = None;
    let mut i = 0;
    while i < entries.len() {
        let seq = entries[i].seq;
        let copies = entries[i..].iter().take_while(|e| e.seq == seq).count();
        if seq != keep + 1 {
            reasons.push(format!("entry {} is missing", keep + 1));
            break;
        }
        if copies > 1 {
            reasons.push(format!("entry {seq} appears {copies} times"));
            break;
        }
        if let Err(reason) = accept(entries[i]) {
            reasons.push(format!("the game refused entry {seq}: {reason}"));
            refused = Some(Refused { seq, reason });
            break;
        }
        keep = seq;
        i += 1;
    }
    let batches = history.batches();
    if let Some((first, last)) = batches.range(..=keep).next_back()
        && keep < *last
    {
        reasons.push(format!(
            "the batch of entries {first} to {last} isn't whole, so entries {first} to {keep} \
             aren't kept"
        ));
        keep = first - 1;
    }
    let mut clock = 0;
    for (time, covers, _) in history.marks() {
        if covers <= keep {
            clock = clock.max(time);
        } else {
            reasons.push(format!(
                "the clock mark at {time} covers the entries through {covers}, past those kept"
            ));
        }
    }
    reasons.dedup();
    (
        Salvage {
            after,
            keep,
            found,
            clock,
            reasons,
        },
        refused,
    )
}
