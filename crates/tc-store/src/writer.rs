//! [`Log`]: creating and opening a store directory, appending entries,
//! clock marks, and rotating log generations. What a crash can lose, and
//! how opening recovers, is in the `load` module.
//!
//! # Durability
//!
//! Each append is one `write` call of complete records to one file, with no
//! sync; while the I/O thread syncs, the log holds it in memory and the
//! thread writes it when the sync returns (the `hold` module), since on
//! macOS a sync holds up every write that grows a file on the volume. A
//! clock mark names the last entry it covers, and is written to `main.log`
//! only once every file written before it was asked for is durable,
//! `main.log` included; then it is synced itself. So a clock mark on disk
//! proves every entry it covers is on disk too.
//!
//! Syncs are the store's only slow operation, and only clock marks make
//! them, on the I/O thread (see the `io` module): asking for a mark hands
//! the keyed files written since the last one to that thread and returns.
//! [`Log::wait`] waits for every mark asked for; dropping the log does
//! too, so a clean stop leaves its last mark on disk.
//!
//! # New keyed files
//!
//! An append that first writes a key creates its file and writes the
//! header (through the hold, like any append), and syncs nothing: the
//! store notes the directory, and the next clock mark syncs it before the
//! mark is written. So a mark on disk still proves every entry it covers
//! is on disk in a file whose name is too. An OS crash before then can
//! lose the new file with its entries while a later entry in another file
//! survives: opening counts such a gap as lost writes.
//!
//! A clock mark that fails refuses appends (see the `io` module): until a
//! mark succeeds, or, if a sync itself failed, until the store is reopened.
//!
//! At most [`MAX_OPEN_FILES`](crate::MAX_OPEN_FILES) keyed files are open
//! at once; the least recently written is closed (not synced) to make room.
//!
//! A store is created by writing an empty `main.log` and then `store.meta`
//! (via a temporary file and a rename). A directory left with only an empty
//! `main.log` by a crash during creation can be created again.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::archive::{check_archive_is_the_logs, clear_leftovers};
use crate::background::Background;
use crate::codec::{LogCodec, LogEntry};
use crate::durable::{self, sync_dir, syncs_here};
use crate::error::StoreError;
use crate::format::{self, HEADER_LEN};
use crate::gens::{self, Listing, check_file_name};
use crate::hold::Hold;
use crate::io::{Io, Mark, ToSync, lock};
use crate::load::{load, read_meta};
use crate::lock::{LOCK_FILE, StoreLock};
use crate::log_file::{FileState, LogFile};
use crate::{
    FileKind, MAIN_LOG, MAX_OPEN_FILES, META_FILE, OpenReport, RECOVERED_DIR, crash, io_err,
    log_dir, set_len, unix_now,
};

/// What opening a store read: the game's metadata, the durable entries to
/// replay, the latest clock mark's time and what recovery did.
#[derive(Debug)]
pub struct Opened<E> {
    /// The game's metadata bytes, as [`Log::create`] was given them.
    pub meta: Vec<u8>,
    /// The durable entries, in sequence order.
    pub entries: Vec<LogEntry<E>>,
    /// The latest clock mark's time (0 if none): the game's clock never
    /// goes back past it.
    pub clock: u64,
    /// What opening recovered from.
    pub report: OpenReport,
}

/// A store's log read under its lock ([`Log::scan`]), to look at before
/// opening it with [`Log::open_scanned`] without reading it again: a game
/// that checks or upgrades its data under the lock, then opens.
pub struct Scan<E, K> {
    /// The game's metadata bytes.
    pub meta: Vec<u8>,
    /// The durable entries, in sequence order. Taking them leaves
    /// [`Opened::entries`] empty; the log resumes after the last anyway.
    pub entries: Vec<LogEntry<E>>,
    /// The latest clock mark's time (0 if none).
    pub clock: u64,
    /// What opening will recover from (no file is cut yet, so no
    /// [`crate::Truncated::saved`] is set).
    pub report: OpenReport,
    /// What an archiving ([`crate::tidy`]) cut short left, removed.
    pub leftovers: Vec<PathBuf>,
    listing: Listing<K>,
    files: Vec<FileState<K>>,
    from_gen: u64,
    last_seq: u64,
    /// The [`StoreLock`] it was read under.
    lock: u64,
}

impl<E: std::fmt::Debug, K> std::fmt::Debug for Scan<E, K> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Scan")
            .field("meta", &self.meta)
            .field("entries", &self.entries)
            .field("clock", &self.clock)
            .field("report", &self.report)
            .field("leftovers", &self.leftovers)
            .field("from_gen", &self.from_gen)
            .field("last_seq", &self.last_seq)
            .finish_non_exhaustive()
    }
}

/// Counts for a game's diagnostics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    /// Keyed files created.
    pub files_created: u64,
    /// Syncs made on the appending thread by appends and mark requests
    /// (none: the I/O thread makes them).
    pub syncs_here: u64,
    /// Durable syncs made by background jobs, with appends held.
    pub background_syncs: u64,
}

/// One file of a [`LogCut`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CutFile<K> {
    /// The file.
    pub path: PathBuf,
    /// Its file key, `None` for `main.log`.
    pub key: Option<K>,
    /// Where it ends at the cut.
    pub len: u64,
    /// Its log generation.
    pub generation: u64,
}

/// Where every log file ends at one moment, taken between appends: every
/// file then ends in complete records, and together they hold exactly the
/// entries `1..=last_seq`. The store only appends, so the bytes before a
/// cut never change: another thread can read them while the log goes on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogCut<K> {
    dir: PathBuf,
    last_seq: u64,
    time: u64,
    files: Vec<CutFile<K>>,
    generation: u64,
}

impl<K> LogCut<K> {
    /// The store directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The last entry the cut holds.
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// The game's time at the cut.
    pub fn time(&self) -> u64 {
        self.time
    }

    /// The generation appended to at the cut.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Every file and where it ends: the frozen generations' (since the
    /// last [`Log::note_base`]), then the current one's.
    pub fn files(&self) -> &[CutFile<K>] {
        &self.files
    }

    /// The cut, less the generations before `generation`: what a
    /// [`LogReader`](crate::LogReader) that starts at a game's base whose
    /// tail starts there reads.
    pub fn since_generation(&self, generation: u64) -> LogCut<K>
    where
        K: Clone,
    {
        LogCut {
            dir: self.dir.clone(),
            last_seq: self.last_seq,
            time: self.time,
            files: self
                .files
                .iter()
                .filter(|f| f.generation >= generation)
                .cloned()
                .collect(),
            generation: self.generation,
        }
    }

    /// The files of generations older than the cut's: none is written
    /// again.
    pub fn frozen_paths(&self) -> impl Iterator<Item = &Path> {
        self.files
            .iter()
            .filter(|f| f.generation < self.generation)
            .map(|f| f.path.as_path())
    }
}

/// The files of a log generation made ahead of a rotation, off the
/// appending thread ([`prepare`]), for [`Log::rotate`] to swap in.
pub struct Prepared<K> {
    generation: u64,
    main: LogFile,
    keyed: BTreeMap<K, LogFile>,
}

/// Makes generation `generation`'s directory in store directory `dir`,
/// with a `main.log` and a file for each of `keys` (say the ones written in
/// the generation before it, likely to be written again), each holding
/// just its header, all durable. Takes milliseconds of syncs: run it off
/// the appending thread ([`Log::background`]). Files a run cut short left
/// are used again if they hold just their header.
pub fn prepare<C: LogCodec>(
    dir: &Path,
    codec: &C,
    generation: u64,
    keys: &[C::Key],
) -> Result<Prepared<C::Key>, StoreError> {
    if generation == 0 {
        return Err(StoreError::Sequence(
            "generation 0 is made with the store, not prepared".into(),
        ));
    }
    let gdir = gens::gen_dir(dir, generation);
    fs::create_dir_all(&gdir).map_err(io_err(&gdir))?;
    let fresh = |path: PathBuf| -> Result<LogFile, StoreError> {
        let file = match OpenOptions::new()
            .create_new(true)
            .read(true)
            .append(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => OpenOptions::new()
                .read(true)
                .append(true)
                .open(&path)
                .map_err(io_err(&path))?,
            Err(e) => return Err(io_err(&path)(e)),
        };
        let len = file.metadata().map_err(io_err(&path))?.len();
        if len > HEADER_LEN as u64 {
            return Err(StoreError::Corrupt {
                path: path.clone(),
                offset: 0,
                reason: "a log generation not yet written to already holds records".into(),
            });
        }
        let mut head = vec![0; len as usize];
        {
            use std::io::Read;
            (&file).read_exact(&mut head).map_err(io_err(&path))?;
        }
        // Torn by a crash while it was made: made again.
        if len < HEADER_LEN as u64 || !format::is_header(&head) {
            set_len(&file, &path, 0).map_err(io_err(&path))?;
            (&file)
                .write_all(&format::header())
                .map_err(io_err(&path))?;
        }
        durable::push(&file, &path).map_err(io_err(&path))?;
        Ok(LogFile::new(
            path,
            Some(file),
            HEADER_LEN as u64,
            HashMap::new(),
        ))
    };
    let main = fresh(gdir.join(MAIN_LOG))?;
    let mut keyed = BTreeMap::new();
    for key in keys {
        let mut file = fresh(gdir.join(check_file_name(codec, key)?))?;
        file.close();
        keyed.insert(key.clone(), file);
    }
    // One durable sync: on macOS it flushes the drive's cache, making the
    // pushes of the files and of their directory's names durable too (see
    // the `durable` module).
    durable::push_dir(&gdir)?;
    sync_dir(&log_dir(dir))?;
    Ok(Prepared {
        generation,
        main,
        keyed,
    })
}

/// Makes the log files at `paths` (frozen: none is written again) durable,
/// with their directories and `log/` in store directory `dir`: each is
/// pushed, and `log/`'s durable sync last makes them all durable, one
/// cache flush on macOS however many files (see the `durable` module).
pub fn sync_frozen<'a>(
    dir: &Path,
    paths: impl Iterator<Item = &'a Path>,
) -> Result<(), StoreError> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for path in paths {
        durable::push_path(path)?;
        if let Some(parent) = path.parent()
            && !dirs.iter().any(|d| d == parent)
        {
            dirs.push(parent.to_path_buf());
        }
    }
    let logs = log_dir(dir);
    for d in dirs.iter().filter(|d| **d != logs) {
        durable::push_dir(d)?;
    }
    sync_dir(&logs)
}

/// An open store directory that a game's entries are appended to, through
/// its codec `C`. Holds the directory's lock ([`StoreLock`]) until
/// dropped; dropping it waits for every clock mark asked for.
pub struct Log<C: LogCodec> {
    codec: C,
    dir: PathBuf,
    /// Always open. Shared with the I/O thread, which appends clock marks
    /// to it.
    main: Arc<Mutex<LogFile>>,
    /// Every keyed file of the generation appended to; at most
    /// [`MAX_OPEN_FILES`] are open.
    keyed: BTreeMap<C::Key, LogFile>,
    open_keyed: usize,
    /// Counts keyed writes, to find the least recently used.
    uses: u64,
    /// Set once a failed write couldn't be rolled back.
    poisoned: bool,
    /// The last entry appended.
    last_seq: u64,
    /// Syncs files and writes clock marks.
    io: Io,
    /// Holds appends while `io` syncs (shared with it).
    hold: Arc<Hold>,
    /// Runs the game's slow jobs off the appending thread.
    background: Background,
    /// The log generation appended to (see the `gens` module).
    generation: u64,
    /// True once that generation holds an entry.
    has_entries: bool,
    /// Every file of the older generations read, frozen, and where it ends.
    frozen: Vec<CutFile<C::Key>>,
    /// Files of the generation last rotated away that were written since
    /// the last clock mark was asked for: the next mark makes them durable.
    carried: Vec<ToSync>,
    /// Generations below this one are durable (a base was written after
    /// they were synced): [`Log::sync_frozen`] syncs only the others.
    durable_below: u64,
    /// Directories a keyed file was created in since the last clock mark
    /// was asked for: the next mark syncs them before it is written.
    unnamed: Vec<PathBuf>,
    files_created: u64,
    syncs_here: u64,
    /// The directory's lock, dropped last, after the I/O thread has
    /// written its last mark.
    lock: Arc<StoreLock>,
}

impl<C: LogCodec> Log<C> {
    fn start(
        codec: C,
        dir: &Path,
        main: LogFile,
        keyed: BTreeMap<C::Key, LogFile>,
        lock: Arc<StoreLock>,
    ) -> Result<Log<C>, StoreError> {
        let main = Arc::new(Mutex::new(main));
        let hold = Arc::new(Hold::new());
        let io = Io::start(main.clone(), hold.clone()).map_err(io_err(dir))?;
        let background = Background::start(dir, hold.clone())?;
        Ok(Log {
            codec,
            dir: dir.to_path_buf(),
            main,
            keyed,
            open_keyed: 0,
            uses: 0,
            poisoned: false,
            last_seq: 0,
            io,
            hold,
            background,
            generation: 0,
            has_entries: false,
            frozen: Vec::new(),
            carried: Vec::new(),
            durable_below: 0,
            unnamed: Vec::new(),
            files_created: 0,
            syncs_here: 0,
            lock,
        })
    }

    /// Creates a store in `dir` (made if missing) holding the game's
    /// metadata `meta`: an empty `main.log`, then `store.meta`, so a
    /// directory with `store.meta` is always complete. A directory holding
    /// nothing but an empty `main.log` (a creation cut short) is created
    /// over. Fails with [`StoreError::Exists`] if a store is already there.
    pub fn create(dir: &Path, codec: C, meta: &[u8]) -> Result<Log<C>, StoreError> {
        let meta_path = dir.join(META_FILE);
        if meta_path.exists() {
            return Err(StoreError::Exists(dir.to_path_buf()));
        }
        let logs = log_dir(dir);
        fs::create_dir_all(&logs).map_err(io_err(&logs))?;
        let lock = Arc::new(StoreLock::acquire(dir)?);
        // Another process may have created it before we locked it.
        if meta_path.exists() {
            return Err(StoreError::Exists(dir.to_path_buf()));
        }
        check_no_entries(&logs)?;
        let path = logs.join(MAIN_LOG);
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .append(true)
            .open(&path)
            .map_err(io_err(&path))?;
        set_len(&file, &path, 0).map_err(io_err(&path))?;
        file.write_all(&format::header()).map_err(io_err(&path))?;
        durable::full(&file, &path).map_err(io_err(&path))?;
        sync_dir(&logs)?;
        sync_dir(dir)?;
        crash::point("create");
        write_meta(dir, meta)?;
        let main = LogFile::new(path, Some(file), HEADER_LEN as u64, HashMap::new());
        Log::start(codec, dir, main, BTreeMap::new(), lock)
    }

    /// Opens the store in `dir`, reading its whole log: locks it, reads
    /// every generation, recovers (see the `load` module) and returns the
    /// durable entries for the game to replay. Fails with
    /// [`StoreError::InUse`] if another process holds it.
    pub fn open(dir: &Path, codec: C) -> Result<(Log<C>, Opened<C::Event>), StoreError> {
        Log::open_from(dir, codec, 0, 0)
    }

    /// Opens the store in `dir` as [`Log::open`] does, reading only the
    /// generations from `from_gen` on, whose entries must all come after
    /// entry `after`: for a game that kept its state through `after` (a
    /// base) and replays only the tail. The older generations aren't read
    /// or named.
    pub fn open_from(
        dir: &Path,
        codec: C,
        from_gen: u64,
        after: u64,
    ) -> Result<(Log<C>, Opened<C::Event>), StoreError> {
        read_meta(dir)?;
        let lock = StoreLock::acquire(dir)?;
        Log::open_locked(lock, codec, from_gen, after)
    }

    /// [`Log::open_from`] under a lock the caller already holds
    /// ([`StoreLock::acquire`] of the store's directory), kept until the
    /// log is dropped.
    pub fn open_locked(
        lock: StoreLock,
        codec: C,
        from_gen: u64,
        after: u64,
    ) -> Result<(Log<C>, Opened<C::Event>), StoreError> {
        let scan = Log::scan(&lock, &codec, from_gen, after)?;
        Log::open_scanned(lock, codec, scan)
    }

    /// Reads the store locked by `lock` as [`Log::open_from`] would,
    /// changing no log file: finishes a repair or rollback in place cut
    /// short, clears what an archiving cut short left, and checks that the
    /// archive is the log's own (a store created over another's leftovers
    /// fails with [`StoreError::Meta`]). [`Log::open_scanned`] then opens
    /// it under the same lock without reading it again.
    pub fn scan(
        lock: &StoreLock,
        codec: &C,
        from_gen: u64,
        after: u64,
    ) -> Result<Scan<C::Event, C::Key>, StoreError> {
        if !lock.is_store_lock() {
            return Err(StoreError::Meta {
                path: lock.path().to_path_buf(),
                reason: format!("a store opens only under its own lock, {LOCK_FILE}"),
            });
        }
        let dir = lock.dir();
        // A repair or rollback in place cut short is finished first.
        crate::swap::finish_swap(dir, "swap")?;
        let mut leftovers = clear_leftovers(dir)?;
        let meta_tmp = dir.join(format!(".{META_FILE}.tmp"));
        if meta_tmp.exists() {
            fs::remove_file(&meta_tmp).map_err(io_err(&meta_tmp))?;
            leftovers.push(meta_tmp);
        }
        let loaded = load(dir, codec, after, from_gen)?;
        check_archive_is_the_logs(dir, &loaded.listing)?;
        Ok(Scan {
            last_seq: loaded.entries.last().map_or(after, |e| e.seq),
            meta: loaded.meta,
            entries: loaded.entries,
            clock: loaded.clock,
            report: loaded.report,
            leftovers,
            listing: loaded.listing,
            files: loaded.files,
            from_gen: loaded.from_gen,
            lock: lock.id(),
        })
    }

    /// Opens the store `scan` read ([`Log::scan`]), under the lock it was
    /// read under, without reading it again: cuts each file back to the
    /// durable prefix (saving what it cuts to `recovered/`) and appends
    /// after the last entry read. Fails if `lock` isn't the scan's.
    pub fn open_scanned(
        lock: StoreLock,
        codec: C,
        scan: Scan<C::Event, C::Key>,
    ) -> Result<(Log<C>, Opened<C::Event>), StoreError> {
        if scan.lock != lock.id() {
            return Err(StoreError::Meta {
                path: lock.path().to_path_buf(),
                reason: "a scan opens only under the lock it was read under".into(),
            });
        }
        let dir = lock.dir().to_path_buf();
        Log::reopen(&dir, codec, scan, Arc::new(lock))
    }

    /// Reopens the files a scan found, cutting each back to the durable
    /// prefix and saving what it cuts off to `recovered/` first.
    fn reopen(
        dir: &Path,
        codec: C,
        loaded: Scan<C::Event, C::Key>,
        lock: Arc<StoreLock>,
    ) -> Result<(Log<C>, Opened<C::Event>), StoreError> {
        let mut report = loaded.report;
        let recovered = dir.join(RECOVERED_DIR);
        let newest = loaded.listing.newest();
        let mut frozen = Vec::new();
        let mut main = None;
        let mut keyed = BTreeMap::new();
        let mut has_entries = false;
        for state in loaded.files {
            let kind = state.kind.clone();
            let generation = state.generation;
            let path = state.path.clone();
            let entries = state.has_entries;
            let (mut file, saved) = LogFile::reopen(state, &recovered)?;
            if let Some(saved) = saved
                && let Some(cut) = report.truncated.iter_mut().find(|t| t.path == path)
            {
                cut.saved = Some(saved);
            }
            if generation < newest {
                frozen.push(CutFile {
                    path: file.path,
                    key: match kind {
                        FileKind::Main => None,
                        FileKind::Keyed(key) => Some(key),
                    },
                    len: file.len,
                    generation,
                });
                continue;
            }
            has_entries |= entries;
            match kind {
                FileKind::Main => {
                    file.open()?;
                    main = Some(file);
                }
                FileKind::Keyed(key) => {
                    keyed.insert(key, file);
                }
            }
        }
        let main = match main {
            Some(main) => main,
            // A generation made by a rotation cut short.
            None if newest > 0 => {
                let gdir = gens::gen_dir(dir, newest);
                let main = LogFile::create(gdir.join(MAIN_LOG), &Hold::unused())?;
                sync_dir(&gdir)?;
                main
            }
            None => {
                return Err(StoreError::Io {
                    path: log_dir(dir).join(MAIN_LOG),
                    error: std::io::ErrorKind::NotFound.into(),
                });
            }
        };
        let mut log = Log::start(codec, dir, main, keyed, lock)?;
        log.generation = newest;
        log.has_entries = has_entries;
        log.frozen = frozen;
        log.durable_below = loaded.from_gen;
        log.last_seq = loaded.last_seq;
        let opened = Opened {
            meta: loaded.meta,
            entries: loaded.entries,
            clock: loaded.clock,
            report,
        };
        Ok((log, opened))
    }

    /// The game's codec.
    pub fn codec(&self) -> &C {
        &self.codec
    }

    /// The store directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The directory's lock (to note the port this process serves on).
    pub fn lock(&self) -> &Arc<StoreLock> {
        &self.lock
    }

    /// The last entry appended (or read when opened): the next must be
    /// one more.
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// The log generation appended to.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// True if the generation appended to holds an entry: rotating away
    /// from one that doesn't gains nothing.
    pub fn has_entries(&self) -> bool {
        self.has_entries
    }

    /// What [`prepare`] makes for the next rotation: the next generation,
    /// and the keys written in this one.
    pub fn to_prepare(&self) -> (u64, Vec<C::Key>) {
        (self.generation + 1, self.keyed.keys().cloned().collect())
    }

    /// The thread the game's slow jobs (a base, a rotation's [`prepare`])
    /// run on: a durable sync there holds appends as the I/O thread's do.
    pub fn background(&self) -> &Background {
        &self.background
    }

    /// Appends one entry: see [`Log::append_all`].
    pub fn append(&mut self, entry: &LogEntry<C::Event>) -> Result<(), StoreError> {
        self.append_all(std::slice::from_ref(entry))
    }

    /// Appends entries to the files they belong in, all or none: if any
    /// write fails, the files this call already wrote are cut back to
    /// where they were (a cut that fails poisons the log). Their sequence
    /// numbers must follow on from [`Log::last_seq`] without gaps. Several
    /// entries are a batch: each file gets a batch record before its first
    /// entry of them, so recovery after a crash keeps all of them or none.
    ///
    /// Refused while clock marks fail ([`Log::blocked`]): what it wrote
    /// might never become durable.
    pub fn append_all(&mut self, entries: &[LogEntry<C::Event>]) -> Result<(), StoreError> {
        let syncs = syncs_here();
        let result = self.append_entries(entries);
        self.syncs_here += syncs_here() - syncs;
        result
    }

    fn append_entries(&mut self, entries: &[LogEntry<C::Event>]) -> Result<(), StoreError> {
        if self.poisoned {
            return Err(StoreError::Poisoned);
        }
        if let Some(e) = self.io.blocked() {
            return Err(e);
        }
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
        // Held for the whole batch, so no clock mark lands inside it.
        let main_log = self.main.clone();
        let hold = self.hold.clone();
        let mut main = lock(&main_log);
        // Each file written, with its length and name count before.
        let mut undo: Vec<(Option<C::Key>, u64, usize)> = Vec::new();
        for entry in entries {
            let key = self.codec.key(&entry.event);
            let file = match &key {
                None => &mut *main,
                Some(k) => {
                    if let Err(e) = self.open_keyed_file(k) {
                        self.roll_back(&mut main, &undo);
                        return Err(e);
                    }
                    self.keyed.get_mut(k).expect("opened above")
                }
            };
            // The batch record goes before the file's first entry of it.
            let first_here = !undo.iter().any(|(k, _, _)| *k == key);
            if first_here {
                undo.push((key.clone(), file.len, file.names.len()));
            }
            let result = file.append_entry(entry, batch.filter(|_| first_here), &self.codec, &hold);
            if file.poisoned {
                self.poisoned = true;
            }
            if let Err(e) = result {
                self.roll_back(&mut main, &undo);
                return Err(e);
            }
        }
        if let Some(last) = entries.last() {
            self.last_seq = last.seq;
            self.has_entries = true;
        }
        Ok(())
    }

    /// Cuts the files in `undo` back to their lengths and name tables.
    fn roll_back(&mut self, main: &mut LogFile, undo: &[(Option<C::Key>, u64, usize)]) {
        for (key, len, names) in undo.iter().rev() {
            let file = match key {
                None => &mut *main,
                Some(k) => match self.keyed.get_mut(k) {
                    Some(file) => file,
                    None => continue,
                },
            };
            if file.cut(*len, &self.hold).is_err() {
                file.poisoned = true;
                self.poisoned = true;
            }
            file.names.retain(|_, local| (*local as usize) < *names);
        }
    }

    /// Opens the key's log file, creating it if needed and closing the
    /// least recently used one if too many are open.
    fn open_keyed_file(&mut self, key: &C::Key) -> Result<(), StoreError> {
        self.uses += 1;
        let is_open = self.keyed.get(key).is_some_and(|f| f.file.is_some());
        if !is_open {
            if self.open_keyed >= MAX_OPEN_FILES {
                self.close_least_recent();
            }
            match self.keyed.get_mut(key) {
                Some(file) => file.open()?,
                None => {
                    // Its name is made durable by the next clock mark (see
                    // the module docs).
                    let name = check_file_name(&self.codec, key)?;
                    let gdir = gens::gen_dir(&self.dir, self.generation);
                    let file = LogFile::create(gdir.join(name), &self.hold)?;
                    self.keyed.insert(key.clone(), file);
                    self.files_created += 1;
                    if !self.unnamed.contains(&gdir) {
                        self.unnamed.push(gdir);
                    }
                }
            }
            self.open_keyed += 1;
        }
        if let Some(file) = self.keyed.get_mut(key) {
            file.last_used = self.uses;
        }
        Ok(())
    }

    fn close_least_recent(&mut self) {
        let oldest = self
            .keyed
            .iter()
            .filter(|(_, f)| f.file.is_some())
            .min_by_key(|(_, f)| f.last_used)
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest {
            self.keyed.get_mut(&key).expect("found above").close();
            self.open_keyed -= 1;
        }
    }

    /// Asks for a clock mark at the game's time `time`, covering every
    /// entry appended so far, and returns without waiting: the I/O thread
    /// syncs every file written since the last mark was asked for, then
    /// appends the mark to `main.log` and syncs it. A mark on disk thus
    /// proves every entry it covers is on disk, and opening never goes
    /// back past it. Fails with the first failure not yet reported, of an
    /// earlier mark or of this one if the thread already failed it (a
    /// failed mark isn't written; its files are synced again by the next),
    /// or if the log is poisoned.
    pub fn mark(&mut self, time: u64) -> Result<(), StoreError> {
        let syncs = syncs_here();
        let result = self.ask_for_mark(time, None);
        self.syncs_here += syncs_here() - syncs;
        result
    }

    /// [`Log::mark`] with the wall time `wall` (seconds since the Unix
    /// epoch) the caller gives, rather than the clock's now: a copy or a
    /// repair keeps a mark's wall time, and the caller knows the time
    /// without waiting for the mark. Such a mark is written as asked, never
    /// folded into another still waiting (as marks without one are), so
    /// every one reaches the log.
    pub fn mark_wall(&mut self, time: u64, wall: u64) -> Result<(), StoreError> {
        let syncs = syncs_here();
        let result = self.ask_for_mark(time, Some(wall));
        self.syncs_here += syncs_here() - syncs;
        result
    }

    fn ask_for_mark(&mut self, time: u64, wall: Option<u64>) -> Result<(), StoreError> {
        if self.poisoned {
            return Err(StoreError::Poisoned);
        }
        if lock(&self.main).poisoned {
            self.poisoned = true;
            return Err(StoreError::Poisoned);
        }
        // Main.log is synced with every mark, after the mark is written;
        // what a rotation carried over from the generation before is synced
        // first.
        let mut files: Vec<ToSync> = std::mem::take(&mut self.carried);
        files.extend(self.keyed.values_mut().filter(|f| f.dirty).map(|f| {
            f.dirty = false;
            f.to_sync()
        }));
        self.io.request(Mark {
            time,
            covers: self.last_seq,
            wall: wall.unwrap_or_else(unix_now),
            exact: wall.is_some(),
            files,
            dirs: std::mem::take(&mut self.unnamed),
        });
        self.io.take_error().map_or(Ok(()), Err)
    }

    /// Waits until every clock mark asked for is on disk (or failed), and
    /// reports the first failure not yet reported.
    pub fn wait(&mut self) -> Result<(), StoreError> {
        self.io.wait()
    }

    /// True while a clock mark asked for isn't on disk yet.
    pub fn marks_pending(&self) -> bool {
        self.io.pending()
    }

    /// The first clock mark failure not yet reported, without waiting.
    pub fn take_mark_error(&mut self) -> Option<StoreError> {
        self.io.take_error()
    }

    /// Why appends are refused while clock marks fail, if they are: until
    /// a mark succeeds, or, if a sync failed, until the store is reopened.
    pub fn blocked(&self) -> Option<StoreError> {
        self.io.blocked()
    }

    /// Makes every later sync of `main.log` fail (or stop failing), as a
    /// failing disk would: for tests.
    #[doc(hidden)]
    pub fn fail_syncs(&self, fail: bool) {
        self.io.fail_syncs(fail);
    }

    /// Counts for diagnostics.
    pub fn counters(&self) -> Counters {
        Counters {
            files_created: self.files_created,
            syncs_here: self.syncs_here,
            background_syncs: self.hold.background_syncs(),
        }
    }

    /// Starts a new log generation with `prepared`'s files ([`prepare`]):
    /// appends from here on go to them, and this generation's files are
    /// frozen. Returns the cut at the rotation, at the game's time `time`.
    /// It only swaps handles; the next clock mark makes what this
    /// generation wrote since the last one durable, as it would have.
    pub fn rotate(
        &mut self,
        prepared: Prepared<C::Key>,
        time: u64,
    ) -> Result<LogCut<C::Key>, StoreError> {
        if prepared.generation != self.generation + 1 {
            return Err(StoreError::Sequence(format!(
                "log generation {} was made to follow generation {}, but the log is at \
                 generation {}",
                prepared.generation,
                prepared.generation - 1,
                self.generation
            )));
        }
        if self.poisoned {
            return Err(StoreError::Poisoned);
        }
        let old_gen = self.generation;
        // What a sync holds goes to the files it was appended to.
        self.hold.settle();
        {
            // The I/O thread appends clock marks under this lock: from here
            // on they go to the new `main.log`.
            let mut main = lock(&self.main);
            let old = std::mem::replace(&mut *main, prepared.main);
            self.carried.push(old.to_sync());
            self.frozen.push(CutFile {
                path: old.path,
                key: None,
                len: old.len,
                generation: old_gen,
            });
        }
        for (key, file) in std::mem::replace(&mut self.keyed, prepared.keyed) {
            if file.dirty {
                self.carried.push(file.to_sync());
            }
            self.frozen.push(CutFile {
                path: file.path,
                key: Some(key),
                len: file.len,
                generation: old_gen,
            });
        }
        self.open_keyed = 0;
        self.generation += 1;
        self.has_entries = false;
        crash::point("rotate");
        Ok(self.cut(time))
    }

    /// Where every file ends now, holding the entries through
    /// [`Log::last_seq`], at the game's time `time`: see [`LogCut`].
    pub fn cut(&self, time: u64) -> LogCut<C::Key> {
        // Its readers read the files to these lengths: what a sync holds
        // must be in them first.
        self.hold.settle();
        let mut files = Vec::with_capacity(self.frozen.len() + self.keyed.len() + 1);
        files.extend(self.frozen.iter().cloned());
        {
            // The I/O thread appends clock marks under this lock.
            let main = lock(&self.main);
            files.push(CutFile {
                path: main.path.clone(),
                key: None,
                len: main.len,
                generation: self.generation,
            });
        }
        for (key, file) in &self.keyed {
            files.push(CutFile {
                path: file.path.clone(),
                key: Some(key.clone()),
                len: file.len,
                generation: self.generation,
            });
        }
        LogCut {
            dir: self.dir.clone(),
            last_seq: self.last_seq,
            time,
            files,
            generation: self.generation,
        }
    }

    /// Makes every frozen file of the generations not yet known durable
    /// durable, with their directories: what must hold before a base whose
    /// tail starts in the generation appended to is written. Waits for the
    /// disk.
    pub fn sync_frozen(&mut self) -> Result<(), StoreError> {
        sync_frozen(
            &self.dir,
            self.frozen
                .iter()
                .filter(|f| f.generation >= self.durable_below)
                .map(|f| f.path.as_path()),
        )
    }

    /// Notes that the game wrote a base whose tail starts in `generation`:
    /// the generations below it are durable, and needn't be named again.
    pub fn note_base(&mut self, generation: u64) {
        self.durable_below = self.durable_below.max(generation);
        let below = self.durable_below;
        self.frozen.retain(|f| f.generation >= below);
    }

    /// The first generation not known durable.
    pub fn durable_below(&self) -> u64 {
        self.durable_below
    }

    /// Makes every log file and the log directory durable, waiting for
    /// each: for a copy of a log, written all at once and synced at the
    /// end.
    pub fn sync_all(&mut self) -> Result<(), StoreError> {
        self.wait()?;
        for file in self.keyed.values() {
            file.push()?;
        }
        lock(&self.main).push()?;
        for dir in std::mem::take(&mut self.unnamed) {
            durable::push_dir(&dir)?;
        }
        if self.generation > 0 {
            durable::push_dir(&gens::gen_dir(&self.dir, self.generation))?;
        }
        sync_dir(&log_dir(&self.dir))
    }

    /// How many keyed files are open, and how many have unsynced writes.
    #[cfg(test)]
    pub(crate) fn keyed_handles(&self) -> (usize, usize) {
        let open = self.keyed.values().filter(|f| f.file.is_some()).count();
        let dirty = self.keyed.values().filter(|f| f.dirty).count();
        assert_eq!(open, self.open_keyed);
        (open, dirty)
    }

    /// Closes the key's file, as making room for another would.
    #[cfg(test)]
    pub(crate) fn close_keyed(&mut self, key: &C::Key) {
        if let Some(file) = self.keyed.get_mut(key)
            && file.file.is_some()
        {
            file.close();
            self.open_keyed -= 1;
        }
    }

    /// How many names the key's file defines.
    #[cfg(test)]
    pub(crate) fn keyed_names(&self, key: &C::Key) -> usize {
        self.keyed.get(key).map_or(0, |f| f.names.len())
    }

    #[cfg(test)]
    pub(crate) fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Writes raw records to `main.log`, as the I/O thread writes a mark.
    #[cfg(test)]
    pub(crate) fn write_main(&self, bytes: &[u8]) -> Result<(), StoreError> {
        lock(&self.main).write(bytes, &self.hold)
    }

    #[cfg(test)]
    pub(crate) fn io(&self) -> &Io {
        &self.io
    }

    #[cfg(test)]
    pub(crate) fn hold(&self) -> &Arc<Hold> {
        &self.hold
    }
}

/// Writes `store.meta` through a temporary file and a rename, durable.
pub(crate) fn write_meta(dir: &Path, meta: &[u8]) -> Result<(), StoreError> {
    let path = dir.join(META_FILE);
    let tmp = dir.join(format!(".{META_FILE}.tmp"));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(io_err(&tmp))?;
    file.write_all(meta).map_err(io_err(&tmp))?;
    durable::full(&file, &tmp).map_err(io_err(&tmp))?;
    drop(file);
    fs::rename(&tmp, &path).map_err(io_err(&path))?;
    sync_dir(dir)
}

/// Refuses to create a store over log files that hold anything: only an
/// empty `main.log`, left by a creation cut short, may be overwritten.
fn check_no_entries(logs: &Path) -> Result<(), StoreError> {
    for item in fs::read_dir(logs).map_err(io_err(logs))? {
        let item = item.map_err(io_err(logs))?;
        let name = item.file_name().to_string_lossy().into_owned();
        let path = item.path();
        let empty_main = name == MAIN_LOG
            && fs::read(&path)
                .map_err(io_err(&path))
                .map(|bytes| format::scan(&bytes).is_ok_and(|s| s.records.is_empty()))?;
        if !empty_main && !name.starts_with('.') {
            return Err(StoreError::Meta {
                path,
                reason: format!(
                    "a log file exists but {META_FILE} does not; refusing to create a store \
                     over it"
                ),
            });
        }
    }
    Ok(())
}
