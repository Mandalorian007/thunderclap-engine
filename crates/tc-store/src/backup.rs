//! An online backup: a copy of a store taken while its log is appended to,
//! that opens cleanly ([`backup`]).
//!
//! The store only appends, so a backup reads each file's bytes as far as
//! they go, with no lock: every `main.log` first, then (listing again, for
//! files made meanwhile) every keyed file. A clock mark read from a
//! `main.log` was written after every entry it covers was on disk, and so
//! is in the keyed files read after it. The copy then keeps the gap-free
//! prefix of entries that ends between batches, cutting each file just
//! before its first record past it: what opening the copy would keep, so
//! it opens with nothing to recover. Reading needs no codec (an entry's
//! sequence number is in its record's head).
//!
//! A file can vanish while it is read (the archive took its generation):
//! the backup then starts again, at most [`TRIES`] times.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::archive::{ARCHIVE_DIR, write_durable};
use crate::copy::make_empty_dir;
use crate::durable::sync_dir;
use crate::error::StoreError;
use crate::format::{self, KIND_BATCH, KIND_CLOCK, KIND_ENTRY, KIND_MARK, KIND_WALL_MARK};
use crate::load::read_meta;
use crate::writer::write_meta;
use crate::{MAIN_LOG, io_err, log_dir};

/// How many times a backup starts again when a file vanishes under it.
pub const TRIES: u32 = 3;

/// What [`backup`] copied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupReport {
    /// The log files copied.
    pub files: usize,
    /// Their bytes.
    pub bytes: u64,
    /// The last entry the copy holds (the entry before its first if it
    /// holds none).
    pub last_seq: u64,
    /// The archive's files copied (none unless asked for).
    pub archive_files: usize,
    /// How many times it started.
    pub tries: u32,
}

/// Copies the store in `dir` to `out` (which must not exist, or be empty),
/// while it may be appended to: see the module docs. With `archive`, the
/// archive too, byte for byte. Everything copied is durable, `store.meta`
/// last.
pub fn backup(dir: &Path, out: &Path, archive: bool) -> Result<BackupReport, StoreError> {
    let meta = read_meta(dir)?;
    let mut tries = 0;
    loop {
        tries += 1;
        match read_files(dir) {
            Ok(files) => {
                let (last_seq, files) = cut(files)?;
                make_empty_dir(out)?;
                let (count, bytes) = write_files(out, &files)?;
                let archive_files = if archive {
                    copy_tree(&dir.join(ARCHIVE_DIR), &out.join(ARCHIVE_DIR))?
                } else {
                    0
                };
                write_meta(out, &meta)?;
                return Ok(BackupReport {
                    files: count,
                    bytes,
                    last_seq,
                    archive_files,
                    tries,
                });
            }
            Err(e) if tries < TRIES && is_vanished(&e) => continue,
            Err(e) => return Err(e),
        }
    }
}

fn is_vanished(e: &StoreError) -> bool {
    matches!(e, StoreError::Io { error, .. } if error.kind() == std::io::ErrorKind::NotFound)
}

/// One file read: its path relative to the store directory, and bytes.
struct Raw {
    rel: PathBuf,
    bytes: Vec<u8>,
}

/// Every log file under `dir/log`, as `(relative path, is a main.log)`:
/// `.log` files in `log/` and in `log/g<n>/`.
fn list(dir: &Path) -> Result<Vec<(PathBuf, bool)>, StoreError> {
    let logs = log_dir(dir);
    let mut out = Vec::new();
    for item in fs::read_dir(&logs).map_err(io_err(&logs))? {
        let item = item.map_err(io_err(&logs))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if item.file_type().map_err(io_err(&item.path()))?.is_dir() {
            if name.starts_with('g') {
                let sub = item.path();
                for inner in fs::read_dir(&sub).map_err(io_err(&sub))? {
                    let inner = inner.map_err(io_err(&sub))?;
                    let file = inner.file_name().to_string_lossy().into_owned();
                    if file.ends_with(".log") && !file.starts_with('.') {
                        out.push((
                            PathBuf::from("log").join(&name).join(&file),
                            file == MAIN_LOG,
                        ));
                    }
                }
            }
        } else if name.ends_with(".log") {
            out.push((PathBuf::from("log").join(&name), name == MAIN_LOG));
        }
    }
    out.sort();
    Ok(out)
}

/// Reads every `main.log`, then every other log file (see the module
/// docs).
fn read_files(dir: &Path) -> Result<Vec<Raw>, StoreError> {
    let read = |rel: &Path| -> Result<Raw, StoreError> {
        let path = dir.join(rel);
        let bytes = fs::read(&path).map_err(io_err(&path))?;
        Ok(Raw {
            rel: rel.to_path_buf(),
            bytes,
        })
    };
    let mut files: Vec<Raw> = Vec::new();
    for (rel, main) in list(dir)? {
        if main {
            files.push(read(&rel)?);
        }
    }
    // Listed again: a generation made meanwhile has its `main.log` read
    // before its keyed files too.
    let mut rest = list(dir)?;
    rest.retain(|(rel, _)| !files.iter().any(|f| f.rel == *rel));
    rest.sort_by_key(|(_, main)| !*main);
    for (rel, _) in rest {
        files.push(read(&rel)?);
    }
    Ok(files)
}

/// What a record is, to a backup.
enum Rec {
    Entry(u64),
    Batch(u64),
    Mark(u64),
    Other,
}

/// Cuts each file just before its first record past the kept prefix (see
/// the module docs). Returns the last entry kept.
fn cut(mut files: Vec<Raw>) -> Result<(u64, Vec<Raw>), StoreError> {
    let mut parsed: Vec<Vec<(u64, u64, Rec)>> = Vec::new();
    let mut seqs: Vec<u64> = Vec::new();
    let mut batches: BTreeMap<u64, u64> = BTreeMap::new();
    let mut marks: Vec<u64> = Vec::new();
    for file in &files {
        let (scan, damage) = format::scan_prefix(&file.bytes);
        if let Some((offset, reason)) = damage {
            return Err(StoreError::Corrupt {
                path: file.rel.clone(),
                offset,
                reason: format!("{reason} (repair the store before backing it up)"),
            });
        }
        let corrupt = |offset: u64, reason: String| StoreError::Corrupt {
            path: file.rel.clone(),
            offset,
            reason,
        };
        let mut recs = Vec::new();
        let mut last_seq = 0;
        for r in &scan.records {
            let rec = match r.kind {
                KIND_ENTRY => {
                    let (seq, _, _) =
                        format::decode_entry_head(r.payload).map_err(|e| corrupt(r.offset, e))?;
                    seqs.push(seq);
                    Rec::Entry(seq)
                }
                KIND_BATCH => {
                    let (first, last) =
                        format::decode_batch(r.payload).map_err(|e| corrupt(r.offset, e))?;
                    batches.insert(first, last);
                    Rec::Batch(first)
                }
                KIND_MARK => {
                    let (_, covers) =
                        format::decode_mark(r.payload).map_err(|e| corrupt(r.offset, e))?;
                    marks.push(covers);
                    Rec::Mark(covers)
                }
                KIND_WALL_MARK => {
                    let (_, covers, _) =
                        format::decode_wall_mark(r.payload).map_err(|e| corrupt(r.offset, e))?;
                    marks.push(covers);
                    Rec::Mark(covers)
                }
                // Covers every entry before it in this file.
                KIND_CLOCK => Rec::Mark(last_seq),
                _ => Rec::Other,
            };
            if let Rec::Entry(seq) = rec {
                last_seq = seq;
            }
            recs.push((r.offset, r.end, rec));
        }
        parsed.push(recs);
    }
    seqs.sort_unstable();
    let after = seqs.first().map_or(0, |s| s - 1);
    let mut keep = after;
    for seq in &seqs {
        if *seq != keep + 1 {
            break;
        }
        keep = *seq;
    }
    if let Some((first, last)) = batches.range(..=keep).next_back()
        && keep < *last
    {
        keep = first - 1;
    }
    if let Some(covers) = marks.iter().find(|c| **c > keep) {
        return Err(StoreError::Sequence(format!(
            "a clock mark covers the entries through {covers}, but the copy holds them only \
             through {keep} (was the log written by two processes?)"
        )));
    }
    for (file, recs) in files.iter_mut().zip(&parsed) {
        let end = recs
            .iter()
            .find(|(_, _, rec)| match rec {
                Rec::Entry(seq) => *seq > keep,
                Rec::Batch(first) => *first > keep,
                Rec::Mark(covers) => *covers > keep,
                Rec::Other => false,
            })
            .map_or_else(
                || recs.last().map_or(0, |(_, end, _)| *end),
                |(offset, _, _)| *offset,
            ) as usize;
        let end = end.max(format::HEADER_LEN.min(file.bytes.len()));
        file.bytes.truncate(end);
        if file.bytes.len() < format::HEADER_LEN {
            // A file made just now, its header not all written.
            file.bytes = format::header().to_vec();
        }
    }
    Ok((keep, files))
}

/// Writes the files under `out`, each durable, with their directories.
fn write_files(out: &Path, files: &[Raw]) -> Result<(usize, u64), StoreError> {
    let mut dirs: Vec<PathBuf> = vec![log_dir(out)];
    fs::create_dir_all(log_dir(out)).map_err(io_err(&log_dir(out)))?;
    let mut bytes = 0;
    for file in files {
        let path = out.join(&file.rel);
        if let Some(parent) = path.parent()
            && !dirs.iter().any(|d| d == parent)
        {
            fs::create_dir_all(parent).map_err(io_err(parent))?;
            dirs.push(parent.to_path_buf());
        }
        write_durable(&path, &file.bytes)?;
        bytes += file.bytes.len() as u64;
    }
    // Generation directories first, then `log/`.
    for d in dirs.iter().rev() {
        sync_dir(d)?;
    }
    Ok((files.len(), bytes))
}

/// Copies the tree at `from` (if there is one) to `to`, skipping names
/// that start with `.`, every file durable. Returns how many files.
fn copy_tree(from: &Path, to: &Path) -> Result<usize, StoreError> {
    let items = match fs::read_dir(from) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(StoreError::Io {
                path: from.to_path_buf(),
                error,
            });
        }
    };
    fs::create_dir_all(to).map_err(io_err(to))?;
    let mut count = 0;
    for item in items {
        let item = item.map_err(io_err(from))?;
        let name = item.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = item.path();
        if item.file_type().map_err(io_err(&path))?.is_dir() {
            count += copy_tree(&path, &to.join(&name))?;
        } else {
            let bytes = fs::read(&path).map_err(io_err(&path))?;
            write_durable(&to.join(&name), &bytes)?;
            count += 1;
        }
    }
    sync_dir(to)?;
    Ok(count)
}
