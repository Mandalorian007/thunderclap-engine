//! The archive: old log generations, deflated, kept a while and then
//! pruned on their own ([`tidy`]).
//!
//! A game that writes a base (its state through a generation) opens from
//! the generation after it ([`crate::Log::open_from`]) and never reads the
//! older ones again; [`tidy`] moves them out of `log/` into
//! `archive/g<n>/`, one deflated file per log file (`<name>.z`) and an
//! `info` file, so rollback, repair and history can still reach them
//! (`crate::rollback`, `crate::repair`). Archived generations are kept for
//! [`ArchivePolicy::keep_days`] after their last clock mark, and the
//! archive as a whole under [`ArchivePolicy::max_bytes`]: past either, the
//! oldest go first. `tidy` also prunes `recovered/` past the same window.
//!
//! Each step is safe to cut short: a generation is written to
//! `archive/.g<n>.tmp/`, made durable and renamed to `archive/g<n>/` before
//! its live files are moved to a `.del` directory and removed; anything
//! pruned is renamed to a `.del` name first. `tidy` finishes or clears
//! what a cut-short run left (names starting with `.`, which nothing else
//! reads) before it does anything else.
//!
//! A deflated file is `"TCZ1" u64:len zlib(bytes)` (little-endian).

use std::fs;
use std::ops::RangeBounds;
use std::path::{Path, PathBuf};

use crate::codec::LogCodec;
use crate::durable::{self, sync_dir};
use crate::error::StoreError;
use crate::format::{self, KIND_ENTRY, KIND_WALL_MARK};
use crate::gens::{self, gen_dir};
use crate::{FileKind, MAIN_LOG, RECOVERED_DIR, crash, io_err, log_dir, unix_now};

/// The archive's directory in a store directory.
pub const ARCHIVE_DIR: &str = "archive";

/// The magic that starts a deflated file.
const MAGIC: &[u8; 4] = b"TCZ1";

/// The deflate level: zlib's default, a good trade of time for size.
const LEVEL: u8 = 6;

/// Seconds in a day.
const DAY: u64 = 24 * 60 * 60;

/// How long the archive keeps things, and how big it may get.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchivePolicy {
    /// Days an archived generation is kept after its last clock mark (and
    /// a file in `recovered/` after it was saved).
    pub keep_days: u64,
    /// The most bytes the archive holds: past it, the oldest generations
    /// go first.
    pub max_bytes: u64,
}

impl Default for ArchivePolicy {
    /// A week, and 1 GiB.
    fn default() -> ArchivePolicy {
        ArchivePolicy {
            keep_days: 7,
            max_bytes: 1 << 30,
        }
    }
}

/// What [`tidy`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tidied {
    /// Generations moved from `log/` into the archive.
    pub archived: Vec<u64>,
    /// Archived generations removed.
    pub pruned: Vec<u64>,
    /// Entries removed from `recovered/`.
    pub recovered_pruned: Vec<PathBuf>,
    /// Leftovers of a cut-short run finished or cleared.
    pub leftovers: Vec<PathBuf>,
    /// The archive's size after, in bytes.
    pub bytes: u64,
}

/// One archived generation, as [`summary`] lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Archived {
    /// Its number.
    pub generation: u64,
    /// The first and last entries it holds (`None` if it holds none).
    pub entries: Option<(u64, u64)>,
    /// Its latest clock mark's wall time (seconds since the Unix epoch),
    /// or when it was archived if it has none.
    pub wall: u64,
    /// Its deflated size, in bytes.
    pub bytes: u64,
}

/// The archived generations of the store in `dir`, oldest first.
pub fn summary(dir: &Path) -> Result<Vec<Archived>, StoreError> {
    let root = dir.join(ARCHIVE_DIR);
    let mut out = Vec::new();
    for (generation, path) in archived_dirs(&root)? {
        out.push(read_info(&path, generation)?);
    }
    Ok(out)
}

/// Archives the generations of the store in `dir` below `below` (never the
/// newest, which the store appends to), then prunes the archive and
/// `recovered/` by `policy`. A game calls it after writing a base whose
/// tail starts in generation `below` (and [`crate::Log::note_base`]), with
/// `below` no greater than [`crate::Log::durable_below`]: the store never
/// reads or writes those generations again, so `tidy` may run while the
/// log is open, on its [`crate::Background`] thread. Waits for the disk.
pub fn tidy<C: LogCodec>(
    dir: &Path,
    codec: &C,
    below: u64,
    policy: &ArchivePolicy,
) -> Result<Tidied, StoreError> {
    let mut tidied = Tidied {
        leftovers: clear_leftovers(dir)?,
        ..Tidied::default()
    };
    let root = dir.join(ARCHIVE_DIR);
    let listing = gens::list(codec, dir)?;
    let below = below.min(listing.newest());
    let done: Vec<u64> = archived_dirs(&root)?.into_iter().map(|(g, _)| g).collect();
    for generation in listing.gens.iter().filter(|g| g.number < below) {
        // Nothing to archive (already archived, or archived and pruned).
        if generation.files.is_empty() {
            continue;
        }
        let names: Vec<(String, PathBuf)> = generation
            .files
            .iter()
            .map(|(path, _)| (file_name(path), path.clone()))
            .collect();
        if !done.contains(&generation.number) {
            archive_generation(&root, generation.number, &names)?;
        }
        crash::point("tidy.archived");
        remove_live(dir, generation.number, &names)?;
        tidied.archived.push(generation.number);
    }
    prune(&root, policy, &mut tidied)?;
    prune_recovered(dir, policy, &mut tidied)?;
    tidied.bytes = summary(dir)?.iter().map(|a| a.bytes).sum();
    Ok(tidied)
}

/// An archived log file, inflated ([`read_archive`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchivedFile<K> {
    /// Its generation.
    pub generation: u64,
    /// The path it had in `log/`.
    pub path: PathBuf,
    /// Its key, or `None` for the generation's `main.log`.
    pub key: Option<K>,
    /// Its bytes, as they were in `log/` (read them with
    /// [`crate::format::Reader`]).
    pub bytes: Vec<u8>,
}

/// The files of the archived generations of the store in `dir` that are
/// in `generations`, inflated: oldest generation first, each's `main.log`
/// first, then its keyed files by name. For a game's own history or
/// tools; [`summary`] lists the generations without inflating them.
pub fn read_archive<C: LogCodec>(
    dir: &Path,
    codec: &C,
    generations: impl RangeBounds<u64>,
) -> Result<Vec<ArchivedFile<C::Key>>, StoreError> {
    let mut out = Vec::new();
    for (generation, path) in archived_dirs(&dir.join(ARCHIVE_DIR))?
        .into_iter()
        .filter(|(g, _)| generations.contains(g))
    {
        let mut files = Vec::new();
        for item in fs::read_dir(&path).map_err(io_err(&path))? {
            let item = item.map_err(io_err(&path))?;
            let name = item.file_name().to_string_lossy().into_owned();
            let Some(log_name) = name.strip_suffix(".z") else {
                continue;
            };
            let kind = if log_name == MAIN_LOG {
                FileKind::Main
            } else {
                match gens::keyed_name(codec, log_name) {
                    Some(key) => FileKind::Keyed(key),
                    None => {
                        return Err(StoreError::Meta {
                            path: item.path(),
                            reason: "an archived file the codec doesn't name".into(),
                        });
                    }
                }
            };
            files.push((log_name.to_string(), item.path(), kind));
        }
        // `main.log` first, then the keyed files by name, as in `log/`.
        files.sort_by(|a, b| {
            (!matches!(a.2, FileKind::Main), &a.0).cmp(&(!matches!(b.2, FileKind::Main), &b.0))
        });
        for (log_name, zpath, kind) in files {
            let bytes = inflate(&fs::read(&zpath).map_err(io_err(&zpath))?).map_err(|reason| {
                StoreError::Corrupt {
                    path: zpath.clone(),
                    offset: 0,
                    reason,
                }
            })?;
            out.push(ArchivedFile {
                generation,
                path: gen_dir(dir, generation).join(log_name),
                key: match kind {
                    FileKind::Main => None,
                    FileKind::Keyed(key) => Some(key),
                },
                bytes,
            });
        }
    }
    Ok(out)
}

/// The archived generations' directories in `root`, oldest first.
pub(crate) fn archived_dirs(root: &Path) -> Result<Vec<(u64, PathBuf)>, StoreError> {
    let mut out = Vec::new();
    let items = match fs::read_dir(root) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(error) => {
            return Err(StoreError::Io {
                path: root.to_path_buf(),
                error,
            });
        }
    };
    for item in items {
        let item = item.map_err(io_err(root))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if let Some(n) = parse_archived(&name) {
            out.push((n, item.path()));
        }
    }
    out.sort();
    Ok(out)
}

/// `g<n>` (`n >= 0`, no leading zeros) in the archive.
fn parse_archived(name: &str) -> Option<u64> {
    let n: u64 = name.strip_prefix('g')?.parse().ok()?;
    (format!("g{n}") == name).then_some(n)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

/// Deflates `bytes` into the archive's format.
pub(crate) fn deflate(bytes: &[u8]) -> Vec<u8> {
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(bytes, LEVEL));
    out
}

/// Inflates what [`deflate`] wrote.
pub(crate) fn inflate(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 12 || &bytes[..4] != MAGIC {
        return Err("not an archived log file".into());
    }
    let mut len = [0; 8];
    len.copy_from_slice(&bytes[4..12]);
    let len = usize::try_from(u64::from_le_bytes(len))
        .map_err(|_| "an archived file too long to read".to_string())?;
    let out = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&bytes[12..], len)
        .map_err(|e| format!("an archived file doesn't inflate: {e:?}"))?;
    if out.len() != len {
        return Err(format!(
            "an archived file inflates to {} bytes, not {len}",
            out.len()
        ));
    }
    Ok(out)
}

/// Writes generation `generation`'s files (`names`: file name and live
/// path) into `root/g<n>/`, durable, through a temporary directory.
fn archive_generation(
    root: &Path,
    generation: u64,
    names: &[(String, PathBuf)],
) -> Result<(), StoreError> {
    let created = !root.exists();
    fs::create_dir_all(root).map_err(io_err(root))?;
    if created && let Some(parent) = root.parent() {
        sync_dir(parent)?;
    }
    let tmp = root.join(format!(".g{generation}.tmp"));
    if tmp.exists() {
        fs::remove_dir_all(&tmp).map_err(io_err(&tmp))?;
    }
    fs::create_dir(&tmp).map_err(io_err(&tmp))?;
    let mut entries: Option<(u64, u64)> = None;
    let mut wall = None;
    let mut bytes = 0;
    for (name, path) in names {
        let raw = fs::read(path).map_err(io_err(path))?;
        let (scan, _) = format::scan_prefix(&raw);
        for record in &scan.records {
            match record.kind {
                KIND_ENTRY => {
                    if let Ok((seq, _, _)) = format::decode_entry_head(record.payload) {
                        entries =
                            Some(entries.map_or((seq, seq), |(a, b)| (a.min(seq), b.max(seq))));
                    }
                }
                KIND_WALL_MARK => {
                    if let Ok((_, _, w)) = format::decode_wall_mark(record.payload) {
                        wall = Some(wall.map_or(w, |v: u64| v.max(w)));
                    }
                }
                _ => {}
            }
        }
        let out = tmp.join(format!("{name}.z"));
        let deflated = deflate(&raw);
        bytes += deflated.len() as u64;
        write_durable(&out, &deflated)?;
    }
    let info = Archived {
        generation,
        entries,
        wall: wall.unwrap_or_else(unix_now),
        bytes,
    };
    write_durable(&tmp.join("info"), write_info(&info).as_bytes())?;
    sync_dir(&tmp)?;
    crash::point("tidy.tmp");
    let to = root.join(format!("g{generation}"));
    fs::rename(&tmp, &to).map_err(io_err(&to))?;
    sync_dir(root)
}

/// Writes `bytes` to a new file at `path` and makes it durable.
pub(crate) fn write_durable(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(io_err(path))?;
    file.write_all(bytes).map_err(io_err(path))?;
    durable::full(&file, path).map_err(io_err(path))
}

fn write_info(info: &Archived) -> String {
    let (first, last) = info.entries.unwrap_or((0, 0));
    format!(
        "entries {} {first} {last}\nwall {}\nbytes {}\n",
        u8::from(info.entries.is_some()),
        info.wall,
        info.bytes
    )
}

fn read_info(path: &Path, generation: u64) -> Result<Archived, StoreError> {
    let file = path.join("info");
    let text = fs::read_to_string(&file).map_err(io_err(&file))?;
    let bad = || StoreError::Meta {
        path: file.clone(),
        reason: "an archived generation's info doesn't read".into(),
    };
    let mut info = Archived {
        generation,
        entries: None,
        wall: 0,
        bytes: 0,
    };
    for line in text.lines() {
        let words: Vec<&str> = line.split(' ').collect();
        let num = |i: usize| {
            words
                .get(i)
                .and_then(|w| w.parse::<u64>().ok())
                .ok_or_else(bad)
        };
        match words.first() {
            Some(&"entries") => {
                info.entries = (num(1)? == 1).then_some((num(2)?, num(3)?));
            }
            Some(&"wall") => info.wall = num(1)?,
            Some(&"bytes") => info.bytes = num(1)?,
            _ => {}
        }
    }
    Ok(info)
}

/// Moves generation `generation`'s live files into a `.del` directory in
/// `log/`, durable, and removes it: the archive holds them now.
fn remove_live(dir: &Path, generation: u64, names: &[(String, PathBuf)]) -> Result<(), StoreError> {
    let logs = log_dir(dir);
    let del = logs.join(format!(".g{generation}.del"));
    if generation == 0 {
        // Generation 0's files are in `log/` itself, beside the others'
        // directories.
        if names.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&del).map_err(io_err(&del))?;
        for (name, path) in names {
            let to = del.join(name);
            fs::rename(path, &to).map_err(io_err(&to))?;
        }
    } else {
        let live = gen_dir(dir, generation);
        if !live.exists() {
            return Ok(());
        }
        fs::rename(&live, &del).map_err(io_err(&del))?;
    }
    sync_dir(&logs)?;
    crash::point("tidy.moved");
    fs::remove_dir_all(&del).map_err(io_err(&del))
}

/// Finishes or clears what a cut-short [`tidy`] left: a `.tmp` archive
/// directory (not yet renamed: removed), `.del` directories (removed).
/// Returns what it removed. Opening a store calls it too.
pub(crate) fn clear_leftovers(dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let mut leftovers = Vec::new();
    for parent in [dir.join(ARCHIVE_DIR), log_dir(dir)] {
        let Ok(items) = fs::read_dir(&parent) else {
            continue;
        };
        for item in items {
            let item = item.map_err(io_err(&parent))?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with(".g") && (name.ends_with(".tmp") || name.ends_with(".del")) {
                let path = item.path();
                fs::remove_dir_all(&path).map_err(io_err(&path))?;
                leftovers.push(path);
            }
        }
    }
    Ok(leftovers)
}

/// Fails if the archive of the store in `dir` isn't the log's own (live
/// as `listing` lists it): a store created over another's leftovers, or an
/// archive copied in. Such an archive holds the generation appended to or
/// a newer one, which is never archived, or a generation whose live copy
/// (left by an archiving cut short) holds other records; reading it
/// (history, rollback, repair) would read another log, and [`tidy`] would
/// take the live copy for a leftover and remove it.
pub(crate) fn check_archive_is_the_logs<K: Clone>(
    dir: &Path,
    listing: &gens::Listing<K>,
) -> Result<(), StoreError> {
    let root = dir.join(ARCHIVE_DIR);
    let archived = archived_dirs(&root)?;
    let Some((last, _)) = archived.last() else {
        return Ok(());
    };
    let foreign = |why: String| {
        Err(StoreError::Meta {
            path: root.clone(),
            reason: format!(
                "{why}: not this log's archive (a store created over another's leftovers, or \
                 an archive copied in?); move it aside to open the store"
            ),
        })
    };
    let newest = listing.newest();
    if *last >= newest {
        return foreign(format!(
            "it holds log generation {last}, but the log is appended to in generation {newest}"
        ));
    }
    for (generation, path) in &archived {
        let Some(live) = listing.gens.iter().find(|g| g.number == *generation) else {
            continue;
        };
        for (file, _) in &live.files {
            let Some(bytes) = read_if_there(file)? else {
                continue;
            };
            let z = path.join(format!("{}.z", file_name(file)));
            if bytes.len() <= format::HEADER_LEN {
                continue;
            }
            let Some(stored) = read_if_there(&z)? else {
                continue;
            };
            let archived = inflate(&stored).map_err(|reason| StoreError::Corrupt {
                path: z.clone(),
                offset: 0,
                reason,
            })?;
            if !archived.starts_with(&bytes) && !bytes.starts_with(&archived) {
                return foreign(format!(
                    "its log generation {generation} differs from the live copy {}",
                    file.display()
                ));
            }
        }
    }
    Ok(())
}

/// A file's bytes, or `None` if it isn't there.
fn read_if_there(path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(StoreError::Io {
            path: path.to_path_buf(),
            error,
        }),
    }
}

/// Removes the oldest archived generations while the oldest is past
/// `keep_days` or the archive is over `max_bytes`.
fn prune(root: &Path, policy: &ArchivePolicy, tidied: &mut Tidied) -> Result<(), StoreError> {
    let mut all = Vec::new();
    for (generation, path) in archived_dirs(root)? {
        all.push((read_info(&path, generation)?, path));
    }
    let mut total: u64 = all.iter().map(|(a, _)| a.bytes).sum();
    let cutoff = unix_now().saturating_sub(policy.keep_days.saturating_mul(DAY));
    for (info, path) in all {
        if info.wall >= cutoff && total <= policy.max_bytes {
            break;
        }
        let del = root.join(format!(".g{}.del", info.generation));
        fs::rename(&path, &del).map_err(io_err(&del))?;
        sync_dir(root)?;
        crash::point("tidy.prune");
        fs::remove_dir_all(&del).map_err(io_err(&del))?;
        total -= info.bytes;
        tidied.pruned.push(info.generation);
    }
    Ok(())
}

/// Removes what `recovered/` has held past `keep_days`.
fn prune_recovered(
    dir: &Path,
    policy: &ArchivePolicy,
    tidied: &mut Tidied,
) -> Result<(), StoreError> {
    let recovered = dir.join(RECOVERED_DIR);
    let Ok(items) = fs::read_dir(&recovered) else {
        return Ok(());
    };
    let cutoff = unix_now().saturating_sub(policy.keep_days.saturating_mul(DAY));
    let mut removed = false;
    for item in items {
        let item = item.map_err(io_err(&recovered))?;
        let path = item.path();
        let modified = fs::symlink_metadata(&path)
            .and_then(|m| m.modified())
            .map_err(io_err(&path))?;
        let secs = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        if secs < cutoff {
            if item.file_type().map_err(io_err(&path))?.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            }
            .map_err(io_err(&path))?;
            tidied.recovered_pruned.push(path);
            removed = true;
        }
    }
    if removed {
        sync_dir(&recovered)?;
    }
    Ok(())
}
