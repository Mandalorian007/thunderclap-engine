//! Counters of the network work, shared by every session: what was
//! written, the bulk lane's messages and their compression, and how long
//! priority frames waited (**priority wait**: from a frame being queued on
//! a connection's priority lane to its session having written it to the
//! socket). Read them with [`IoCounters::snapshot`]; subtract two
//! snapshots for a span ([`IoStats::since`]).
//!
//! A game keeps its own counters beside them, in the same snapshot:
//! [`GAME_COUNTERS`] numbers ([`IoCounters::game_add`],
//! [`IoCounters::game_set`]) and [`GAME_WAITS`] latency histograms
//! ([`IoCounters::game_wait`]), by index, each meaning what the game says.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// How many numbers a game may keep in [`IoCounters`].
pub const GAME_COUNTERS: usize = 8;

/// How many latency histograms a game may keep in [`IoCounters`].
pub const GAME_WAITS: usize = 4;

/// Upper bounds of the latency buckets, in microseconds.
const BOUNDS_US: [u64; 16] = [
    100,
    250,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
    50_000,
    100_000,
    200_000,
    500_000,
    1_000_000,
    2_000_000,
    5_000_000,
    u64::MAX,
];

/// A latency histogram with fixed buckets, shared between threads.
#[derive(Debug, Default)]
pub struct Histogram {
    buckets: [AtomicU64; BOUNDS_US.len()],
    sum_us: AtomicU64,
    max_us: AtomicU64,
}

impl Histogram {
    /// Counts one wait.
    pub fn record(&self, wait: Duration) {
        let us = u64::try_from(wait.as_micros()).unwrap_or(u64::MAX);
        let i = BOUNDS_US
            .iter()
            .position(|b| us <= *b)
            .unwrap_or(BOUNDS_US.len() - 1);
        self.buckets[i].fetch_add(1, Ordering::Relaxed);
        self.sum_us.fetch_add(us, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
    }

    /// The waits so far.
    pub fn snapshot(&self) -> Latency {
        Latency {
            buckets: std::array::from_fn(|i| self.buckets[i].load(Ordering::Relaxed)),
            sum_us: self.sum_us.load(Ordering::Relaxed),
            max_us: self.max_us.load(Ordering::Relaxed),
        }
    }
}

/// A copy of a [`Histogram`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Latency {
    /// Waits per bucket (see [`Latency::quantile`]).
    pub buckets: [u64; BOUNDS_US.len()],
    /// All the waits, in microseconds.
    pub sum_us: u64,
    /// The longest wait so far (not reset by [`Latency::since`]).
    pub max_us: u64,
}

impl Latency {
    /// Waits counted.
    pub fn count(&self) -> u64 {
        self.buckets.iter().sum()
    }

    /// The mean wait.
    pub fn mean(&self) -> Duration {
        Duration::from_micros(self.sum_us.checked_div(self.count()).unwrap_or(0))
    }

    /// An upper bound on the `q` quantile (0 to 1): the top of the bucket
    /// that holds it (100, 250, 500 µs; 1, 2, 5, 10, 20, 50, 100, 200,
    /// 500 ms; 1, 2, 5 s; never more than the longest wait).
    pub fn quantile(&self, q: f64) -> Duration {
        let n = self.count();
        if n == 0 {
            return Duration::ZERO;
        }
        let rank = ((q * n as f64).ceil() as u64).clamp(1, n);
        let mut seen = 0;
        for (i, b) in self.buckets.iter().enumerate() {
            seen += b;
            if seen >= rank {
                return Duration::from_micros(BOUNDS_US[i].min(self.max_us));
            }
        }
        Duration::from_micros(self.max_us)
    }

    /// The waits between `earlier` and `self` (the longest stays
    /// `self`'s).
    pub fn since(&self, earlier: &Latency) -> Latency {
        Latency {
            buckets: std::array::from_fn(|i| self.buckets[i] - earlier.buckets[i]),
            sum_us: self.sum_us - earlier.sum_us,
            max_us: self.max_us,
        }
    }
}

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
    prio_wait: Histogram,
    game: [AtomicU64; GAME_COUNTERS],
    game_waits: [Histogram; GAME_WAITS],
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
    /// From a priority frame being queued to being written.
    pub prio_wait: Latency,
    /// The game's numbers, by index ([`IoCounters::game_add`]).
    pub game: [u64; GAME_COUNTERS],
    /// The game's waits, by index ([`IoCounters::game_wait`]).
    pub game_waits: [Latency; GAME_WAITS],
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
            prio_wait: self.prio_wait.since(&earlier.prio_wait),
            game: std::array::from_fn(|i| self.game[i] - earlier.game[i]),
            game_waits: std::array::from_fn(|i| self.game_waits[i].since(&earlier.game_waits[i])),
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

    /// A priority frame waited `wait` from being queued to being written.
    pub fn prio_waited(&self, wait: Duration) {
        self.prio_wait.record(wait);
    }

    /// Adds `n` to the game's number `i`.
    ///
    /// # Panics
    ///
    /// If `i` is not below [`GAME_COUNTERS`].
    pub fn game_add(&self, i: usize, n: u64) {
        add(&self.game[i], n);
    }

    /// Sets the game's number `i` (a gauge, or a total the game keeps).
    ///
    /// # Panics
    ///
    /// If `i` is not below [`GAME_COUNTERS`].
    pub fn game_set(&self, i: usize, value: u64) {
        self.game[i].store(value, Ordering::Relaxed);
    }

    /// Counts one wait in the game's histogram `i`.
    ///
    /// # Panics
    ///
    /// If `i` is not below [`GAME_WAITS`].
    pub fn game_wait(&self, i: usize, wait: Duration) {
        self.game_waits[i].record(wait);
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
            prio_wait: self.prio_wait.snapshot(),
            game: std::array::from_fn(|i| get(&self.game[i])),
            game_waits: std::array::from_fn(|i| self.game_waits[i].snapshot()),
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

    #[test]
    fn waits_and_the_games_counters_are_kept_beside_them() {
        let io = IoCounters::default();
        io.game_add(0, 5);
        io.game_set(7, 9);
        io.prio_waited(Duration::from_millis(3));
        io.game_wait(3, Duration::from_millis(1));
        let a = io.snapshot();
        io.game_add(0, 2);
        io.prio_waited(Duration::from_millis(40));
        let d = io.snapshot().since(&a);
        assert_eq!((a.game[0], a.game[7], d.game[0], d.game[7]), (5, 9, 2, 0));
        assert_eq!((a.prio_wait.count(), d.prio_wait.count()), (1, 1));
        assert_eq!(d.prio_wait.quantile(1.0), Duration::from_millis(40));
        assert_eq!((a.game_waits[3].count(), d.game_waits[3].count()), (1, 0));
    }

    #[test]
    fn quantiles_are_bucket_tops() {
        let h = Histogram::default();
        for ms in [1, 1, 1, 3, 40, 900] {
            h.record(Duration::from_millis(ms));
        }
        let l = h.snapshot();
        assert_eq!(l.count(), 6);
        assert_eq!(l.quantile(0.5), Duration::from_millis(1));
        assert_eq!(l.quantile(0.6), Duration::from_millis(5));
        assert_eq!(l.quantile(0.7), Duration::from_millis(50));
        assert_eq!(l.quantile(1.0), Duration::from_millis(900));
        assert_eq!(l.mean(), Duration::from_micros(946 * 1000 / 6));
        assert_eq!(Latency::default().quantile(0.5), Duration::ZERO);
    }
}
