//! Following a log while it is written: the tail reader ([`LogReader`]).
//!
//! A [`LogCut`] ([`crate::Log::cut`]) is where every file ends at one
//! moment, between appends: together the files then hold exactly the
//! entries through [`LogCut::last_seq`]. The store only appends (recovery
//! cuts files only while opening, before anything reads them this way), so
//! the bytes before a cut never change: a reader can read them on any
//! thread, with no lock, while the log goes on. Each read starts where the
//! last ended and decodes only what the files gained, several files on
//! several threads.
//!
//! The reader recovers nothing: anything but complete records up to the
//! cut, holding the entries the cut names, is an error.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::codec::{LogCodec, LogEntry, NameTable};
use crate::error::StoreError;
use crate::format::{
    self, HEADER_LEN, KIND_BATCH, KIND_CLOCK, KIND_ENTRY, KIND_MARK, KIND_NAME, KIND_WALL_MARK,
};
use crate::io_err;
use crate::read::par_map;
use crate::writer::{CutFile, LogCut};

/// A clock mark a [`LogReader`] read: the game's time, the last entry it
/// covers, and its wall time (kinds 3 and 4 have none).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadMark {
    /// The game's time.
    pub time: u64,
    /// The last entry it covers.
    pub covers: u64,
    /// When it was asked for, in seconds since the Unix epoch.
    pub wall: Option<u64>,
}

/// How far one file has been read.
struct Cursor<K> {
    path: PathBuf,
    key: Option<K>,
    /// Bytes read so far.
    offset: u64,
    names: NameTable,
    /// The last entry read from this file.
    last_seq: u64,
    /// The latest clock mark read from it (a `main.log`).
    mark: Option<ReadMark>,
}

impl<K: Clone + Eq> Cursor<K> {
    /// Decodes `bytes`, the file from `self.offset` on.
    fn decode<C: LogCodec<Key = K>>(
        &mut self,
        bytes: &[u8],
        codec: &C,
    ) -> Result<Vec<LogEntry<C::Event>>, StoreError> {
        let mut bytes = bytes;
        let mut base = self.offset;
        if base == 0 {
            if !format::is_header(bytes) {
                return Err(self.corrupt(0, "not a ThunderClap log file (or another format)"));
            }
            bytes = &bytes[HEADER_LEN..];
            base = HEADER_LEN as u64;
        }
        let records = format::records_in(bytes, base)
            .map_err(|(offset, reason)| self.corrupt(offset, &reason))?;
        let mut entries = Vec::new();
        for record in &records {
            let bad = |e: String| self.corrupt(record.offset, &e);
            match record.kind {
                KIND_NAME => {
                    let (local, name) = format::decode_name(record.payload).map_err(bad)?;
                    if !self.names.define(local, name) {
                        return Err(self
                            .corrupt(record.offset, &format!("name id {local} is defined twice")));
                    }
                }
                KIND_ENTRY => {
                    let (seq, time, rest) =
                        format::decode_entry_head(record.payload).map_err(bad)?;
                    let event = codec.decode(rest, &self.names).map_err(bad)?;
                    if seq <= self.last_seq {
                        return Err(
                            self.corrupt(record.offset, &format!("entry {seq} is out of order"))
                        );
                    }
                    if codec.key(&event) != self.key {
                        return Err(self.corrupt(
                            record.offset,
                            &format!("entry {seq} is in the wrong log file"),
                        ));
                    }
                    self.last_seq = seq;
                    entries.push(LogEntry { seq, time, event });
                }
                KIND_MARK => {
                    let (time, covers) = format::decode_mark(record.payload).map_err(bad)?;
                    self.note_mark(time, covers, None);
                }
                KIND_WALL_MARK => {
                    let (time, covers, wall) =
                        format::decode_wall_mark(record.payload).map_err(bad)?;
                    self.note_mark(time, covers, Some(wall));
                }
                KIND_CLOCK => {
                    let time = format::decode_clock(record.payload).map_err(bad)?;
                    let covers = self.mark.map_or(0, |m| m.covers).max(self.last_seq);
                    self.note_mark(time, covers, None);
                }
                // Batches matter to recovery, done when the store opened.
                KIND_BATCH => {}
                other => {
                    return Err(
                        self.corrupt(record.offset, &format!("unexpected record kind {other}"))
                    );
                }
            }
        }
        Ok(entries)
    }

    fn note_mark(&mut self, time: u64, covers: u64, wall: Option<u64>) {
        if self
            .mark
            .is_none_or(|m| (covers, time) >= (m.covers, m.time))
        {
            self.mark = Some(ReadMark { time, covers, wall });
        }
    }

    fn corrupt(&self, offset: u64, reason: &str) -> StoreError {
        StoreError::Corrupt {
            path: self.path.clone(),
            offset,
            reason: reason.to_string(),
        }
    }
}

/// Reads a store's log up to successive [`LogCut`]s, decoding only what
/// each cut adds (see the module docs).
pub struct LogReader<K> {
    dir: PathBuf,
    /// The last entry read.
    last_seq: u64,
    files: Vec<Cursor<K>>,
}

impl<K: Clone + Eq + Send> LogReader<K> {
    /// A reader of the store in `dir` that starts after entry `after` (0
    /// for the whole log; a game's base's last entry to follow from a
    /// base, given cuts of the generations from the base's on:
    /// [`LogCut::since_generation`]).
    pub fn after(dir: &Path, after: u64) -> LogReader<K> {
        LogReader {
            dir: dir.to_path_buf(),
            last_seq: after,
            files: Vec::new(),
        }
    }

    /// The last entry read.
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// The latest clock mark read (by what it covers, then its time).
    pub fn last_mark(&self) -> Option<ReadMark> {
        self.files
            .iter()
            .filter_map(|c| c.mark)
            .max_by_key(|m| (m.covers, m.time))
    }

    /// Reads the entries the log gained between the last cut read and
    /// `cut`, in sequence order. After an error the reader is of no
    /// further use.
    pub fn read_to<C: LogCodec<Key = K>>(
        &mut self,
        cut: &LogCut<K>,
        codec: &C,
    ) -> Result<Vec<LogEntry<C::Event>>, StoreError> {
        if cut.dir() != self.dir {
            return Err(StoreError::Sequence(format!(
                "a cut of {} can't be read as {}",
                cut.dir().display(),
                self.dir.display()
            )));
        }
        if cut.last_seq() < self.last_seq {
            return Err(StoreError::Sequence(format!(
                "the log was read through entry {}, but the cut ends at {}",
                self.last_seq,
                cut.last_seq()
            )));
        }
        let mut work: Vec<(Cursor<K>, u64)> = Vec::new();
        let mut kept: Vec<Cursor<K>> = Vec::new();
        let mut cursors = std::mem::take(&mut self.files);
        for CutFile { path, key, len, .. } in cut.files() {
            // By path: each generation has its own files.
            let cursor = match cursors.iter().position(|c| c.path == *path) {
                Some(i) => cursors.swap_remove(i),
                None => Cursor {
                    path: path.clone(),
                    key: key.clone(),
                    offset: 0,
                    names: NameTable::default(),
                    last_seq: 0,
                    mark: None,
                },
            };
            if *len < cursor.offset {
                return Err(StoreError::Corrupt {
                    path: path.clone(),
                    offset: *len,
                    reason: format!(
                        "the file was cut back from {} bytes while it was read",
                        cursor.offset
                    ),
                });
            }
            if *len == cursor.offset {
                kept.push(cursor);
            } else {
                work.push((cursor, *len));
            }
        }
        // A file the cut doesn't name keeps its place.
        kept.extend(cursors);
        let results = par_map(work, |(mut cursor, len)| {
            let read = read_range(&cursor.path, cursor.offset, len)
                .and_then(|bytes| cursor.decode(&bytes, codec));
            if read.is_ok() {
                cursor.offset = len;
            }
            (cursor, read)
        });
        let mut entries = Vec::new();
        let mut failure = None;
        for (cursor, read) in results {
            kept.push(cursor);
            match read {
                Ok(more) => entries.extend(more),
                Err(e) => {
                    failure.get_or_insert(e);
                }
            }
        }
        self.files = kept;
        if let Some(e) = failure {
            return Err(e);
        }
        entries.sort_unstable_by_key(|e| e.seq);
        let first = self.last_seq + 1;
        for (entry, want) in entries.iter().zip(first..) {
            if entry.seq != want {
                return Err(StoreError::Sequence(format!(
                    "entry {want} is missing from the log written since entry {}",
                    self.last_seq
                )));
            }
        }
        let read = self.last_seq + entries.len() as u64;
        if read != cut.last_seq() {
            return Err(StoreError::Sequence(format!(
                "the log should hold entries {first} to {}, but holds them to {read}",
                cut.last_seq()
            )));
        }
        self.last_seq = read;
        Ok(entries)
    }
}

/// Bytes `from..to` of the file at `path`.
fn read_range(path: &Path, from: u64, to: u64) -> Result<Vec<u8>, StoreError> {
    let mut file = File::open(path).map_err(io_err(path))?;
    file.seek(SeekFrom::Start(from)).map_err(io_err(path))?;
    let len = usize::try_from(to - from).map_err(|_| StoreError::Corrupt {
        path: path.to_path_buf(),
        offset: from,
        reason: "too long to read".into(),
    })?;
    let mut bytes = vec![0; len];
    file.read_exact(&mut bytes).map_err(io_err(path))?;
    Ok(bytes)
}
