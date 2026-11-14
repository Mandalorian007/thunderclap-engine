//! The log file format, version 1. Little-endian throughout.
//!
//! ```text
//! file     = "TCLOG" u16:format records*
//! record   = u32:payload_len u8:kind payload u64:checksum
//! checksum = StableHasher(write_u8(kind), write_bytes(payload))
//! kind 1   = name definition: u32:local_id str:name
//! kind 2   = log entry: u64:seq u64:time event
//! kind 3   = clock mark covering every entry before it: u64:time
//! kind 4   = clock mark: u64:time u64:covers
//! kind 5   = batch: u64:first u64:last
//! kind 6   = clock mark: u64:time u64:covers u64:wall
//! str      = u32:len utf8
//! event    = the game's bytes (its codec's: `crate::LogCodec`)
//! ```
//!
//! The checksum is `tc_wire::hash::StableHasher`'s. Kinds 1 to 6 are the
//! engine's, and their numbers are the ones Forge Wilds' log has always
//! used; an entry's event is the game's own (its tag byte and fields, with
//! the numbers the game gives them). Kinds 7 and up are reserved for the
//! engine: a reader refuses them.
//!
//! A payload is at most [`MAX_PAYLOAD`] bytes (1 MiB): the writer refuses a
//! larger entry, and the reader treats a larger length as damage (a torn
//! tail if nothing intact follows), so a corrupt length never makes it
//! allocate or read more.
//!
//! Clock marks are only in `main.log`. A kind 4 or 6 mark names the last
//! entry it covers: every entry with sequence `<= covers`, in every file,
//! was on disk before the mark was written. A kind 6 mark also carries the
//! wall-clock time it was asked for, in seconds since the Unix epoch
//! (UTC): it maps the game's times to real ones, and nothing replayed
//! reads it. A kind 3 mark covers every entry before it in `main.log`'s
//! order (Forge Wilds' first marks, written once every file was synced).
//! The store writes kind 6 (kind 4 when it writes again a mark that had no
//! wall time) and reads all three.
//!
//! A batch record says the entries `first..=last` are kept all or none. It
//! is written to every file the batch writes to, in the same write as, and
//! just before, the batch's first entry (and its name records) in that
//! file, so a batch entry that survives a crash always has its batch
//! record before it.
//!
//! Entries may refer to strings by file-local ids, each defined by a name
//! record earlier in the same file (see `crate::Names`).
//!
//! This format must stay readable forever: never change an encoding; add a
//! new kind, or a new format version, instead.

use tc_wire::hash::StableHasher;

/// File magic.
pub const MAGIC: &[u8; 5] = b"TCLOG";
/// Current format version.
pub const FORMAT: u16 = 1;
/// Magic plus format.
pub const HEADER_LEN: usize = 7;
/// Record kind: name definition.
pub const KIND_NAME: u8 = 1;
/// Record kind: log entry.
pub const KIND_ENTRY: u8 = 2;
/// Record kind: clock mark covering everything before it in `main.log`
/// (read only; see the module docs).
pub const KIND_CLOCK: u8 = 3;
/// Record kind: clock mark naming the last entry it covers.
pub const KIND_MARK: u8 = 4;
/// Record kind: the entries of one batch, kept all or none.
pub const KIND_BATCH: u8 = 5;
/// Record kind: clock mark naming the last entry it covers and the wall
/// time it was asked for.
pub const KIND_WALL_MARK: u8 = 6;
/// The largest payload: the writer refuses larger ones, and the reader
/// treats a larger length as damage.
pub const MAX_PAYLOAD: usize = 1 << 20;
/// `u32` length plus `u8` kind.
const RECORD_HEAD: usize = 5;
const CHECKSUM_LEN: usize = 8;
/// An entry's payload before the game's bytes: its sequence and time.
pub const ENTRY_HEAD: usize = 16;

/// The file header.
pub fn header() -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[..5].copy_from_slice(MAGIC);
    h[5..].copy_from_slice(&FORMAT.to_le_bytes());
    h
}

fn checksum(kind: u8, payload: &[u8]) -> u64 {
    let mut h = StableHasher::new();
    h.write_u8(kind);
    h.write_bytes(payload);
    h.finish()
}

/// Appends one framed record to `out`.
///
/// # Panics
///
/// If the payload is over [`MAX_PAYLOAD`] bytes (the store checks entries
/// before they get here; every other record is a few bytes).
pub fn push_record(out: &mut Vec<u8>, kind: u8, payload: &[u8]) {
    assert!(
        payload.len() <= MAX_PAYLOAD,
        "a {}-byte record payload is over the limit",
        payload.len()
    );
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out.extend_from_slice(&checksum(kind, payload).to_le_bytes());
}

/// One framed record found by [`scan`].
#[derive(Clone, Debug)]
pub struct RawRecord<'a> {
    /// Where it starts in the file.
    pub offset: u64,
    /// The offset just past the record.
    pub end: u64,
    /// Its kind.
    pub kind: u8,
    /// Its payload.
    pub payload: &'a [u8],
}

/// The intact records of a file, and where they end. `valid_len` is less
/// than the file length when the file ends in a torn record (or header);
/// `valid_len == 0` means not even the header is complete.
#[derive(Clone, Debug)]
pub struct Scan<'a> {
    /// The records, in order.
    pub records: Vec<RawRecord<'a>>,
    /// Where the last intact record ends.
    pub valid_len: usize,
}

/// Damage that isn't a torn tail: `(offset, reason)`.
pub type ScanError = (u64, String);

/// Splits a file into records.
///
/// A damaged record with no intact record anywhere after it is a torn write
/// (a crash mid-append, possibly leaving garbage or zeros) and ends the
/// scan. A damaged record followed by an intact one is real corruption and
/// an error.
pub fn scan(bytes: &[u8]) -> Result<Scan<'_>, ScanError> {
    match scan_prefix(bytes) {
        (scan, None) => Ok(scan),
        (_, Some(error)) => Err(error),
    }
}

/// Like [`scan`], but damage before the tail ends the scan instead of
/// failing it: the intact records before the damage, and the damage (for a
/// check or a repair).
pub fn scan_prefix(bytes: &[u8]) -> (Scan<'_>, Option<ScanError>) {
    let empty = Scan {
        records: Vec::new(),
        valid_len: 0,
    };
    let head = header();
    if bytes.len() < HEADER_LEN {
        return if head.starts_with(bytes) {
            (empty, None)
        } else {
            (empty, Some((0, "not a ThunderClap log file".into())))
        };
    }
    if &bytes[..5] != MAGIC {
        return (empty, Some((0, "not a ThunderClap log file".into())));
    }
    let format = u16::from_le_bytes([bytes[5], bytes[6]]);
    if format != FORMAT {
        return (empty, Some((5, format!("unsupported log format {format}"))));
    }

    let mut records = Vec::new();
    let mut pos = HEADER_LEN;
    let mut error = None;
    while pos < bytes.len() {
        match record_at(bytes, pos) {
            Some((record, end)) => {
                records.push(record);
                pos = end;
            }
            None if intact_record_after(bytes, pos) => {
                error = Some((pos as u64, damage(bytes, pos)));
                break;
            }
            None => break,
        }
    }
    (
        Scan {
            records,
            valid_len: pos,
        },
        error,
    )
}

/// Splits bytes that hold only complete records (a piece of a file the
/// store has finished writing, starting at a record) into records, with
/// offsets from `base`. Anything else is an error: `(offset, reason)`.
pub fn records_in(bytes: &[u8], base: u64) -> Result<Vec<RawRecord<'_>>, ScanError> {
    let mut records = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        match record_at(bytes, pos) {
            Some((mut record, end)) => {
                record.offset += base;
                record.end += base;
                records.push(record);
                pos = end;
            }
            None => {
                return Err((
                    base + pos as u64,
                    "not a complete record where one was written".into(),
                ));
            }
        }
    }
    Ok(records)
}

/// True if `bytes` start with this format's header.
pub fn is_header(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER_LEN && bytes[..HEADER_LEN] == header()
}

/// Why the record at `pos` isn't intact, when an intact one follows it.
fn damage(bytes: &[u8], pos: usize) -> String {
    let len = bytes
        .get(pos..pos + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    match len {
        Some(len) if len > MAX_PAYLOAD => format!(
            "damaged record: its length {len} is over the {MAX_PAYLOAD}-byte limit, and \
             intact records follow"
        ),
        _ => "damaged record (bad length or checksum) followed by intact records".into(),
    }
}

/// The complete record starting at `pos` with a matching checksum, and
/// where it ends. A length over [`MAX_PAYLOAD`] is damage, never read.
fn record_at(bytes: &[u8], pos: usize) -> Option<(RawRecord<'_>, usize)> {
    let rest = bytes.get(pos..)?;
    let len = u32::from_le_bytes(rest.get(..4)?.try_into().ok()?) as usize;
    if len > MAX_PAYLOAD {
        return None;
    }
    let size = RECORD_HEAD + len + CHECKSUM_LEN;
    let record = rest.get(..size)?;
    let kind = record[4];
    let payload = &record[RECORD_HEAD..RECORD_HEAD + len];
    let sum = u64::from_le_bytes(record[RECORD_HEAD + len..].try_into().ok()?);
    (sum == checksum(kind, payload)).then_some((
        RawRecord {
            offset: pos as u64,
            end: (pos + size) as u64,
            kind,
            payload,
        },
        pos + size,
    ))
}

/// True if an intact record of a known kind starts anywhere after `pos`.
fn intact_record_after(bytes: &[u8], pos: usize) -> bool {
    (pos + 1..bytes.len()).any(|p| {
        record_at(bytes, p).is_some_and(|(r, _)| {
            matches!(
                r.kind,
                KIND_NAME | KIND_ENTRY | KIND_CLOCK | KIND_MARK | KIND_BATCH | KIND_WALL_MARK
            )
        })
    })
}

/// Encodes a name definition payload.
pub fn encode_name(local: u32, name: &str) -> Vec<u8> {
    let mut w = Writer::default();
    w.u32(local);
    w.str(name);
    w.0
}

/// Decodes a name definition payload.
pub fn decode_name(payload: &[u8]) -> Result<(u32, String), String> {
    let mut r = Reader::new(payload);
    let out = (r.u32()?, r.str()?);
    r.finish()?;
    Ok(out)
}

/// Encodes an entry's payload head: its sequence and time (the game's
/// bytes follow).
pub fn encode_entry_head(out: &mut Vec<u8>, seq: u64, time: u64) {
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&time.to_le_bytes());
}

/// Splits an entry's payload: `(seq, time, the game's bytes)`.
pub fn decode_entry_head(payload: &[u8]) -> Result<(u64, u64, &[u8]), String> {
    let mut r = Reader::new(payload);
    let seq = r.u64()?;
    let time = r.u64()?;
    Ok((seq, time, r.rest()))
}

/// Encodes a kind 3 clock mark payload (only old files hold them).
pub fn encode_clock(time: u64) -> Vec<u8> {
    time.to_le_bytes().to_vec()
}

/// Decodes a kind 3 clock mark payload.
pub fn decode_clock(payload: &[u8]) -> Result<u64, String> {
    let mut r = Reader::new(payload);
    let t = r.u64()?;
    r.finish()?;
    Ok(t)
}

/// Encodes a clock mark payload that names the last entry it covers.
pub fn encode_mark(time: u64, covers: u64) -> Vec<u8> {
    let mut w = Writer::default();
    w.u64(time);
    w.u64(covers);
    w.0
}

/// Decodes a clock mark payload that names the last entry it covers:
/// `(time, covers)`.
pub fn decode_mark(payload: &[u8]) -> Result<(u64, u64), String> {
    let mut r = Reader::new(payload);
    let out = (r.u64()?, r.u64()?);
    r.finish()?;
    Ok(out)
}

/// Encodes a clock mark payload with the wall time it was asked for
/// (seconds since the Unix epoch).
pub fn encode_wall_mark(time: u64, covers: u64, wall: u64) -> Vec<u8> {
    let mut w = Writer::default();
    w.u64(time);
    w.u64(covers);
    w.u64(wall);
    w.0
}

/// Decodes a clock mark payload with a wall time: `(time, covers, wall)`.
pub fn decode_wall_mark(payload: &[u8]) -> Result<(u64, u64, u64), String> {
    let mut r = Reader::new(payload);
    let out = (r.u64()?, r.u64()?, r.u64()?);
    r.finish()?;
    Ok(out)
}

/// Appends a clock mark record to `out`: kind 6 with a wall time, kind 4
/// without one (a mark read without one, written again).
pub fn push_mark(out: &mut Vec<u8>, time: u64, covers: u64, wall: Option<u64>) {
    match wall {
        Some(wall) => push_record(out, KIND_WALL_MARK, &encode_wall_mark(time, covers, wall)),
        None => push_record(out, KIND_MARK, &encode_mark(time, covers)),
    }
}

/// Encodes a batch record payload: the batch's first and last entries.
pub fn encode_batch(first: u64, last: u64) -> Vec<u8> {
    let mut w = Writer::default();
    w.u64(first);
    w.u64(last);
    w.0
}

/// Decodes a batch record payload: `(first, last)`.
pub fn decode_batch(payload: &[u8]) -> Result<(u64, u64), String> {
    let mut r = Reader::new(payload);
    let out = (r.u64()?, r.u64()?);
    r.finish()?;
    if out.0 > out.1 {
        return Err(format!("batch of entries {} to {} is empty", out.0, out.1));
    }
    Ok(out)
}

/// Builds a payload: fixed-width little-endian fields, and strings as a
/// `u32` length and UTF-8. A codec may use it, or write its bytes any way
/// it likes (`tc_wire`'s varints, say).
#[derive(Clone, Debug, Default)]
pub struct Writer(pub Vec<u8>);

impl Writer {
    /// A `u8`.
    pub fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    /// A `u16`.
    pub fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// A `u32`.
    pub fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// A `u64`.
    pub fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// An `i32`.
    pub fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// An `i64`.
    pub fn i64(&mut self, v: i64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// A string: its length as a `u32`, then its bytes.
    pub fn str(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.0.extend_from_slice(s.as_bytes());
    }
}

/// Reads what a [`Writer`] wrote; every read fails cleanly at the end of
/// input.
#[derive(Clone, Debug)]
pub struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    /// Reads `bytes` from the start.
    pub fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes }
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let head = self.bytes(N)?;
        let mut out = [0u8; N];
        out.copy_from_slice(head);
        Ok(out)
    }

    /// The next `n` bytes as they are.
    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.bytes.len() < n {
            return Err("payload ends early".into());
        }
        let (head, rest) = self.bytes.split_at(n);
        self.bytes = rest;
        Ok(head)
    }
    /// A `u8`.
    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take::<1>()?[0])
    }
    /// A `u16`.
    pub fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    /// A `u32`.
    pub fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    /// A `u64`.
    pub fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take()?))
    }
    /// An `i32`.
    pub fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take()?))
    }
    /// An `i64`.
    pub fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.take()?))
    }
    /// A string written by [`Writer::str`].
    pub fn str(&mut self) -> Result<String, String> {
        let len = self.u32()? as usize;
        let bytes = self.bytes(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| "invalid UTF-8".to_string())
    }
    /// Everything not read yet.
    pub fn rest(&mut self) -> &'a [u8] {
        std::mem::take(&mut self.bytes)
    }
    /// Fails if anything is left.
    pub fn finish(&self) -> Result<(), String> {
        if self.bytes.is_empty() {
            Ok(())
        } else {
            Err(format!("{} trailing bytes", self.bytes.len()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The checksums are Forge Wilds' (the same hasher), so its pinned
    /// records are pinned here too.
    #[test]
    fn clock_marks_are_pinned() {
        let record = |kind: u8, payload: &[u8]| -> String {
            let mut file = Vec::new();
            push_record(&mut file, kind, payload);
            hex(&file)
        };
        assert_eq!(
            record(KIND_CLOCK, &encode_clock(30200)),
            concat!("0800000003", "f875000000000000", "9b0198e941497260")
        );
        assert_eq!(
            record(KIND_MARK, &encode_mark(600, 7)),
            concat!(
                "1000000004",
                "5802000000000000", // time
                "0700000000000000", // covers
                "1643ad6bb9f48c8a", // checksum
            )
        );
        let payload = encode_mark(u64::MAX, u64::MAX - 1);
        assert_eq!(decode_mark(&payload).unwrap(), (u64::MAX, u64::MAX - 1));
        assert!(decode_mark(&payload[..15]).is_err());
        assert!(decode_mark(&encode_clock(1)).is_err());
    }

    #[test]
    fn the_header_is_pinned() {
        assert_eq!(hex(&header()), "54434c4f470100");
        assert!(is_header(&header()));
        assert!(!is_header(b"FWLOG\x01\x00"));
    }

    #[test]
    fn wall_marks_are_pinned() {
        let mut file = Vec::new();
        push_mark(&mut file, 600, 7, Some(1_791_500_000));
        let hex = hex(&file);
        assert_eq!(&hex[..10], "1800000006", "len 24, kind 6");
        assert_eq!(
            &hex[10..58],
            concat!(
                "5802000000000000", // time
                "0700000000000000", // covers
                "e01ec86a00000000", // wall: 1,791,500,000 s
            )
        );
        let payload = encode_wall_mark(u64::MAX, 3, u64::MAX);
        assert_eq!(decode_wall_mark(&payload).unwrap(), (u64::MAX, 3, u64::MAX));
        assert!(decode_wall_mark(&payload[..23]).is_err());
        assert!(decode_wall_mark(&encode_mark(1, 2)).is_err());
        // Without a wall time it is kind 4.
        let mut old = Vec::new();
        push_mark(&mut old, 600, 7, None);
        let mut four = Vec::new();
        push_record(&mut four, KIND_MARK, &encode_mark(600, 7));
        assert_eq!(old, four);
        // A wall mark is a known record: damage before one isn't a torn tail.
        let mut damaged = file_with(2);
        damaged.extend_from_slice(&file);
        damaged[HEADER_LEN + 6] ^= 0xff;
        assert!(scan(&damaged).is_err());
    }

    #[test]
    fn a_damaged_record_before_a_mark_is_not_a_torn_tail() {
        let mut file = file_with(2);
        let first = file.len();
        push_record(&mut file, KIND_MARK, &encode_mark(9, 3));
        let mut damaged = file.clone();
        damaged[HEADER_LEN + 6] ^= 0xff;
        assert!(scan(&damaged).is_err());
        // A torn mark is a torn tail.
        let s = scan(&file[..file.len() - 3]).unwrap();
        assert_eq!((s.records.len(), s.valid_len), (2, first));
    }

    fn file_with(records: usize) -> Vec<u8> {
        let mut file = header().to_vec();
        for i in 0..records {
            push_record(&mut file, KIND_CLOCK, &encode_clock(i as u64));
        }
        file
    }

    #[test]
    fn scan_reads_whole_files() {
        let file = file_with(3);
        let s = scan(&file).unwrap();
        assert_eq!(s.records.len(), 3);
        assert_eq!(s.valid_len, file.len());
        assert_eq!(decode_clock(s.records[2].payload).unwrap(), 2);
        let records = records_in(&file[HEADER_LEN..], HEADER_LEN as u64).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].offset, HEADER_LEN as u64);
        assert!(records_in(&file[HEADER_LEN..file.len() - 1], 0).is_err());
    }

    #[test]
    fn scan_stops_at_a_torn_tail() {
        let full = file_with(3);
        let two = file_with(2).len();
        for cut in two + 1..full.len() {
            let s = scan(&full[..cut]).unwrap();
            assert_eq!(s.records.len(), 2, "cut at {cut}");
            assert_eq!(s.valid_len, two);
        }
        // A garbled checksum on the last record is a torn write too.
        let mut garbled = full.clone();
        let last = garbled.len() - 1;
        garbled[last] ^= 0xff;
        assert_eq!(scan(&garbled).unwrap().valid_len, two);
        // Garbage or zeros after the last good record (no intact record follows).
        for fill in [0x00u8, 0xff, 0x5a] {
            let mut tail = full.clone();
            tail.extend_from_slice(&[fill; 100]);
            let s = scan(&tail).unwrap();
            assert_eq!((s.records.len(), s.valid_len), (3, full.len()));
        }
        // A torn header.
        for cut in 0..HEADER_LEN {
            let s = scan(&full[..cut]).unwrap();
            assert_eq!((s.records.len(), s.valid_len), (0, 0));
        }
    }

    #[test]
    fn batch_records_are_pinned() {
        let mut file = Vec::new();
        push_record(&mut file, KIND_BATCH, &encode_batch(7, 9));
        assert_eq!(
            hex(&file),
            concat!(
                "1000000005",
                "0700000000000000", // first
                "0900000000000000", // last
                "172ac98492bf5a47", // checksum
            )
        );
        assert_eq!(decode_batch(&encode_batch(7, 9)).unwrap(), (7, 9));
        assert!(decode_batch(&encode_batch(9, 7)).is_err());
        assert!(decode_batch(&encode_batch(7, 9)[..15]).is_err());
    }

    #[test]
    fn entry_heads_and_names_round_trip() {
        let mut payload = Vec::new();
        encode_entry_head(&mut payload, 42, 9000);
        payload.extend_from_slice(b"game");
        assert_eq!(payload.len(), ENTRY_HEAD + 4);
        assert_eq!(
            decode_entry_head(&payload).unwrap(),
            (42, 9000, &b"game"[..])
        );
        assert!(decode_entry_head(&payload[..15]).is_err());
        assert_eq!(
            decode_name(&encode_name(3, "oak")).unwrap(),
            (3, "oak".to_string())
        );
        let mut bad = encode_name(3, "oak");
        bad.push(0);
        assert!(decode_name(&bad).is_err());
    }

    /// A length over the limit is never read: at the end of a file it is a
    /// torn tail, before intact records an error that says why.
    #[test]
    fn an_implausible_length_is_damage_not_an_allocation() {
        let full = file_with(3);
        let two = file_with(2).len();
        for len in [MAX_PAYLOAD as u32 + 1, u32::MAX] {
            let mut torn = full.clone();
            torn[two..two + 4].copy_from_slice(&len.to_le_bytes());
            let s = scan(&torn).unwrap();
            assert_eq!((s.records.len(), s.valid_len), (2, two));

            let mut damaged = full.clone();
            damaged[HEADER_LEN..HEADER_LEN + 4].copy_from_slice(&len.to_le_bytes());
            let (offset, reason) = scan(&damaged).err().unwrap();
            assert_eq!(offset, HEADER_LEN as u64);
            assert!(reason.contains("over the 1048576-byte limit"), "{reason}");
        }
        // The largest payload is read; the writer refuses one byte more.
        let mut file = header().to_vec();
        push_record(&mut file, KIND_ENTRY, &vec![0u8; MAX_PAYLOAD]);
        assert_eq!(scan(&file).unwrap().records.len(), 1);
        let over = std::panic::catch_unwind(|| {
            push_record(&mut Vec::new(), KIND_ENTRY, &vec![0u8; MAX_PAYLOAD + 1]);
        });
        assert!(over.is_err());
    }

    #[test]
    fn scan_rejects_damage_before_the_tail() {
        let mut file = file_with(3);
        file[HEADER_LEN + 6] ^= 0xff; // inside the first payload
        let (offset, reason) = scan(&file).err().unwrap();
        assert_eq!(offset, HEADER_LEN as u64);
        assert!(reason.contains("checksum"));

        let mut huge = file_with(3);
        huge[HEADER_LEN..HEADER_LEN + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(scan(&huge).is_err());

        assert!(scan(b"NOTALOG").is_err());
        assert!(scan(b"FWLOG\x01\x00").is_err(), "Forge's own magic");
        let mut v2 = file_with(0);
        v2[5] = 2;
        assert!(scan(&v2).err().unwrap().1.contains("format 2"));
        // A prefix of the header is a torn one; anything else isn't a log.
        assert_eq!(scan(b"TCL").unwrap().valid_len, 0);
        assert!(scan(b"TCX").is_err());
    }
}
