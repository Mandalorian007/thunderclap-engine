//! A store in memory ([`MemoryLog`]), and [`Store`]: a log on disk or in
//! memory behind one type, for tests and for games that don't persist.
//!
//! A memory log encodes every entry with the game's codec into the same
//! records a file would hold (one buffer per file), so an event that
//! wouldn't encode, or is too large, fails here as it would on disk, and
//! reading it back decodes what was written. Appends are all or none, in
//! sequence; clock marks need no sync, so they are on "disk" at once.

use std::collections::{BTreeMap, HashMap};

use crate::codec::{LogCodec, LogEntry};
use crate::error::StoreError;
use crate::format;
use crate::log_file::encode_entry;
use crate::read::{Item, read_log};
use crate::writer::Log;
use crate::{FileKind, unix_now};

/// One file's bytes and name table.
#[derive(Clone, Default)]
struct MemFile {
    bytes: Vec<u8>,
    names: HashMap<String, u32>,
}

impl MemFile {
    fn new() -> MemFile {
        MemFile {
            bytes: format::header().to_vec(),
            names: HashMap::new(),
        }
    }
}

/// A log in memory (see the module docs).
pub struct MemoryLog<C: LogCodec> {
    codec: C,
    main: MemFile,
    keyed: BTreeMap<C::Key, MemFile>,
    last_seq: u64,
    clock: u64,
}

impl<C: LogCodec> MemoryLog<C> {
    /// An empty log.
    pub fn new(codec: C) -> MemoryLog<C> {
        MemoryLog {
            codec,
            main: MemFile::new(),
            keyed: BTreeMap::new(),
            last_seq: 0,
            clock: 0,
        }
    }

    /// The game's codec.
    pub fn codec(&self) -> &C {
        &self.codec
    }

    /// The last entry appended.
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// The latest clock mark's time (0 if none).
    pub fn clock(&self) -> u64 {
        self.clock
    }

    /// The bytes the log holds, every file's.
    pub fn len(&self) -> usize {
        self.main.bytes.len() + self.keyed.values().map(|f| f.bytes.len()).sum::<usize>()
    }

    /// True if it holds no entry.
    pub fn is_empty(&self) -> bool {
        self.last_seq == 0
    }

    /// Appends one entry: see [`MemoryLog::append_all`].
    pub fn append(&mut self, entry: &LogEntry<C::Event>) -> Result<(), StoreError> {
        self.append_all(std::slice::from_ref(entry))
    }

    /// Appends entries, all or none, as [`Log::append_all`] does: their
    /// sequence numbers must follow on from [`MemoryLog::last_seq`].
    pub fn append_all(&mut self, entries: &[LogEntry<C::Event>]) -> Result<(), StoreError> {
        for (entry, want) in entries.iter().zip(self.last_seq + 1..) {
            if entry.seq != want {
                return Err(StoreError::Sequence(format!(
                    "entry {} was appended where entry {want} goes",
                    entry.seq
                )));
            }
        }
        let batch = match (entries.first(), entries.last()) {
            (Some(first), Some(last)) if entries.len() > 1 => Some((first.seq, last.seq)),
            _ => None,
        };
        // Each file written, staged, so a failure changes nothing.
        let mut staged: Vec<(Option<C::Key>, MemFile)> = Vec::new();
        for entry in entries {
            let key = self.codec.key(&entry.event);
            let first_here = !staged.iter().any(|(k, _)| *k == key);
            if first_here {
                let file = match &key {
                    None => self.main.clone(),
                    Some(k) => self.keyed.get(k).cloned().unwrap_or_else(MemFile::new),
                };
                staged.push((key.clone(), file));
            }
            let file = &mut staged
                .iter_mut()
                .find(|(k, _)| *k == key)
                .expect("staged above")
                .1;
            let (bytes, names, _) = encode_entry(
                entry,
                batch.filter(|_| first_here),
                &self.codec,
                &file.names,
            )?;
            file.bytes.extend_from_slice(&bytes);
            file.names.extend(names);
        }
        for (key, file) in staged {
            match key {
                None => self.main = file,
                Some(k) => {
                    self.keyed.insert(k, file);
                }
            }
        }
        if let Some(last) = entries.last() {
            self.last_seq = last.seq;
        }
        Ok(())
    }

    /// Writes a clock mark at the game's time `time`, covering every entry
    /// appended so far, with the wall time now.
    pub fn mark(&mut self, time: u64) {
        self.mark_wall(time, unix_now());
    }

    /// [`MemoryLog::mark`] with the wall time `wall` ([`Log::mark_wall`]).
    pub fn mark_wall(&mut self, time: u64, wall: u64) {
        format::push_mark(&mut self.main.bytes, time, self.last_seq, Some(wall));
        self.clock = self.clock.max(time);
    }

    /// Every entry, decoded from what was written, in sequence order.
    pub fn entries(&self) -> Result<Vec<LogEntry<C::Event>>, StoreError> {
        let mut out = Vec::new();
        for (kind, file) in self.files() {
            let log = read_log(&self.codec, "memory".into(), kind, &file.bytes)?;
            out.extend(log.items.into_iter().filter_map(|r| match r.what {
                Item::Entry { entry, .. } => Some(entry),
                _ => None,
            }));
        }
        out.sort_unstable_by_key(|e| e.seq);
        Ok(out)
    }

    /// The clock marks, in order: the game's time, the last entry each
    /// covers, and its wall time.
    pub fn marks(&self) -> Result<Vec<(u64, u64, Option<u64>)>, StoreError> {
        let log = read_log(
            &self.codec,
            "memory".into(),
            FileKind::Main,
            &self.main.bytes,
        )?;
        Ok(log
            .items
            .into_iter()
            .filter_map(|r| match r.what {
                Item::Clock { time, covers, wall } => Some((time, covers, wall)),
                _ => None,
            })
            .collect())
    }

    /// Rolls the log back to entry `seq` (to just before the batch it is
    /// in, if it is in one), with the clock marks that cover no more.
    /// Returns the last entry kept.
    pub fn rollback_to(&mut self, seq: u64) -> Result<u64, StoreError> {
        let mut keep = seq.min(self.last_seq);
        let mut logs = Vec::new();
        for (kind, file) in self.files() {
            logs.push(read_log(&self.codec, "memory".into(), kind, &file.bytes)?);
        }
        for log in &logs {
            for r in &log.items {
                if let Item::Batch { first, last } = r.what
                    && first <= keep
                    && keep < last
                {
                    keep = first - 1;
                }
            }
        }
        let mut clock = 0;
        let mut files = Vec::new();
        for log in logs {
            let mut file = MemFile::default();
            let mut end = format::HEADER_LEN as u64;
            for r in &log.items {
                let past = match &r.what {
                    Item::Entry { entry, .. } => entry.seq > keep,
                    Item::Batch { first, .. } => *first > keep,
                    Item::Clock { covers, .. } => *covers > keep,
                    Item::Name { .. } => false,
                };
                if past {
                    break;
                }
                match &r.what {
                    Item::Name { local, name } => {
                        file.names.insert(name.clone(), *local);
                    }
                    Item::Clock { time, .. } => clock = clock.max(*time),
                    _ => {}
                }
                end = r.end;
            }
            files.push((log.kind, end, file));
        }
        for (kind, end, mut file) in files {
            let target = match &kind {
                FileKind::Main => &mut self.main,
                FileKind::Keyed(k) => self.keyed.get_mut(k).expect("listed above"),
            };
            file.bytes = target.bytes[..end as usize].to_vec();
            *target = file;
        }
        self.last_seq = keep;
        self.clock = clock;
        Ok(keep)
    }

    fn files(&self) -> impl Iterator<Item = (FileKind<C::Key>, &MemFile)> {
        std::iter::once((FileKind::Main, &self.main)).chain(
            self.keyed
                .iter()
                .map(|(k, f)| (FileKind::Keyed(k.clone()), f)),
        )
    }
}

/// A game's log, on disk ([`Log`]) or in memory ([`MemoryLog`]): the calls
/// a game makes as it runs, the same for both.
pub enum Store<C: LogCodec> {
    /// A store directory.
    Disk(Log<C>),
    /// Memory only: gone when dropped.
    Memory(MemoryLog<C>),
}

impl<C: LogCodec> Store<C> {
    /// A store in memory, empty.
    pub fn memory(codec: C) -> Store<C> {
        Store::Memory(MemoryLog::new(codec))
    }

    /// A store on disk, opened or created with [`Log`].
    pub fn disk(log: Log<C>) -> Store<C> {
        Store::Disk(log)
    }

    /// True if it is in memory.
    pub fn is_memory(&self) -> bool {
        matches!(self, Store::Memory(_))
    }

    /// The game's codec.
    pub fn codec(&self) -> &C {
        match self {
            Store::Disk(log) => log.codec(),
            Store::Memory(log) => log.codec(),
        }
    }

    /// The last entry appended.
    pub fn last_seq(&self) -> u64 {
        match self {
            Store::Disk(log) => log.last_seq(),
            Store::Memory(log) => log.last_seq(),
        }
    }

    /// Appends one entry ([`Log::append`]).
    pub fn append(&mut self, entry: &LogEntry<C::Event>) -> Result<(), StoreError> {
        match self {
            Store::Disk(log) => log.append(entry),
            Store::Memory(log) => log.append(entry),
        }
    }

    /// Appends entries, all or none ([`Log::append_all`]).
    pub fn append_all(&mut self, entries: &[LogEntry<C::Event>]) -> Result<(), StoreError> {
        match self {
            Store::Disk(log) => log.append_all(entries),
            Store::Memory(log) => log.append_all(entries),
        }
    }

    /// Asks for a clock mark at the game's time `time` ([`Log::mark`]); in
    /// memory it is written at once.
    pub fn mark(&mut self, time: u64) -> Result<(), StoreError> {
        match self {
            Store::Disk(log) => log.mark(time),
            Store::Memory(log) => {
                log.mark(time);
                Ok(())
            }
        }
    }

    /// [`Store::mark`] with the wall time `wall` ([`Log::mark_wall`]).
    pub fn mark_wall(&mut self, time: u64, wall: u64) -> Result<(), StoreError> {
        match self {
            Store::Disk(log) => log.mark_wall(time, wall),
            Store::Memory(log) => {
                log.mark_wall(time, wall);
                Ok(())
            }
        }
    }

    /// Waits for every clock mark asked for ([`Log::wait`]); in memory,
    /// returns at once.
    pub fn wait(&mut self) -> Result<(), StoreError> {
        match self {
            Store::Disk(log) => log.wait(),
            Store::Memory(_) => Ok(()),
        }
    }

    /// The log on disk, if it is one.
    pub fn as_disk(&mut self) -> Option<&mut Log<C>> {
        match self {
            Store::Disk(log) => Some(log),
            Store::Memory(_) => None,
        }
    }

    /// The log in memory, if it is one.
    pub fn as_memory(&mut self) -> Option<&mut MemoryLog<C>> {
        match self {
            Store::Disk(_) => None,
            Store::Memory(log) => Some(log),
        }
    }
}
