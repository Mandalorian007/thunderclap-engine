//! One log file appended to ([`LogFile`]): created, reopened after recovery,
//! written in whole records, cut back, synced.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::codec::{LogCodec, LogEntry, Names};
use crate::error::StoreError;
use crate::format::{self, HEADER_LEN, KIND_BATCH, KIND_ENTRY, KIND_NAME};
use crate::hold::Hold;
use crate::io::ToSync;
use crate::recovered::save_tail;
use crate::{FileKind, durable, io_err, open_to_sync, set_len};

/// One log file appended to. A keyed file may be closed (`file` is `None`)
/// and reopened when next written. The handle is shared so the I/O thread
/// can sync a file the appending thread has since closed.
pub(crate) struct LogFile {
    pub path: PathBuf,
    pub file: Option<Arc<File>>,
    /// Length of the intact data; appends go here.
    pub len: u64,
    /// The file's name table: string to file-local id.
    pub names: HashMap<String, u32>,
    /// Written since the last clock mark was asked for (keyed files; every
    /// mark syncs `main.log`).
    pub dirty: bool,
    /// When it was last written, to close the least recently used.
    pub last_used: u64,
    /// Set if a failed write couldn't be rolled back.
    pub poisoned: bool,
}

/// What loading learned about one log file, for reopening it to append.
pub(crate) struct FileState<K> {
    pub path: PathBuf,
    pub kind: FileKind<K>,
    /// The log generation it is in (see the `gens` module).
    pub generation: u64,
    /// True if it keeps an entry.
    pub has_entries: bool,
    /// Length of the durable prefix to keep.
    pub valid_len: u64,
    pub file_len: u64,
    pub names: HashMap<String, u32>,
    /// A clock mark to write again after the cut: the latest one cut off
    /// with dropped entries, when it is later than every mark kept (its
    /// time, what it covers, its wall time).
    pub restore: Option<(u64, u64, Option<u64>)>,
}

impl LogFile {
    pub fn new(
        path: PathBuf,
        file: Option<File>,
        len: u64,
        names: HashMap<String, u32>,
    ) -> LogFile {
        LogFile {
            path,
            file: file.map(Arc::new),
            len,
            names,
            dirty: false,
            last_used: 0,
            poisoned: false,
        }
    }

    /// Creates a new log file and writes its header (through `hold`, like
    /// any append). Syncs nothing: its name isn't durable until its
    /// directory is synced, which for a keyed file the next clock mark does
    /// before it is written (see the `writer` module).
    pub fn create(path: PathBuf, hold: &Hold) -> Result<LogFile, StoreError> {
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&path)
            .map_err(io_err(&path))?;
        let mut log = LogFile::new(path, Some(file), 0, HashMap::new());
        log.write(&format::header(), hold)?;
        debug_assert_eq!(log.len, HEADER_LEN as u64);
        Ok(log)
    }

    /// Prepares a file loading found for appending: saves what it cuts off
    /// to `recovered` (returning where), cuts it back to its durable
    /// prefix, restores a torn header, and writes again a clock mark that
    /// was cut off (syncing all of it). Leaves it closed.
    pub fn reopen<K>(
        state: FileState<K>,
        recovered: &Path,
    ) -> Result<(LogFile, Option<PathBuf>), StoreError> {
        let path = state.path;
        let mut len = state.valid_len;
        let mut saved = None;
        if len < state.file_len || len == 0 || state.restore.is_some() {
            let mut file = OpenOptions::new()
                .read(true)
                .append(true)
                .open(&path)
                .map_err(io_err(&path))?;
            if len < state.file_len {
                saved = Some(save_tail(&file, &path, len, state.file_len, recovered)?);
            }
            set_len(&file, &path, len).map_err(io_err(&path))?;
            let mut bytes = Vec::new();
            if len == 0 {
                bytes.extend_from_slice(&format::header());
            }
            if let Some((time, covers, wall)) = state.restore {
                format::push_mark(&mut bytes, time, covers, wall);
            }
            file.write_all(&bytes).map_err(io_err(&path))?;
            len += bytes.len() as u64;
            durable::full(&file, &path).map_err(io_err(&path))?;
        }
        Ok((LogFile::new(path, None, len, state.names), saved))
    }

    /// Opens the file for appending if it is closed.
    pub fn open(&mut self) -> Result<(), StoreError> {
        if self.file.is_none() {
            let file = OpenOptions::new()
                .append(true)
                .open(&self.path)
                .map_err(io_err(&self.path))?;
            self.file = Some(Arc::new(file));
        }
        Ok(())
    }

    /// Closes the file without syncing it: if it was written since the
    /// last mark was asked for it stays dirty, and the next mark syncs it.
    pub fn close(&mut self) {
        self.file = None;
    }

    /// Hands the file's writes to the drive now, through its handle if it
    /// is open: durable once a later durable sync flushes the drive's
    /// cache (see the `durable` module).
    pub fn push(&self) -> Result<(), StoreError> {
        match self.file.as_deref() {
            Some(f) => durable::push(f, &self.path),
            None => open_to_sync(&self.path).and_then(|f| durable::push(&f, &self.path)),
        }
        .map_err(io_err(&self.path))
    }

    /// The file, for the I/O thread to sync.
    pub fn to_sync(&self) -> ToSync {
        ToSync {
            path: self.path.clone(),
            file: self.file.clone(),
        }
    }

    /// Writes complete records in one call, rolling back on failure;
    /// while the I/O thread syncs, `hold` keeps them for it to write (see
    /// the `hold` module).
    pub fn write(&mut self, bytes: &[u8], hold: &Hold) -> Result<(), StoreError> {
        if self.poisoned {
            return Err(StoreError::Poisoned);
        }
        self.open()?;
        let file = self.file.as_ref().expect("opened above");
        self.dirty = true;
        match hold.write(file, bytes) {
            Ok(()) => {
                self.len += bytes.len() as u64;
                Ok(())
            }
            Err(error) => {
                if set_len(file, &self.path, self.len).is_err() {
                    self.poisoned = true;
                }
                Err(StoreError::Io {
                    path: self.path.clone(),
                    error,
                })
            }
        }
    }

    /// Cuts the file back to `len` bytes (reopening it if it was closed),
    /// once `hold` has written what it holds.
    pub fn cut(&mut self, len: u64, hold: &Hold) -> Result<(), StoreError> {
        if self.len == len {
            return Ok(());
        }
        hold.settle();
        self.open()?;
        let file = self.file.as_deref().expect("opened above");
        set_len(file, &self.path, len).map_err(io_err(&self.path))?;
        self.len = len;
        self.dirty = true;
        Ok(())
    }

    /// Appends an entry with the name records it needs, after a record for
    /// `batch` (its first and last entries) if given: in one write. Returns
    /// the entry record's length, framing included.
    pub fn append_entry<C: LogCodec>(
        &mut self,
        entry: &LogEntry<C::Event>,
        batch: Option<(u64, u64)>,
        codec: &C,
        hold: &Hold,
    ) -> Result<usize, StoreError> {
        let (bytes, new_names, entry_len) = encode_entry(entry, batch, codec, &self.names)?;
        self.write(&bytes, hold)?;
        self.names.extend(new_names);
        Ok(entry_len)
    }
}

/// An encoded entry: its bytes, the names it added to its file's table,
/// and its entry record's length.
pub(crate) type Encoded = (Vec<u8>, Vec<(String, u32)>, usize);

/// An entry's records as one write: a batch record for `batch` if given,
/// the name records it needs that `names` (the file's table) lacks, then
/// the entry. Returns the bytes, the new names, and the entry record's
/// length, framing included.
pub(crate) fn encode_entry<C: LogCodec>(
    entry: &LogEntry<C::Event>,
    batch: Option<(u64, u64)>,
    codec: &C,
    names: &HashMap<String, u32>,
) -> Result<Encoded, StoreError> {
    let mut payload = Vec::new();
    format::encode_entry_head(&mut payload, entry.seq, entry.time);
    let mut names = Names::new(names);
    codec
        .encode(&entry.event, &mut names, &mut payload)
        .map_err(|reason| StoreError::Encode {
            seq: entry.seq,
            reason,
        })?;
    let new_names = names.new;
    if payload.len() > format::MAX_PAYLOAD {
        return Err(StoreError::RecordTooLarge {
            seq: entry.seq,
            len: payload.len(),
            max: format::MAX_PAYLOAD,
        });
    }
    let mut bytes = Vec::new();
    if let Some((first, last)) = batch {
        format::push_record(&mut bytes, KIND_BATCH, &format::encode_batch(first, last));
    }
    for (name, local) in &new_names {
        let record = format::encode_name(*local, name);
        if record.len() > format::MAX_PAYLOAD {
            return Err(StoreError::RecordTooLarge {
                seq: entry.seq,
                len: record.len(),
                max: format::MAX_PAYLOAD,
            });
        }
        format::push_record(&mut bytes, KIND_NAME, &record);
    }
    let names_end = bytes.len();
    format::push_record(&mut bytes, KIND_ENTRY, &payload);
    let entry_len = bytes.len() - names_end;
    Ok((bytes, new_names, entry_len))
}
