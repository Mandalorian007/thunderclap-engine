//! The store's tests, on a small test codec ([`Tables`]): events in the
//! main log, and events keyed by a table number in a file per table.
//! Fixtures are made fresh by each test, in a temporary directory.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use crate::format::{self, KIND_MARK, KIND_WALL_MARK, Reader, Writer};
use crate::{LogCodec, LogEntry, NameTable, Names};

mod fit;
mod gens;
mod hold;
mod log;
mod marks;
mod ops;
mod read_only;
mod recovery;

/// The test game's events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Ev {
    /// In the main log.
    Say(String),
    /// A piece put on a table: keyed by the table, the piece's name in the
    /// file's name table.
    Put { table: u32, piece: String, at: i32 },
    /// Raw bytes, keyed by a table or in the main log.
    Blob { table: Option<u32>, bytes: Vec<u8> },
    /// Fails to encode.
    Unencodable,
}

/// The test codec: table `n`'s events go to `t.<n>.log`.
pub(crate) struct Tables;

impl LogCodec for Tables {
    type Event = Ev;
    type Key = u32;

    fn key(&self, event: &Ev) -> Option<u32> {
        match event {
            Ev::Put { table, .. } => Some(*table),
            Ev::Blob { table, .. } => *table,
            Ev::Say(_) | Ev::Unencodable => None,
        }
    }

    fn file_name(&self, key: &u32) -> String {
        format!("t.{key}.log")
    }

    fn parse_file_name(&self, name: &str) -> Option<u32> {
        let key: u32 = name
            .strip_prefix("t.")?
            .strip_suffix(".log")?
            .parse()
            .ok()?;
        (self.file_name(&key) == name).then_some(key)
    }

    fn encode(&self, event: &Ev, names: &mut Names<'_>, out: &mut Vec<u8>) -> Result<(), String> {
        let mut w = Writer::default();
        match event {
            Ev::Say(text) => {
                w.u8(1);
                w.str(text);
            }
            Ev::Put { table, piece, at } => {
                w.u8(2);
                w.u32(*table);
                w.u32(names.id(piece));
                w.i32(*at);
            }
            Ev::Blob { table, bytes } => {
                w.u8(3);
                w.u32(table.unwrap_or(u32::MAX));
                w.0.extend_from_slice(bytes);
            }
            Ev::Unencodable => return Err("this event can't be encoded".into()),
        }
        out.extend_from_slice(&w.0);
        Ok(())
    }

    fn decode(&self, bytes: &[u8], names: &NameTable) -> Result<Ev, String> {
        let mut r = Reader::new(bytes);
        let event = match r.u8()? {
            1 => Ev::Say(r.str()?),
            2 => {
                let table = r.u32()?;
                let id = r.u32()?;
                let piece = names
                    .get(id)
                    .ok_or_else(|| format!("name {id} isn't defined"))?
                    .to_string();
                Ev::Put {
                    table,
                    piece,
                    at: r.i32()?,
                }
            }
            3 => {
                let table = r.u32()?;
                Ev::Blob {
                    table: (table != u32::MAX).then_some(table),
                    bytes: r.rest().to_vec(),
                }
            }
            tag => return Err(format!("unknown tag {tag}")),
        };
        r.finish()?;
        Ok(event)
    }
}

/// A fresh temporary directory for test `label`.
pub(crate) fn temp(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-store-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

pub(crate) fn say(seq: u64, text: &str) -> LogEntry<Ev> {
    LogEntry {
        seq,
        time: seq * 10,
        event: Ev::Say(text.into()),
    }
}

pub(crate) fn put(seq: u64, table: u32, piece: &str) -> LogEntry<Ev> {
    LogEntry {
        seq,
        time: seq * 10,
        event: Ev::Put {
            table,
            piece: piece.into(),
            at: seq as i32,
        },
    }
}

/// The clock marks in `main.log` (generation 0): their times and what
/// they cover.
pub(crate) fn marks(dir: &Path) -> Vec<(u64, u64)> {
    marks_in(&dir.join("log/main.log"))
}

pub(crate) fn marks_in(path: &Path) -> Vec<(u64, u64)> {
    let bytes = fs::read(path).unwrap();
    format::scan(&bytes)
        .unwrap()
        .records
        .iter()
        .filter_map(|r| match r.kind {
            KIND_MARK => Some(format::decode_mark(r.payload).unwrap()),
            KIND_WALL_MARK => {
                let (time, covers, _) = format::decode_wall_mark(r.payload).unwrap();
                Some((time, covers))
            }
            _ => None,
        })
        .collect()
}

/// Cuts the file at `path` to `len` bytes, as a crash would leave it.
pub(crate) fn set_len(path: &Path, len: u64) {
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_len(len)
        .unwrap();
}

pub(crate) fn len(path: &Path) -> u64 {
    fs::metadata(path).unwrap().len()
}

/// Makes `path` read-only (or writable again).
pub(crate) fn set_writable(path: &Path, writable: bool) {
    let mut perms = fs::metadata(path).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(if writable { 0o644 } else { 0o444 });
    }
    #[cfg(not(unix))]
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(!writable);
    fs::set_permissions(path, perms).unwrap();
}

/// A new store in a fresh temporary directory for test `label`.
pub(crate) fn new_log(label: &str) -> (crate::Log<Tables>, PathBuf) {
    let dir = temp(label);
    let log = crate::Log::create(&dir, Tables, b"meta").unwrap();
    (log, dir)
}

/// Opens the store in `dir`.
pub(crate) fn open(dir: &Path) -> (crate::Log<Tables>, crate::Opened<Ev>) {
    crate::Log::open(dir, Tables).unwrap()
}

/// Asks for a clock mark at `time` and waits for it.
pub(crate) fn mark(log: &mut crate::Log<Tables>, time: u64) {
    log.mark(time).unwrap();
    log.wait().unwrap();
}

/// Writes a clock mark to `main.log` the way the I/O thread does.
pub(crate) fn write_mark(log: &crate::Log<Tables>, time: u64, covers: u64) {
    let mut bytes = Vec::new();
    format::push_record(&mut bytes, KIND_MARK, &format::encode_mark(time, covers));
    log.write_main(&bytes).unwrap();
}
