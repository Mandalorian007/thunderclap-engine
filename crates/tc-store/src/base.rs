//! A game's bases: snapshots of its state through an entry, so opening
//! replays only the log after it ([`crate::Log::open_from`]) and the
//! generations below it can be archived ([`crate::tidy`]).
//!
//! The bytes are the game's; the store keeps the files, in `base/`, each
//! named for the generation its tail starts in and the last entry it
//! covers (`g<generation>-<after>.base`), written whole and durable
//! (through a temporary name and a rename) or not at all. The store moves
//! them with the log it belongs to: a backup copies them (before the log,
//! so each copied base's tail is in the copy), and a repair or rollback in
//! place moves them to `recovered/` with the old log (the new log holds
//! the whole history, so the game opens it from the start).

use std::fs;
use std::path::{Path, PathBuf};

use crate::archive::write_durable;
use crate::durable::sync_dir;
use crate::error::StoreError;
use crate::io_err;

/// The bases' directory in a store directory.
pub const BASE_DIR: &str = "base";

/// One base file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseFile {
    /// The generation its tail starts in.
    pub generation: u64,
    /// The last entry it covers.
    pub after: u64,
    /// Its path.
    pub path: PathBuf,
}

fn file_name(generation: u64, after: u64) -> String {
    format!("g{generation}-{after}.base")
}

fn parse_name(name: &str) -> Option<(u64, u64)> {
    let rest = name.strip_prefix('g')?.strip_suffix(".base")?;
    let (generation, after) = rest.split_once('-')?;
    let (generation, after) = (generation.parse().ok()?, after.parse().ok()?);
    (file_name(generation, after) == name).then_some((generation, after))
}

/// The bases of the store in `dir`, newest (greatest `after`) first.
/// Files named otherwise (a write cut short) are left out.
pub fn bases(dir: &Path) -> Result<Vec<BaseFile>, StoreError> {
    let root = dir.join(BASE_DIR);
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err(&root)(e)),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(io_err(&root))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some((generation, after)) = parse_name(&name) {
            out.push(BaseFile {
                generation,
                after,
                path: entry.path(),
            });
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse((b.after, b.generation)));
    Ok(out)
}

/// Writes a base of the store in `dir`: `bytes`, the game's state through
/// entry `after`, whose tail starts in generation `generation`. Every
/// entry through `after` must be durable first ([`crate::sync_frozen`]
/// on the cut its rotation returned). Durable when it returns; waits for
/// the disk, so a game runs it off its loop ([`crate::Log::background`]).
pub fn write_base(
    dir: &Path,
    generation: u64,
    after: u64,
    bytes: &[u8],
) -> Result<BaseFile, StoreError> {
    let root = dir.join(BASE_DIR);
    let created = !root.exists();
    fs::create_dir_all(&root).map_err(io_err(&root))?;
    if created {
        sync_dir(dir)?;
    }
    let name = file_name(generation, after);
    let tmp = root.join(format!(".{name}.tmp"));
    write_durable(&tmp, bytes)?;
    let path = root.join(&name);
    fs::rename(&tmp, &path).map_err(io_err(&path))?;
    sync_dir(&root)?;
    Ok(BaseFile {
        generation,
        after,
        path,
    })
}

/// Removes every base of the store in `dir` but the newest `keep`, and
/// what a write cut short left; returns the bases kept, newest first.
pub fn prune_bases(dir: &Path, keep: usize) -> Result<Vec<BaseFile>, StoreError> {
    let all = bases(dir)?;
    let root = dir.join(BASE_DIR);
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name.ends_with(".tmp") {
                let path = entry.path();
                fs::remove_file(&path).map_err(io_err(&path))?;
            }
        }
    }
    for old in all.iter().skip(keep) {
        fs::remove_file(&old.path).map_err(io_err(&old.path))?;
    }
    if all.len() > keep {
        sync_dir(&root)?;
    }
    Ok(all.into_iter().take(keep).collect())
}

/// Reads the bases of the store in `dir`, for a backup.
pub(crate) fn read_bases(dir: &Path) -> Result<Vec<(BaseFile, Vec<u8>)>, StoreError> {
    let mut read = Vec::new();
    for base in bases(dir)? {
        match fs::read(&base.path) {
            Ok(bytes) => read.push((base, bytes)),
            // Pruned meanwhile: a newer one is listed too.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err(&base.path)(e)),
        }
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_odd_ones_are_ignored() {
        assert_eq!(parse_name(&file_name(3, 120)), Some((3, 120)));
        assert_eq!(parse_name("g03-120.base"), None);
        assert_eq!(parse_name(".g3-120.base.tmp"), None);
        assert_eq!(parse_name("g3-120.base.z"), None);
    }

    #[test]
    fn bases_are_listed_newest_first_and_pruned_to_a_count() {
        let dir = std::env::temp_dir().join(format!("tc-store-bases-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(bases(&dir).unwrap().is_empty());
        for (g, after) in [(1, 10), (3, 30), (2, 20)] {
            write_base(&dir, g, after, &[g as u8]).unwrap();
        }
        fs::write(dir.join(BASE_DIR).join(".g4-40.base.tmp"), b"torn").unwrap();
        let listed: Vec<u64> = bases(&dir).unwrap().iter().map(|b| b.after).collect();
        assert_eq!(listed, [30, 20, 10]);
        let kept = prune_bases(&dir, 2).unwrap();
        assert_eq!(
            kept.iter().map(|b| b.generation).collect::<Vec<_>>(),
            [3, 2]
        );
        assert_eq!(fs::read_dir(dir.join(BASE_DIR)).unwrap().count(), 2);
        assert_eq!(fs::read(&kept[0].path).unwrap(), [3]);
        let _ = fs::remove_dir_all(&dir);
    }
}
