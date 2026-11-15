//! A store's whole history read for repair and rollback (the archive's
//! generations and the live ones), and a new store written from part of
//! it: the same generations, entries, batches and clock marks (wall times
//! and all), in the same files.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::archive::{ArchivedFile, read_archive};
use crate::codec::{LogCodec, LogEntry};
use crate::durable::{push_dir, sync_dir};
use crate::error::StoreError;
use crate::format;
use crate::gens::{self, check_file_name, gen_dir};
use crate::hold::Hold;
use crate::log_file::LogFile;
use crate::read::{CodecLog, Item, read_log_prefix};
use crate::writer::write_meta;
use crate::{FileKind, MAIN_LOG, MAX_OPEN_FILES, io_err, log_dir};

/// Every log file of a store, archived generations first, each read up to
/// its first problem.
pub(crate) struct History<C: LogCodec> {
    pub files: Vec<CodecLog<C>>,
    /// Each file's problem, if it has one: `(path, problem)`.
    pub problems: Vec<(PathBuf, StoreError)>,
    /// The generations read from the archive.
    pub archived: Vec<u64>,
}

impl<C: LogCodec> History<C> {
    /// The oldest generation with a file, and the newest.
    pub fn generations(&self) -> (u64, u64) {
        let first = self.files.iter().map(|f| f.generation).min().unwrap_or(0);
        let last = self.files.iter().map(|f| f.generation).max().unwrap_or(0);
        (first, last)
    }

    /// The clock marks, in no particular order: time, what they cover,
    /// wall time.
    pub fn marks(&self) -> impl Iterator<Item = (u64, u64, Option<u64>)> + '_ {
        self.files.iter().flat_map(|f| {
            f.items.iter().filter_map(|r| match r.what {
                Item::Clock { time, covers, wall } => Some((time, covers, wall)),
                _ => None,
            })
        })
    }

    /// The batches the batch records name, `first -> last`.
    pub fn batches(&self) -> BTreeMap<u64, u64> {
        let mut out = BTreeMap::new();
        for file in &self.files {
            for record in &file.items {
                if let Item::Batch { first, last } = record.what {
                    out.insert(first, last);
                }
            }
        }
        out
    }

    /// Every entry, in sequence order (a duplicate sequence number appears
    /// twice).
    pub fn entries(&self) -> Vec<&LogEntry<C::Event>> {
        let mut out: Vec<&LogEntry<C::Event>> = self
            .files
            .iter()
            .flat_map(|f| {
                f.items.iter().filter_map(|r| match &r.what {
                    Item::Entry { entry, .. } => Some(entry),
                    _ => None,
                })
            })
            .collect();
        out.sort_by_key(|e| e.seq);
        out
    }
}

/// Reads the store in `dir`: its archived generations, then the live ones
/// (a live generation also in the archive, left by an archiving cut
/// short, is read from the archive). Changes nothing.
pub(crate) fn read_history<C: LogCodec>(dir: &Path, codec: &C) -> Result<History<C>, StoreError> {
    let mut files = Vec::new();
    let mut problems = Vec::new();
    let mut archived = Vec::new();
    for archived_file in read_archive(dir, codec, ..)? {
        let ArchivedFile {
            generation,
            path,
            key,
            bytes,
        } = archived_file;
        let kind = key.map_or(FileKind::Main, FileKind::Keyed);
        if !archived.contains(&generation) {
            archived.push(generation);
        }
        let (mut file, problem) = read_log_prefix(codec, path.clone(), kind, &bytes);
        file.generation = generation;
        if let Some(problem) = problem {
            problems.push((path, problem));
        }
        files.push(file);
    }
    let listing = gens::list(codec, dir)?;
    for path in &listing.unknown {
        problems.push((
            path.clone(),
            StoreError::Meta {
                path: path.clone(),
                reason: "unexpected file in the log directory".into(),
            },
        ));
    }
    for (path, kind, generation) in listing.files_from(0) {
        if archived.contains(&generation) {
            continue;
        }
        let bytes = fs::read(&path).map_err(io_err(&path))?;
        let (mut file, problem) = read_log_prefix(codec, path.clone(), kind, &bytes);
        file.generation = generation;
        if let Some(problem) = problem {
            problems.push((path, problem));
        }
        files.push(file);
    }
    Ok(History {
        files,
        problems,
        archived,
    })
}

/// One thing a copy writes to a generation.
enum Step<E> {
    /// Entries appended together: a batch if `batch` names one.
    Entries {
        batch: Option<(u64, u64)>,
        entries: Vec<LogEntry<E>>,
    },
    /// A clock mark.
    Mark {
        time: u64,
        covers: u64,
        wall: Option<u64>,
    },
}

/// What a copy holds of a [`History`]: per generation, in order.
pub(crate) struct Plan<E> {
    gens: BTreeMap<u64, Vec<Step<E>>>,
}

impl<E> Plan<E> {
    /// The newest generation with something in it.
    pub fn last_generation(&self) -> Option<u64> {
        self.gens
            .iter()
            .rev()
            .find(|(_, steps)| !steps.is_empty())
            .map(|(g, _)| *g)
    }
}

/// The plan of a copy of `files` holding the entries through `keep` (each
/// once: the first file read wins a duplicate) and the clock marks that
/// cover no more.
pub(crate) fn plan<C: LogCodec>(files: Vec<CodecLog<C>>, keep: u64) -> Plan<C::Event> {
    // Per generation: (seq or covers, 0 for an entry or 1 for a mark,
    // order) to the step, so a mark follows the entry it covers through.
    type Key = (u64, u8, usize);
    let mut gens: BTreeMap<u64, BTreeMap<Key, Item<C::Event>>> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut order = 0;
    for file in files {
        let generation = gens.entry(file.generation).or_default();
        for record in file.items {
            order += 1;
            match record.what {
                Item::Entry { entry, batch } if entry.seq <= keep && seen.insert(entry.seq) => {
                    generation.insert((entry.seq, 0, 0), Item::Entry { entry, batch });
                }
                Item::Clock { time, covers, wall } if covers <= keep => {
                    generation.insert((covers, 1, order), Item::Clock { time, covers, wall });
                }
                _ => {}
            }
        }
    }
    let gens = gens
        .into_iter()
        .map(|(generation, items)| {
            let mut steps: Vec<Step<C::Event>> = Vec::new();
            for item in items.into_values() {
                match item {
                    Item::Entry { entry, batch } => match steps.last_mut() {
                        Some(Step::Entries {
                            batch: Some(b),
                            entries,
                        }) if batch == Some(*b) => entries.push(entry),
                        _ => steps.push(Step::Entries {
                            batch,
                            entries: vec![entry],
                        }),
                    },
                    Item::Clock { time, covers, wall } => {
                        steps.push(Step::Mark { time, covers, wall })
                    }
                    _ => {}
                }
            }
            (generation, steps)
        })
        .collect();
    Plan { gens }
}

/// Writes a new store in `out` (which must not exist, or be empty) holding
/// `meta` and `plan`'s generations `first..=last` (each with a
/// `main.log`, even if the plan has nothing for it; `log/` without one if
/// `first > 0`), all durable, `store.meta` last.
pub(crate) fn write_copy<C: LogCodec>(
    out: &Path,
    codec: &C,
    meta: &[u8],
    plan: Plan<C::Event>,
    first: u64,
    last: u64,
) -> Result<(), StoreError> {
    make_empty_dir(out)?;
    let logs = log_dir(out);
    fs::create_dir(&logs).map_err(io_err(&logs))?;
    let hold = Hold::unused();
    let mut plan = plan.gens;
    for generation in first..=last {
        let gdir = gen_dir(out, generation);
        if generation > 0 {
            fs::create_dir(&gdir).map_err(io_err(&gdir))?;
        }
        let mut main = LogFile::create(gdir.join(MAIN_LOG), &hold)?;
        let mut keyed: BTreeMap<C::Key, LogFile> = BTreeMap::new();
        for step in plan.remove(&generation).unwrap_or_default() {
            match step {
                Step::Mark { time, covers, wall } => {
                    let mut bytes = Vec::new();
                    format::push_mark(&mut bytes, time, covers, wall);
                    main.write(&bytes, &hold)?;
                }
                Step::Entries { batch, entries } => {
                    let mut written: Vec<Option<C::Key>> = Vec::new();
                    for entry in &entries {
                        let key = codec.key(&entry.event);
                        let first_here = !written.contains(&key);
                        if first_here {
                            written.push(key.clone());
                        }
                        let file = match &key {
                            None => &mut main,
                            Some(k) => {
                                if !keyed.contains_key(k) {
                                    let name = check_file_name(codec, k)?;
                                    keyed.insert(
                                        k.clone(),
                                        LogFile::create(gdir.join(name), &hold)?,
                                    );
                                }
                                keyed.get_mut(k).expect("made above")
                            }
                        };
                        file.append_entry(entry, batch.filter(|_| first_here), codec, &hold)?;
                    }
                    if keyed.values().filter(|f| f.file.is_some()).count() > MAX_OPEN_FILES {
                        push_and_close(keyed.values_mut())?;
                    }
                }
            }
        }
        push_and_close(keyed.values_mut())?;
        push_and_close(std::iter::once(&mut main))?;
        push_dir(&gdir)?;
    }
    sync_dir(&logs)?;
    write_meta(out, meta)
}

/// Hands each file's writes to the drive and closes it (the copy's last
/// full sync makes them durable).
fn push_and_close<'a>(files: impl Iterator<Item = &'a mut LogFile>) -> Result<(), StoreError> {
    for file in files {
        if file.dirty {
            file.push()?;
            file.dirty = false;
        }
        file.close();
    }
    Ok(())
}

/// Makes `dir` an empty directory: creates it, or checks that it is one.
pub(crate) fn make_empty_dir(dir: &Path) -> Result<(), StoreError> {
    match fs::read_dir(dir) {
        Ok(mut items) => {
            if items.next().is_some() {
                return Err(StoreError::Exists(dir.to_path_buf()));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dir).map_err(io_err(dir))?;
            if let Some(parent) = dir.parent() {
                sync_dir(parent)?;
            }
            Ok(())
        }
        Err(error) => Err(StoreError::Io {
            path: dir.to_path_buf(),
            error,
        }),
    }
}
