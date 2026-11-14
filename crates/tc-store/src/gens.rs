//! Log generations: `log/` holds generation 0's files, and each rotation
//! ([`crate::Log::rotate`]) starts a new generation in `log/g<n>/`.
//!
//! Generation `n + 1` starts after the entry its rotation was cut at:
//! generation `n + 1` holds only entries after it, and generation `n` none
//! after it. Every generation has its own `main.log` (clock marks and the
//! entries without a file key) and keyed files, each with its own name
//! table, in the same format. Appends go to the newest generation; older
//! ones are never written again. A game that writes a base (a snapshot of
//! its state through a generation) opens from the next one
//! ([`crate::Log::open_from`]), not reading the old ones.
//!
//! A generation directory may be empty, or hold only header-only files (a
//! rotation cut short): it holds no entries, and the store appends to it
//! if it is the newest.

use std::fs;
use std::path::{Path, PathBuf};

use crate::codec::LogCodec;
use crate::error::StoreError;
use crate::{FileKind, MAIN_LOG, io_err, log_dir};

/// The directory generation `generation` of the store in `dir` keeps its
/// files in: `log/` for generation 0, `log/g<n>/` after.
pub fn gen_dir(dir: &Path, generation: u64) -> PathBuf {
    match generation {
        0 => log_dir(dir),
        n => log_dir(dir).join(format!("g{n}")),
    }
}

/// The generation a name in `log/` is the directory of (`g<n>`, `n >= 1`,
/// written without leading zeros), if it is one.
fn parse_gen_name(name: &str) -> Option<u64> {
    let n: u64 = name.strip_prefix('g')?.parse().ok()?;
    (n >= 1 && format!("g{n}") == name).then_some(n)
}

/// One generation's log files.
#[derive(Clone, Debug)]
pub(crate) struct Generation<K> {
    pub number: u64,
    /// Its files, `main.log` first if it has one, then the keyed files by
    /// name.
    pub files: Vec<(PathBuf, FileKind<K>)>,
}

impl<K> Generation<K> {
    /// True if it has a `main.log`.
    pub fn has_main_log(&self) -> bool {
        self.files.iter().any(|(_, k)| matches!(k, FileKind::Main))
    }
}

/// A store's log directory, listed.
#[derive(Clone, Debug)]
pub(crate) struct Listing<K> {
    /// Every generation, oldest first; generation 0 (`log/` itself) is
    /// always there.
    pub gens: Vec<Generation<K>>,
    /// Names that are neither log files nor generation directories (or log
    /// files in the wrong place), by path.
    pub unknown: Vec<PathBuf>,
}

impl<K: Clone> Listing<K> {
    /// The newest generation's number.
    pub fn newest(&self) -> u64 {
        self.gens.last().map_or(0, |g| g.number)
    }

    /// Every file of the generations `from` and newer, in generation
    /// order, with its generation.
    pub fn files_from(&self, from: u64) -> Vec<(PathBuf, FileKind<K>, u64)> {
        self.gens
            .iter()
            .filter(|g| g.number >= from)
            .flat_map(|g| {
                g.files
                    .iter()
                    .map(|(p, k)| (p.clone(), k.clone(), g.number))
            })
            .collect()
    }

    /// Fails on the first unknown name, as opening a store does: it can't
    /// tell what such a file is for.
    pub fn strict(self) -> Result<Listing<K>, StoreError> {
        match self.unknown.first() {
            Some(path) => Err(StoreError::Meta {
                path: path.clone(),
                reason: "unexpected file in the log directory".into(),
            }),
            None => Ok(self),
        }
    }
}

/// One generation's directory listed: its log files, and anything else by
/// path.
type DirFiles<K> = (Vec<(PathBuf, FileKind<K>)>, Vec<PathBuf>);

/// The log files in `dir` (one generation's directory): `main.log` and
/// keyed files, and anything else by path. Names starting with `.` are
/// skipped; so are generation directories, when `gens` takes them.
fn list_files<C: LogCodec>(
    codec: &C,
    dir: &Path,
    mut gens: Option<&mut Vec<(u64, PathBuf)>>,
) -> Result<DirFiles<C::Key>, StoreError> {
    let mut listing: Vec<(String, PathBuf, bool)> = Vec::new();
    for item in fs::read_dir(dir).map_err(io_err(dir))? {
        let item = item.map_err(io_err(dir))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = item.file_type().map_err(io_err(&item.path()))?.is_dir();
        listing.push((name, item.path(), is_dir));
    }
    listing.sort();
    let mut files = Vec::new();
    let mut main = None;
    let mut unknown = Vec::new();
    for (name, path, is_dir) in listing {
        if is_dir {
            match (parse_gen_name(&name), gens.as_deref_mut()) {
                (Some(n), Some(gens)) => gens.push((n, path)),
                _ => unknown.push(path),
            }
        } else if name == MAIN_LOG {
            main = Some(path);
        } else if let Some(key) = keyed_name(codec, &name) {
            files.push((path, FileKind::Keyed(key)));
        } else {
            unknown.push(path);
        }
    }
    if let Some(path) = main {
        files.insert(0, (path, FileKind::Main));
    }
    Ok((files, unknown))
}

/// The key `name` is the file of, if the codec names it so and gives the
/// same name back for it.
pub(crate) fn keyed_name<C: LogCodec>(codec: &C, name: &str) -> Option<C::Key> {
    let key = codec.parse_file_name(name)?;
    (codec.file_name(&key) == name).then_some(key)
}

/// Checks a name the codec gives for a key (see [`LogCodec::file_name`]).
pub(crate) fn check_file_name<C: LogCodec>(codec: &C, key: &C::Key) -> Result<String, StoreError> {
    let name = codec.file_name(key);
    let bad = if !name.ends_with(".log") {
        Some("doesn't end in .log")
    } else if name == MAIN_LOG {
        Some("is the main log's")
    } else if name.starts_with('.') {
        Some("starts with a dot")
    } else if name.contains(['/', '\\']) || name.contains(std::path::MAIN_SEPARATOR) {
        Some("holds a path separator")
    } else if keyed_name(codec, &name).as_ref() != Some(key) {
        Some("doesn't read back as its key")
    } else {
        None
    };
    match bad {
        Some(why) => Err(StoreError::Sequence(format!(
            "the codec's file name {name:?} for {key:?} {why}"
        ))),
        None => Ok(name),
    }
}

/// Lists the store in `dir`'s log directory: every generation and its
/// files, changing nothing.
pub(crate) fn list<C: LogCodec>(codec: &C, dir: &Path) -> Result<Listing<C::Key>, StoreError> {
    let logs = log_dir(dir);
    let mut dirs = Vec::new();
    let (files, mut unknown) = list_files(codec, &logs, Some(&mut dirs))?;
    dirs.sort();
    let mut gens = vec![Generation { number: 0, files }];
    for (number, path) in dirs {
        let (files, more) = list_files(codec, &path, None)?;
        unknown.extend(more);
        gens.push(Generation { number, files });
    }
    Ok(Listing { gens, unknown })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_names() {
        assert_eq!(parse_gen_name("g1"), Some(1));
        assert_eq!(parse_gen_name("g42"), Some(42));
        for bad in ["g0", "g01", "g", "g-1", "gx", "G1", "g1.log"] {
            assert_eq!(parse_gen_name(bad), None, "{bad}");
        }
        let dir = Path::new("/w");
        assert_eq!(gen_dir(dir, 0), Path::new("/w/log"));
        assert_eq!(gen_dir(dir, 3), Path::new("/w/log/g3"));
    }
}
