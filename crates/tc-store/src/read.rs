//! Decoding log files into records ([`FileLog`]), each file independent (its
//! own name table), on several threads.
//!
//! Kind-3 clock records (a mark that doesn't name what it covers) are read
//! but never written: one covers every entry before it in `main.log`. See
//! the `format` module.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::codec::{LogCodec, LogEntry, NameTable};
use crate::error::StoreError;
use crate::format::{
    self, HEADER_LEN, KIND_BATCH, KIND_CLOCK, KIND_ENTRY, KIND_MARK, KIND_NAME, KIND_WALL_MARK,
};
use crate::log_file::FileState;
use crate::{FileKind, io_err};

/// One record of a log file, decoded.
pub(crate) enum Item<E> {
    Name {
        local: u32,
        name: String,
    },
    /// An entry, and the batch it is in (by the batch record before it in
    /// its file), if any.
    Entry {
        entry: LogEntry<E>,
        batch: Option<(u64, u64)>,
    },
    /// A clock mark, the last entry it covers, and the wall time it was
    /// asked for (seconds since the Unix epoch; kind-3 marks have none).
    Clock {
        time: u64,
        covers: u64,
        wall: Option<u64>,
    },
    /// The entries `first..=last` are one batch.
    Batch {
        first: u64,
        last: u64,
    },
}

/// A decoded record, where it starts, and the offset just past it.
pub(crate) struct Record<E> {
    pub offset: u64,
    pub end: u64,
    pub what: Item<E>,
}

/// A log file's intact records.
pub(crate) struct FileLog<E, K> {
    pub path: PathBuf,
    pub kind: FileKind<K>,
    /// The log generation it is in.
    pub generation: u64,
    pub valid_len: u64,
    pub file_len: u64,
    pub items: Vec<Record<E>>,
}

/// A file decoded by codec `C`.
pub(crate) type CodecLog<C> = FileLog<<C as LogCodec>::Event, <C as LogCodec>::Key>;

impl<E, K> FileLog<E, K> {
    pub fn seqs(&self) -> impl Iterator<Item = u64> + '_ {
        self.items.iter().filter_map(|r| match &r.what {
            Item::Entry { entry, .. } => Some(entry.seq),
            _ => None,
        })
    }

    /// The file's last (and largest) sequence number, or 0.
    pub fn last_seq(&self) -> u64 {
        self.seqs().last().unwrap_or(0)
    }

    /// Keeps the records up to the last entry at or before `durable`. Name
    /// and batch records are written together with the entry after them,
    /// so those right before a dropped entry go with it, and so does a
    /// batch record for entries after `durable` that none of them follow.
    /// Returns the latest clock mark's time among all records, kept or not
    /// (each covers only durable entries; see `load::check_marks`).
    pub fn keep_through(self, durable: u64) -> (FileState<K>, Vec<LogEntry<E>>, u64) {
        let all = self.items.len();
        let mut keep = self
            .items
            .iter()
            .position(|r| match &r.what {
                Item::Entry { entry, .. } => entry.seq > durable,
                Item::Batch { first, .. } => *first > durable,
                _ => false,
            })
            .unwrap_or(all);
        let mut valid_len = self.valid_len;
        if keep < all {
            while keep > 0
                && matches!(
                    self.items[keep - 1].what,
                    Item::Name { .. } | Item::Batch { .. }
                )
            {
                keep -= 1;
            }
            valid_len = match keep {
                0 => HEADER_LEN as u64,
                n => self.items[n - 1].end,
            };
        }
        let mut names = HashMap::new();
        let mut entries = Vec::new();
        let mut clock = 0;
        // The latest mark cut off.
        let mut cut: Option<(u64, u64, Option<u64>)> = None;
        for (i, record) in self.items.into_iter().enumerate() {
            match record.what {
                Item::Name { local, name } if i < keep => {
                    names.insert(name, local);
                }
                Item::Entry { entry, .. } if i < keep => entries.push(entry),
                Item::Clock { time, .. } if i < keep => clock = clock.max(time),
                Item::Clock { time, covers, wall } if cut.is_none_or(|(t, _, _)| time >= t) => {
                    cut = Some((time, covers, wall));
                }
                _ => {}
            }
        }
        let restore = cut.filter(|(time, _, _)| *time > clock);
        let state = FileState {
            path: self.path,
            kind: self.kind,
            generation: self.generation,
            has_entries: !entries.is_empty(),
            valid_len,
            file_len: self.file_len,
            names,
            restore,
        };
        let clock = restore.map_or(clock, |(time, _, _)| time);
        (state, entries, clock)
    }
}

/// Reads and decodes log files, in their order, on several threads (each
/// file is independent: its own name table). Fails with the first failure
/// in the files' order, as reading them one by one would.
pub(crate) fn read_logs<C: LogCodec>(
    codec: &C,
    files: Vec<(PathBuf, FileKind<C::Key>, u64)>,
) -> Result<Vec<CodecLog<C>>, StoreError> {
    par_map(files, |(path, kind, generation)| {
        let bytes = fs::read(&path).map_err(io_err(&path))?;
        let mut file = read_log(codec, path, kind, &bytes)?;
        file.generation = generation;
        Ok(file)
    })
    .into_iter()
    .collect()
}

/// The most threads [`par_map`] runs on.
const DECODE_THREADS: usize = 8;

/// `f` of every item, in the items' order, on up to [`DECODE_THREADS`]
/// threads (round-robin, so big and small items spread evenly).
pub(crate) fn par_map<T: Send, R: Send>(items: Vec<T>, f: impl Fn(T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(DECODE_THREADS)
        .min(items.len());
    if threads <= 1 {
        return items.into_iter().map(f).collect();
    }
    let mut shares: Vec<Vec<(usize, T)>> = (0..threads).map(|_| Vec::new()).collect();
    for (i, item) in items.into_iter().enumerate() {
        shares[i % threads].push((i, item));
    }
    let f = &f;
    let mut done: Vec<(usize, R)> = std::thread::scope(|s| {
        let workers: Vec<_> = shares
            .into_iter()
            .map(|share| {
                s.spawn(move || {
                    share
                        .into_iter()
                        .map(|(i, item)| (i, f(item)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|w| match w.join() {
                Ok(done) => done,
                Err(panic) => std::panic::resume_unwind(panic),
            })
            .collect()
    });
    done.sort_by_key(|(i, _)| *i);
    done.into_iter().map(|(_, r)| r).collect()
}

pub(crate) fn read_log<C: LogCodec>(
    codec: &C,
    path: PathBuf,
    kind: FileKind<C::Key>,
    bytes: &[u8],
) -> Result<FileLog<C::Event, C::Key>, StoreError> {
    match read_log_prefix(codec, path, kind, bytes) {
        (file, None) => Ok(file),
        (_, Some(error)) => Err(error),
    }
}

/// Reads a log file's records up to the first problem: the records before
/// it, and the problem, if any (damage before the tail, or a record that
/// doesn't decode or doesn't belong). `valid_len` ends at the problem.
pub(crate) fn read_log_prefix<C: LogCodec>(
    codec: &C,
    path: PathBuf,
    kind: FileKind<C::Key>,
    bytes: &[u8],
) -> (FileLog<C::Event, C::Key>, Option<StoreError>) {
    let corrupt = |offset: u64, reason: String| StoreError::Corrupt {
        path: path.clone(),
        offset,
        reason,
    };
    let (scan, damage) = format::scan_prefix(bytes);
    let mut error = damage.map(|(offset, reason)| corrupt(offset, reason));
    let mut valid_len = scan.valid_len as u64;
    let is_main = matches!(kind, FileKind::Main);

    let mut table = NameTable::default();
    let mut items: Vec<Record<C::Event>> = Vec::new();
    let mut last_seq = 0;
    // The last entry the marks so far cover.
    let mut covered = 0;
    // The latest batch record.
    let mut batch: Option<(u64, u64)> = None;
    let mut decode = |record: &format::RawRecord| -> Result<Item<C::Event>, StoreError> {
        let bad = |reason: String| corrupt(record.offset, reason);
        let mark = |covered: &mut u64, time: u64, covers: u64, wall: Option<u64>| {
            if covers < *covered {
                return Err(bad(format!(
                    "a clock mark covering the entries through {covers} follows one \
                     covering those through {covered}"
                )));
            }
            *covered = covers;
            Ok(Item::Clock { time, covers, wall })
        };
        let what = match record.kind {
            KIND_NAME => {
                let (local, name) = format::decode_name(record.payload).map_err(bad)?;
                if !table.define(local, name.clone()) {
                    return Err(bad(format!("name id {local} is defined twice")));
                }
                Item::Name { local, name }
            }
            KIND_ENTRY => {
                let (seq, time, rest) = format::decode_entry_head(record.payload).map_err(bad)?;
                let event = codec.decode(rest, &table).map_err(bad)?;
                if last_seq >= seq {
                    return Err(bad(format!("entry {seq} is out of order")));
                }
                last_seq = seq;
                let belongs = match (&kind, codec.key(&event)) {
                    (FileKind::Main, None) => true,
                    (FileKind::Keyed(k), Some(key)) => *k == key,
                    _ => false,
                };
                if !belongs {
                    return Err(bad(format!("entry {seq} is in the wrong log file")));
                }
                let batch = batch.filter(|(first, last)| (*first..=*last).contains(&seq));
                Item::Entry {
                    entry: LogEntry { seq, time, event },
                    batch,
                }
            }
            KIND_BATCH => {
                let (first, last) = format::decode_batch(record.payload).map_err(bad)?;
                if first <= last_seq || batch.is_some_and(|(_, end)| first <= end) {
                    return Err(bad(format!(
                        "the batch of entries {first} to {last} starts before an earlier entry \
                         or batch in this file"
                    )));
                }
                batch = Some((first, last));
                Item::Batch { first, last }
            }
            // It covers every entry before it in this file.
            KIND_CLOCK if is_main => {
                let time = format::decode_clock(record.payload).map_err(bad)?;
                let covers = covered.max(last_seq);
                mark(&mut covered, time, covers, None)?
            }
            KIND_MARK if is_main => {
                let (time, covers) = format::decode_mark(record.payload).map_err(bad)?;
                mark(&mut covered, time, covers, None)?
            }
            KIND_WALL_MARK if is_main => {
                let (time, covers, wall) = format::decode_wall_mark(record.payload).map_err(bad)?;
                mark(&mut covered, time, covers, Some(wall))?
            }
            other => return Err(bad(format!("unexpected record kind {other}"))),
        };
        Ok(what)
    };
    for record in &scan.records {
        match decode(record) {
            Ok(what) => items.push(Record {
                offset: record.offset,
                end: record.end,
                what,
            }),
            Err(e) => {
                // Earlier in the file than any damage the scan found.
                error = Some(e);
                valid_len = record.offset;
                break;
            }
        }
    }
    let file = FileLog {
        path,
        kind,
        generation: 0,
        valid_len,
        file_len: bytes.len() as u64,
        items,
    };
    (file, error)
}
