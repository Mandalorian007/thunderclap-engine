//! The game's side of the log: [`LogCodec`] encodes and decodes its events
//! and says which file each goes in; [`Names`] and [`NameTable`] are the
//! file's name table.

use std::collections::HashMap;
use std::fmt::Debug;

/// One entry of the log: the game's event at a sequence number and a time.
/// The store writes `seq` and `time`; the event's bytes are the codec's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry<E> {
    /// Its sequence number: entries are numbered from 1, without gaps.
    pub seq: u64,
    /// The game's time when it happened, in the game's units. The store
    /// only keeps it (clock marks carry a time too).
    pub time: u64,
    /// The game's event.
    pub event: E,
}

/// How a game's events are written to the log.
///
/// An entry record's payload is the entry's sequence number and time, then
/// the bytes [`LogCodec::encode`] writes: the game's own tag byte and
/// fields, in any layout (tags are the game's to number). Decoding must
/// give back the event encoded, and should fail on anything else.
///
/// Events go to the main log, or to a file of their own by a key
/// ([`LogCodec::key`]), say a region of a map or a table of a board game,
/// so a key's events can be read without the rest. A codec without keys
/// uses `std::convert::Infallible` as its `Key`.
///
/// Strings an event repeats (content names, say) can go in the file's name
/// table: [`Names::id`] gives a small id for a string, written once per
/// file as a name record, and [`NameTable::get`] reads it back.
pub trait LogCodec: Send + Sync + 'static {
    /// The game's event.
    type Event: Send;
    /// A file key: entries with the same key go to the same file.
    type Key: Clone + Ord + Debug + Send + Sync + 'static;

    /// The file `event` goes in: `None` for the main log.
    fn key(&self, event: &Self::Event) -> Option<Self::Key>;

    /// The file name for `key`, in a generation's directory. It must end
    /// in `.log`, not be [`crate::MAIN_LOG`], not start with `.`, hold no
    /// path separator, and read back as `key` through
    /// [`LogCodec::parse_file_name`]: the store refuses a file otherwise.
    fn file_name(&self, key: &Self::Key) -> String;

    /// The key a file name is for, if it is one: only names
    /// [`LogCodec::file_name`] gives (opening refuses any other file in
    /// the log directory).
    fn parse_file_name(&self, name: &str) -> Option<Self::Key>;

    /// Appends `event`'s bytes to `out`, taking ids for the strings it
    /// names from `names`.
    fn encode(
        &self,
        event: &Self::Event,
        names: &mut Names<'_>,
        out: &mut Vec<u8>,
    ) -> Result<(), String>;

    /// Reads an event from all of `bytes` (what [`LogCodec::encode`]
    /// wrote), reading the strings it names from `names`.
    fn decode(&self, bytes: &[u8], names: &NameTable) -> Result<Self::Event, String>;
}

/// A file's name table while an entry is encoded: [`Names::id`] gives the
/// id of a string, a new one if the file hasn't named it yet (written as a
/// name record before the entry, in the same write).
pub struct Names<'a> {
    known: &'a HashMap<String, u32>,
    pub(crate) new: Vec<(String, u32)>,
}

impl<'a> Names<'a> {
    pub(crate) fn new(known: &'a HashMap<String, u32>) -> Names<'a> {
        Names {
            known,
            new: Vec::new(),
        }
    }

    /// The file's id for `name`.
    pub fn id(&mut self, name: &str) -> u32 {
        if let Some(id) = self.known.get(name) {
            return *id;
        }
        if let Some((_, id)) = self.new.iter().find(|(n, _)| n == name) {
            return *id;
        }
        let id = (self.known.len() + self.new.len()) as u32;
        self.new.push((name.to_string(), id));
        id
    }
}

impl FromIterator<(u32, String)> for NameTable {
    /// A table defining each `(id, name)`; the first of an id wins.
    fn from_iter<I: IntoIterator<Item = (u32, String)>>(iter: I) -> NameTable {
        let mut table = NameTable::new();
        for (id, name) in iter {
            table.define(id, name);
        }
        table
    }
}

/// A file's name table as it is read: the strings its name records define
/// so far.
#[derive(Debug, Default)]
pub struct NameTable {
    names: HashMap<u32, String>,
}

impl NameTable {
    /// An empty table: for a codec's tests, or a game decoding records it
    /// read itself.
    pub fn new() -> NameTable {
        NameTable::default()
    }

    /// The string the file's id `id` names, if a name record defined it.
    pub fn get(&self, id: u32) -> Option<&str> {
        self.names.get(&id).map(String::as_str)
    }

    /// Defines `id` as `name`, as a name record does; false (and nothing
    /// changes) if it was already defined.
    pub fn define(&mut self, id: u32, name: String) -> bool {
        match self.names.entry(id) {
            std::collections::hash_map::Entry::Occupied(_) => false,
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(name);
                true
            }
        }
    }
}
