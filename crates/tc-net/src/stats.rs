//! Counters of the network work, shared by every session: what was
//! written, the bulk lane's messages and their compression. Read them with
//! [`IoCounters::snapshot`]; subtract two snapshots for a span
//! ([`IoStats::since`]).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// The live counters.
#[derive(Debug, Default)]
pub struct IoCounters {
    frames_written: AtomicU64,
    messages_written: AtomicU64,
    bytes_written: AtomicU64,
    writes: AtomicU64,
    bulks: AtomicU64,
    bulk_data_bytes: AtomicU64,
    bulk_bytes: AtomicU64,
    bulks_deflated: AtomicU64,
    deflate_in_bytes: AtomicU64,
    deflate_ns: AtomicU64,
}

/// A copy of the counters at one moment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IoStats {
    /// Frames (messages of the protocol) the sessions wrote, each frame a
    /// `Bulk` carries counted.
    pub frames_written: u64,
    /// WebSocket messages they made of them: a `Bulk` is one.
    pub messages_written: u64,
    /// Their bytes.
    pub bytes_written: u64,
    /// Writes (one flush each).
    pub writes: u64,
    /// `Bulk` messages written.
    pub bulks: u64,
    /// Their data before compression.
    pub bulk_data_bytes: u64,
    /// Their bytes as written (compressed or not).
    pub bulk_bytes: u64,
    /// `Bulk`s whose data was compressed, smaller or not.
    pub bulks_deflated: u64,
    /// Their data before compression.
    pub deflate_in_bytes: u64,
    /// The time spent compressing it, microseconds.
    pub deflate_us: u64,
}

impl IoStats {
    /// What happened between `earlier` and `self`.
    pub fn since(&self, earlier: &IoStats) -> IoStats {
        IoStats {
            frames_written: self.frames_written - earlier.frames_written,
            messages_written: self.messages_written - earlier.messages_written,
            bytes_written: self.bytes_written - earlier.bytes_written,
            writes: self.writes - earlier.writes,
            bulks: self.bulks - earlier.bulks,
            bulk_data_bytes: self.bulk_data_bytes - earlier.bulk_data_bytes,
            bulk_bytes: self.bulk_bytes - earlier.bulk_bytes,
            bulks_deflated: self.bulks_deflated - earlier.bulks_deflated,
            deflate_in_bytes: self.deflate_in_bytes - earlier.deflate_in_bytes,
            deflate_us: self.deflate_us - earlier.deflate_us,
        }
    }
}

fn add(counter: &AtomicU64, n: u64) {
    counter.fetch_add(n, Ordering::Relaxed);
}

impl IoCounters {
    /// A session wrote `frames` frames in `messages` WebSocket messages of
    /// `bytes` in all with one flush.
    pub fn wrote(&self, frames: u64, messages: u64, bytes: u64) {
        add(&self.frames_written, frames);
        add(&self.messages_written, messages);
        add(&self.bytes_written, bytes);
        add(&self.writes, 1);
    }

    /// A session packed a `Bulk` of `bytes`, carrying `data` bytes before
    /// compression.
    pub fn bulk(&self, data: usize, bytes: usize) {
        add(&self.bulks, 1);
        add(&self.bulk_data_bytes, data as u64);
        add(&self.bulk_bytes, bytes as u64);
    }

    /// `data` bytes were compressed in `took`.
    pub fn deflated(&self, data: usize, took: Duration) {
        add(&self.bulks_deflated, 1);
        add(&self.deflate_in_bytes, data as u64);
        add(
            &self.deflate_ns,
            u64::try_from(took.as_nanos()).unwrap_or(u64::MAX),
        );
    }

    /// The counters now.
    pub fn snapshot(&self) -> IoStats {
        let get = |c: &AtomicU64| c.load(Ordering::Relaxed);
        IoStats {
            frames_written: get(&self.frames_written),
            messages_written: get(&self.messages_written),
            bytes_written: get(&self.bytes_written),
            writes: get(&self.writes),
            bulks: get(&self.bulks),
            bulk_data_bytes: get(&self.bulk_data_bytes),
            bulk_bytes: get(&self.bulk_bytes),
            bulks_deflated: get(&self.bulks_deflated),
            deflate_in_bytes: get(&self.deflate_in_bytes),
            deflate_us: get(&self.deflate_ns) / 1000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_subtracts() {
        let io = IoCounters::default();
        io.wrote(3, 2, 100);
        let a = io.snapshot();
        io.wrote(1, 1, 10);
        io.bulk(50, 20);
        io.deflated(50, Duration::from_micros(7));
        let d = io.snapshot().since(&a);
        assert_eq!(
            (d.frames_written, d.messages_written, d.bytes_written),
            (1, 1, 10)
        );
        assert_eq!((d.bulks, d.bulk_data_bytes, d.bulk_bytes), (1, 50, 20));
        assert_eq!(
            (d.bulks_deflated, d.deflate_in_bytes, d.deflate_us),
            (1, 50, 7)
        );
    }
}
