//! Rolling a store back: a new log holding the entries through an earlier
//! point, with the clock marks that cover no more (see [`rollback`]).
//!
//! The point never splits a batch: a rollback into one goes back to just
//! before it. It may reach into the archive; the generations before the
//! oldest one archived (or live) are gone, and so is any point before
//! them. A game that keeps bases must not open the rolled-back store from
//! a base past the point.

use std::path::{Path, PathBuf};

use crate::codec::LogCodec;
use crate::copy::{plan, read_history, write_copy};
use crate::error::StoreError;
use crate::load::read_meta;
use crate::salvage::salvage;
use crate::swap::{Output, write_output};

/// Where a rollback goes back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollbackTo {
    /// Through this entry.
    Seq(u64),
    /// Through the last entry at or before this game time.
    Time(u64),
    /// Through what the latest clock mark asked for at or before this wall
    /// time (seconds since the Unix epoch) covers.
    Wall(u64),
}

/// What [`rollback`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RollbackReport {
    /// The entry before the oldest one the log holds (0 unless old
    /// generations were pruned from the archive).
    pub after: u64,
    /// The last entry kept.
    pub kept: u64,
    /// The last entry the log held before.
    pub was: u64,
    /// The latest kept clock mark's time (0 if none): the rolled-back
    /// store's clock.
    pub clock: u64,
    /// In place: where the old log (and archive) went, in `recovered/`.
    pub moved: Option<PathBuf>,
}

/// Rolls the store in `dir` back to `to`, writing the new log where
/// `output` says. The log read must be whole (what opening would keep, a
/// crash's lost tail aside): a damaged one is repaired first
/// ([`crate::repair`]).
pub fn rollback<C: LogCodec>(
    dir: &Path,
    codec: &C,
    to: RollbackTo,
    output: Output<'_>,
) -> Result<RollbackReport, StoreError> {
    let meta = read_meta(dir)?;
    let history = read_history(dir, codec)?;
    if let Some((_, problem)) = history.problems.into_iter().next() {
        return Err(problem);
    }
    let history = crate::copy::History {
        problems: Vec::new(),
        ..history
    };
    let (whole, _) = salvage(&history, |_| Ok(()));
    let after = whole.after;
    let target = match to {
        RollbackTo::Seq(seq) => seq,
        RollbackTo::Time(time) => history
            .entries()
            .iter()
            .take_while(|e| e.time <= time)
            .last()
            .map_or(after, |e| e.seq),
        RollbackTo::Wall(wall) => history
            .marks()
            .filter(|(_, _, w)| w.is_some_and(|w| w <= wall))
            .map(|(_, covers, _)| covers)
            .max()
            .ok_or_else(|| {
                StoreError::Sequence(format!(
                    "no clock mark the log holds was asked for at or before wall time {wall}"
                ))
            })?,
    };
    if target < after {
        return Err(StoreError::Sequence(format!(
            "entry {target} is gone: the log holds the entries after {after}"
        )));
    }
    let mut kept = target.min(whole.keep);
    if let Some((first, last)) = history.batches().range(..=kept).next_back()
        && kept < *last
    {
        kept = first - 1;
    }
    let clock = history
        .marks()
        .filter(|(_, covers, _)| *covers <= kept)
        .map(|(time, _, _)| time)
        .max()
        .unwrap_or(0);
    let (first, _) = history.generations();
    // The generations through the one the kept log ends in.
    let plan = plan::<C>(history.files, kept);
    let last = plan.last_generation().unwrap_or(first).max(first);
    let ((), moved) = write_output(dir, output, "rollback", |out| {
        write_copy(out, codec, &meta, plan, first, last)
    })?;
    Ok(RollbackReport {
        after,
        kept,
        was: whole.keep,
        clock,
        moved,
    })
}
