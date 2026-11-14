//! Flow control on the bulk lane: how much bulk data a session keeps in
//! flight to a client that acknowledges it (`ClientMsg::Ack`).
//!
//! Without it a session hands the socket every `Bulk` the game
//! builds, and on a slow link the bytes wait in socket buffers and the
//! network's queues, where everything written after them waits too: on a
//! 4 Mbit/s link a player's inputs (their `PlayerState`), entity frames,
//! and chat waited 0.8 to 1.1 s behind a view's bulk data. The priority
//! lane can only go first inside the server; once written, bytes are in
//! line.
//!
//! So a client says what it has taken: after each `Bulk` it handles it
//! sends the bytes of every `Bulk` taken so far. The session keeps the
//! bytes written and not yet acknowledged (in flight) under a window:
//!
//! > window = delivery rate × (round trip + [`MARGIN`])
//!
//! The **delivery rate** is measured from the acks as TCP's BBR measures
//! it: for each acknowledged write, the bytes acknowledged since the
//! acknowledgement before it was written, over the longer of the time
//! that took and the time the session took to write them (so a burst of
//! acks after a stall doesn't read as a fast link), the highest of the
//! last [`RATE_WINDOW`] and [`RATE_ROUNDS`] round trips (so a client that
//! stopped acking for a while, a page in the background, comes back to
//! the rate it had: the one slow sample its stall shows isn't all that is
//! left of it). A write sent while the session had nothing more to send
//! says only that the link is at least that fast, so it counts only if it
//! raises the rate. The **round trip** is the shortest time from
//! a write to its ack in the last [`MIN_RTT_LIFE`]: the link's own delay,
//! the write's serialization, and the client's handling, with no queue.
//! The margin is the most the queue may hold: what a priority message
//! written now waits for. Without the round trip in it (a window of the
//! rate times a fixed time), a link whose round trip was longer than that
//! time could never fill its pipe, and views loaded 3 to 7 times slower.
//!
//! A link busy for longer than [`MIN_RTT_LIFE`] keeps its queue at the
//! margin, so no write sees the bare round trip again; then the session
//! lets what is in flight drain, writes one batch into the empty link, and
//! takes its round trip as the new one (as BBR's ProbeRTT does), so a
//! round trip that grew is learned and the queue never feeds itself.
//!
//! Writes go in batches of about a quarter of the window ([`Flow::batch`],
//! from [`MIN_BATCH`] to `session::BATCH_BYTES`), each once the acks make
//! room for it and paced at [`PACING_GAIN`] times the delivery rate: the
//! next waits until the link has about carried the last. Without the pace
//! a view's bulk data built while the link was idle (a moving player's
//! next frames) went out as a whole window at once and queued in front of
//! the inputs after it (a flight's input round trip p99 was 160 to 190 ms
//! on a 4 Mbit/s, 60 ms link; paced, 125 to 135). Until the rate is found
//! the pace is [`STARTUP_GAIN`] (as BBR's startup): each round trip
//! measures up to twice the rate of the last, so a fast link is found in a
//! few round trips rather than growing a quarter at a time (a tailnet view
//! was slower than unpaced at 1.25 alone); it is found once
//! [`FULL_ROUNDS`] round trips that kept the link busy raised it by less
//! than a quarter. Bytes are what
//! the socket carries (a `Bulk`'s whole encoding), so deflating its data
//! ([`crate::deflate`]) fits about twice the bulk data in the same window.
//!
//! The game keeps about two windows queued for a session that has
//! one ([`Flow::high_water`]), down from [`BULK_HIGH_WATER`]: frames
//! queued far ahead of what the link can carry go stale for a moving player, and
//! the nearest ones it needs next wait behind them.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// How long past the round trip the window keeps bulk data in flight:
/// the most a priority message waits behind bulk data on a link the
/// bulk data fills.
pub const MARGIN: Duration = Duration::from_millis(50);

/// How much faster than the delivery rate writes are paced: faster, so a
/// link that got faster is measured faster, and the window (not the pace)
/// bounds what is in flight while the link is full.
pub const PACING_GAIN: f64 = 1.25;

/// The pace while the rate is still being found (BBR's startup): writes
/// go twice as fast as the rate measured, so it doubles each round trip
/// until the link is full.
pub const STARTUP_GAIN: f64 = 2.0;

/// The rate is found once this many round trips in a row didn't raise it
/// by a quarter.
pub const FULL_ROUNDS: u8 = 3;

/// The window before the first round trip is measured.
pub const INITIAL_WINDOW: usize = 64 * 1024;

/// The smallest window: one batch, at least.
pub const MIN_WINDOW: usize = 16 * 1024;

/// The largest window; a fast link with a short round trip never reaches
/// it (the game queues at most [`BULK_HIGH_WATER`]).
pub const MAX_WINDOW: usize = 8 * 1024 * 1024;

/// The smallest batch a session writes while the window has room.
pub const MIN_BATCH: usize = 4 * 1024;

/// The largest: `session::BATCH_BYTES`.
pub const MAX_BATCH: usize = 64 * 1024;

/// The delivery rate is the highest measured in this long and in the
/// last [`RATE_ROUNDS`] round trips.
pub const RATE_WINDOW: Duration = Duration::from_secs(2);

/// The delivery rate is the highest measured in the last this many round
/// trips, and in [`RATE_WINDOW`]: time alone would forget a
/// link's rate over a stall in the acks (a page in the background, a long
/// pause on the client's main thread), leaving only the stall's own sample
/// and pacing a 4 Mbit/s link's next writes at a few KB/s. Fewer than
/// BBR's ten: a link that really slowed keeps a queue in front of the
/// priority lane until its old rate is forgotten.
pub const RATE_ROUNDS: u64 = 4;

/// The longest a write waits on the pace: however slow a rate was
/// measured, the next batch goes in this long after the last.
pub const PACE_MAX: Duration = Duration::from_secs(1);

/// The most writes in flight: an honest client has a handful (a window is
/// about four batches); this bounds what one that stops acknowledging
/// costs while the bulk lane trickles small frames.
pub const MAX_WRITES: usize = 1024;

/// How long a round trip measured counts before a link that stayed busy
/// is drained to measure it again.
pub const MIN_RTT_LIFE: Duration = Duration::from_secs(10);

/// The longest a drain to measure the round trip waits for its write's
/// ack before giving up (keeping the old round trip).
pub const PROBE_MAX: Duration = Duration::from_secs(1);

/// The game queues no new bulk frames for a connection holding more than this many
/// bytes of bulk data not yet taken by its session.
pub const BULK_HIGH_WATER: usize = 512 * 1024;

/// The game keeps at least this much queued for a session with a
/// window.
pub const MIN_HIGH_WATER: usize = 64 * 1024;

/// One write's bytes in flight, and what was delivered when it was
/// written.
#[derive(Clone, Copy, Debug)]
struct Write {
    /// Bulk bytes written up to and including this write.
    end: u64,
    /// When it was written.
    at: Instant,
    /// Bytes acknowledged when it was written, and when the last of them
    /// was.
    delivered: u64,
    delivered_at: Instant,
    /// When the last write acknowledged by then had been written.
    first_at: Instant,
    /// The session had nothing more to send.
    app_limited: bool,
    /// Written into an empty link to measure the round trip.
    probe: bool,
}

/// The highest of recent samples.
#[derive(Debug, Default)]
struct MaxFilter {
    /// Samples with when and in which round trip each was taken, oldest
    /// first, each higher than every later one.
    samples: VecDeque<(Instant, u64, f64)>,
}

impl MaxFilter {
    /// Adds a sample taken at `at` in round trip `round`; samples older
    /// than both `window` and `rounds` round trips are forgotten.
    fn add(&mut self, at: Instant, round: u64, value: f64, window: Duration, rounds: u64) {
        while self.samples.back().is_some_and(|&(_, _, v)| v <= value) {
            self.samples.pop_back();
        }
        self.samples.push_back((at, round, value));
        // The newest always stays: a rate is kept while the link is idle.
        while self.samples.len() > 1
            && self.samples.front().is_some_and(|&(t, r, _)| {
                at.saturating_duration_since(t) > window && round.saturating_sub(r) > rounds
            })
        {
            self.samples.pop_front();
        }
        // Each sample is a write acknowledged, and at most `MAX_WRITES`
        // are in flight a round trip; a client acknowledging oddly gets no
        // more than this.
        if self.samples.len() > MAX_WRITES {
            self.samples.pop_front();
        }
    }

    fn max(&self) -> Option<f64> {
        self.samples.front().map(|&(_, _, v)| v)
    }
}

/// Why an ack was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckError {
    /// It acknowledged bytes never written.
    TooMany,
}

/// One session's flow control on its bulk lane. Times are passed in, so
/// tests drive it with made-up ones.
#[derive(Debug)]
pub struct Flow {
    /// Bulk bytes written, and acknowledged.
    sent: u64,
    acked: u64,
    /// When the last ack came, and when the write it acknowledged last had
    /// been written.
    acked_at: Instant,
    acked_sent_at: Instant,
    /// Writes not yet wholly acknowledged, oldest first.
    writes: VecDeque<Write>,
    /// Delivery rate samples, bytes a second.
    rate: MaxFilter,
    /// The shortest round trip, and when it was measured.
    min_rtt: Option<Duration>,
    min_rtt_at: Instant,
    /// Draining to measure the round trip: since when.
    probing: Option<Instant>,
    window: usize,
    /// The pace: no write before this.
    next_write: Instant,
    /// Finding the rate: paced at [`STARTUP_GAIN`].
    filling: bool,
    /// Round trips so far, and the bytes written when the current one
    /// began: it ends when they are acknowledged.
    round: u64,
    round_end: u64,
    /// The rate at the last round trip that raised it by a quarter, and
    /// the round trips since.
    full_rate: f64,
    flat_rounds: u8,
}

impl Flow {
    /// A connection's flow control, from its first ack at `now`, with
    /// `sent` bulk bytes written before it (in flight, unmeasured).
    pub fn new(now: Instant, sent: u64) -> Flow {
        Flow {
            sent,
            acked: 0,
            acked_at: now,
            acked_sent_at: now,
            writes: VecDeque::new(),
            rate: MaxFilter::default(),
            min_rtt: None,
            min_rtt_at: now,
            probing: None,
            window: INITIAL_WINDOW,
            next_write: now,
            filling: true,
            round: 0,
            round_end: sent,
            full_rate: 0.0,
            flat_rounds: 0,
        }
    }

    /// Bulk bytes written and not yet acknowledged.
    pub fn in_flight(&self) -> usize {
        usize::try_from(self.sent - self.acked).unwrap_or(usize::MAX)
    }

    /// The window: the most bulk bytes in flight.
    #[cfg(test)]
    pub fn window(&self) -> usize {
        self.window
    }

    /// The delivery rate measured, in bytes a second.
    #[cfg(test)]
    pub fn rate(&self) -> Option<f64> {
        self.rate.max()
    }

    /// The round trip measured.
    #[cfg(test)]
    pub fn min_rtt(&self) -> Option<Duration> {
        self.min_rtt
    }

    /// The most bulk data a write takes: about a quarter of the window,
    /// so writes follow acks closely.
    pub fn batch(&self) -> usize {
        (self.window / 4).clamp(MIN_BATCH, MAX_BATCH)
    }

    /// True if the window has room for a batch of bulk data (or nothing
    /// is in flight); while draining to measure the round trip, only once
    /// everything was acknowledged. Never with [`MAX_WRITES`] in flight.
    pub fn has_room(&self) -> bool {
        let in_flight = self.in_flight();
        if self.probing.is_some() {
            return in_flight == 0;
        }
        in_flight == 0
            || (self.window.saturating_sub(in_flight) >= self.batch()
                && self.writes.len() < MAX_WRITES)
    }

    /// True if the session may write a batch of bulk data at `now`: the
    /// window has room for it and the pace allows it.
    pub fn may_write(&self, now: Instant) -> bool {
        self.has_room() && now >= self.next_write
    }

    /// How much faster than the rate measured writes are paced.
    pub fn pacing_gain(&self) -> f64 {
        if self.filling {
            STARTUP_GAIN
        } else {
            PACING_GAIN
        }
    }

    /// When the pace next allows a write the window has room for, if
    /// that is after `now`.
    pub fn paced_until(&self, now: Instant) -> Option<Instant> {
        (self.has_room() && self.next_write > now).then_some(self.next_write)
    }

    /// How much the game may keep queued for this session: about
    /// two windows, from [`MIN_HIGH_WATER`] to `cap`.
    pub fn high_water(&self, cap: usize) -> usize {
        self.window
            .saturating_mul(2)
            .clamp(MIN_HIGH_WATER.min(cap), cap)
    }

    /// A write of `bytes` of bulk data at `now` (a whole `Bulk`);
    /// `app_limited` if it took everything the bulk lane held.
    pub fn wrote(&mut self, bytes: usize, now: Instant, app_limited: bool) {
        if bytes == 0 {
            return;
        }
        // Into an idle link: delivery counts from now.
        if self.writes.is_empty() {
            self.acked_at = now;
            self.acked_sent_at = now;
        }
        let probe = self.probing.is_some();
        if self.probing.is_none() && now.saturating_duration_since(self.min_rtt_at) > MIN_RTT_LIFE {
            // Busy for too long to have seen the round trip: drain, then
            // measure it with the next write.
            self.probing = Some(now);
        }
        self.sent += bytes as u64;
        // The next write waits until the link has about carried this one,
        // so a burst of bulk data into an idle link is spread out rather
        // than queued in front of everything after it.
        if let Some(rate) = self.rate.max() {
            let gap = Duration::try_from_secs_f64(bytes as f64 / (rate * self.pacing_gain()))
                .map_or(PACE_MAX, |gap| gap.min(PACE_MAX));
            self.next_write = now + gap;
        }
        self.writes.push_back(Write {
            end: self.sent,
            at: now,
            delivered: self.acked,
            delivered_at: self.acked_at,
            first_at: self.acked_sent_at,
            app_limited,
            probe,
        });
    }

    /// An ack at `now` of `total` bulk bytes taken since the connection
    /// began. An ack of no more than the last is ignored.
    pub fn acked(&mut self, total: u64, now: Instant) -> Result<(), AckError> {
        if total > self.sent {
            return Err(AckError::TooMany);
        }
        if total <= self.acked {
            self.expire_probe(now);
            return Ok(());
        }
        self.acked = total;
        let mut last = None;
        while self.writes.front().is_some_and(|w| w.end <= total) {
            last = self.writes.pop_front();
        }
        self.acked_at = now;
        if let Some(w) = last {
            self.acked_sent_at = w.at;
            self.sample(&w, now);
        }
        self.expire_probe(now);
        self.update_window();
        Ok(())
    }

    /// Takes the round trip and delivery rate `w`'s ack at `now` shows.
    fn sample(&mut self, w: &Write, now: Instant) {
        let rtt = now.saturating_duration_since(w.at);
        if w.probe && self.probing.is_some() {
            // The round trip of a write into an empty link replaces the
            // old one, longer or not.
            self.min_rtt = Some(rtt);
            self.min_rtt_at = now;
            self.probing = None;
        } else if self.min_rtt.is_none_or(|m| rtt <= m) {
            self.min_rtt = Some(rtt);
            self.min_rtt_at = now;
        }
        let interval = now
            .saturating_duration_since(w.delivered_at)
            .max(w.at.saturating_duration_since(w.first_at));
        if interval.is_zero() {
            return;
        }
        let rate = (self.acked - w.delivered) as f64 / interval.as_secs_f64();
        if !w.app_limited || self.rate.max().is_none_or(|r| rate > r) {
            self.rate
                .add(now, self.round, rate, RATE_WINDOW, RATE_ROUNDS);
        }
        // A round trip ends when what was written at its start is
        // acknowledged. While finding the rate, one that had more to send
        // and didn't raise the rate by a quarter is flat; after a few, the
        // link is full.
        if self.acked < self.round_end {
            return;
        }
        self.round += 1;
        self.round_end = self.sent;
        if self.filling
            && let Some(rate) = self.rate.max().filter(|_| !w.app_limited)
        {
            if rate >= self.full_rate * 1.25 {
                self.full_rate = rate;
                self.flat_rounds = 0;
            } else {
                self.flat_rounds += 1;
                self.filling = self.flat_rounds < FULL_ROUNDS;
            }
        }
    }

    /// Gives up a drain whose write was never acknowledged in time.
    fn expire_probe(&mut self, now: Instant) {
        if self
            .probing
            .is_some_and(|since| now.saturating_duration_since(since) > PROBE_MAX)
        {
            self.probing = None;
            self.min_rtt_at = now;
        }
    }

    fn update_window(&mut self) {
        let (Some(rate), Some(rtt)) = (self.rate.max(), self.min_rtt) else {
            return;
        };
        let w = rate * (rtt + MARGIN).as_secs_f64();
        self.window = (w as usize).clamp(MIN_WINDOW, MAX_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A link: `rate` bytes a second, `rtt` round trip, written into by a
    /// session that always has bulk data, acked when each write has
    /// wholly arrived. Returns the flow after `secs`, the most bytes
    /// queued in the link (beyond what is on the wire) and the most time
    /// a write waited in it.
    fn run(rate: f64, rtt: Duration, secs: f64) -> (Flow, usize, Duration) {
        let t0 = Instant::now();
        let mut flow = Flow::new(t0, 0);
        // Writes in the link: when each finishes arriving, and its end.
        let mut link: VecDeque<(Instant, u64)> = VecDeque::new();
        let mut busy_until = t0;
        let mut now = t0;
        let step = Duration::from_micros(500);
        let mut max_wait = Duration::ZERO;
        let mut max_queued = 0;
        while now < t0 + Duration::from_secs_f64(secs) {
            // Acks that came back by now.
            while let Some(&(arrived, end)) = link.front() {
                if arrived + rtt / 2 > now {
                    break;
                }
                link.pop_front();
                flow.acked(end, arrived + rtt / 2).unwrap();
            }
            while flow.may_write(now) {
                let bytes = flow.batch();
                // Serialized after what is queued, then half a round trip.
                let start = busy_until.max(now);
                max_wait = max_wait.max(start - now);
                max_queued = max_queued.max(((start - now).as_secs_f64() * rate) as usize);
                busy_until = start + Duration::from_secs_f64(bytes as f64 / rate);
                flow.wrote(bytes, now, false);
                link.push_back((busy_until + rtt / 2, flow.sent));
            }
            now += step;
        }
        (flow, max_queued, max_wait)
    }

    #[test]
    fn a_slow_link_is_filled_with_a_short_queue() {
        // 4 Mbit/s, 60 ms.
        let (flow, _, wait) = run(500_000.0, Duration::from_millis(60), 20.0);
        let rate = flow.rate().unwrap();
        assert!((450_000.0..=520_000.0).contains(&rate), "rate {rate}");
        let rtt = flow.min_rtt().unwrap();
        assert!(rtt >= Duration::from_millis(60), "{rtt:?}");
        assert_eq!(flow.pacing_gain(), PACING_GAIN, "the rate was found");
        // The queue a priority message would wait behind, after the start.
        assert!(wait <= Duration::from_millis(150), "waited {wait:?}");
    }

    #[test]
    fn the_window_includes_the_round_trip() {
        // A long round trip: a window of rate times the margin alone
        // could not fill it.
        let (flow, _, _) = run(1_000_000.0, Duration::from_millis(200), 10.0);
        let rate = flow.rate().unwrap();
        assert!(rate > 900_000.0, "rate {rate}");
        assert!(flow.window() as f64 > rate * 0.2, "{}", flow.window());
    }

    #[test]
    fn a_fast_link_opens_the_window_wide() {
        let (flow, _, _) = run(50_000_000.0, Duration::from_millis(1), 2.0);
        assert!(flow.window() >= 1024 * 1024, "{}", flow.window());
        assert_eq!(flow.batch(), MAX_BATCH);
        assert_eq!(flow.high_water(512 * 1024), 512 * 1024);
    }

    #[test]
    fn writes_with_nothing_more_to_send_only_raise_the_rate() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut flow = Flow::new(t0, 0);
        flow.wrote(10_000, t0, false);
        flow.acked(10_000, t0 + ms(10)).unwrap();
        let rate = flow.rate().unwrap();
        assert_eq!(rate, 1_000_000.0);
        // Small writes into an idle link look slow; they don't count.
        flow.wrote(100, t0 + ms(20), true);
        flow.acked(10_100, t0 + ms(30)).unwrap();
        assert_eq!(flow.rate().unwrap(), rate);
    }

    #[test]
    fn a_busy_link_is_drained_to_measure_its_round_trip_again() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut flow = Flow::new(t0, 0);
        flow.wrote(1000, t0, false);
        flow.acked(1000, t0 + ms(10)).unwrap();
        assert_eq!(flow.min_rtt(), Some(ms(10)));
        // Later the link's round trip is 30 ms: kept at 10 until a drain.
        let mut now = t0 + ms(20);
        let mut sent = 1000;
        while now < t0 + MIN_RTT_LIFE + ms(100) {
            flow.wrote(1000, now, false);
            sent += 1000;
            assert!(flow.probing.is_none() || !flow.has_room());
            flow.acked(sent, now + ms(30)).unwrap();
            now += ms(40);
            if flow.probing.is_some() {
                break;
            }
        }
        assert!(flow.probing.is_some(), "draining");
        assert_eq!(flow.min_rtt(), Some(ms(10)));
        assert!(flow.has_room(), "everything was acknowledged");
        flow.wrote(1000, now, false);
        assert!(!flow.has_room(), "one write at a time while draining");
        flow.acked(sent + 1000, now + ms(30)).unwrap();
        assert_eq!(flow.min_rtt(), Some(ms(30)));
        assert!(flow.probing.is_none());
    }

    #[test]
    fn writes_into_an_idle_link_are_paced_at_the_rate() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut flow = Flow::new(t0, 0);
        // Unmeasured: no pace.
        flow.wrote(10_000, t0, false);
        assert!(flow.may_write(t0));
        flow.acked(10_000, t0 + ms(20)).unwrap();
        assert_eq!(flow.rate(), Some(500_000.0));
        // The window has room for several batches, but a batch goes only
        // once the link has about carried the one before (at twice the
        // rate while finding it, then 1.25 times): a burst doesn't queue
        // in front of priority messages.
        let now = t0 + ms(100);
        let batch = flow.batch();
        flow.wrote(batch, now, false);
        assert!(flow.has_room());
        assert!(!flow.may_write(now));
        let next = now + Duration::from_secs_f64(batch as f64 / (500_000.0 * STARTUP_GAIN));
        assert_eq!(flow.paced_until(now), Some(next));
        assert!(flow.may_write(next));
        assert_eq!(flow.paced_until(next), None);
    }

    #[test]
    fn an_ack_of_bytes_never_written_is_refused() {
        let t0 = Instant::now();
        let mut flow = Flow::new(t0, 0);
        assert_eq!(flow.acked(0, t0), Ok(()));
        flow.wrote(10, t0, false);
        assert_eq!(flow.acked(11, t0), Err(AckError::TooMany));
        assert_eq!(flow.acked(10, t0), Ok(()));
        assert_eq!(flow.in_flight(), 0);
    }

    /// A session that always has bulk data, writing into a link of 60 ms
    /// whose rate (bytes a second) at each moment from the start is
    /// `rate`, and whose client acknowledges nothing between `stall.0` and
    /// `stall.1` from the start (then everything it took). Returns the
    /// flow and the time from `from` to the next `bytes` written.
    fn drive(
        rate: impl Fn(Duration) -> f64,
        stall: (Duration, Duration),
        from: Duration,
        bytes: u64,
    ) -> (Flow, Duration) {
        let rtt = Duration::from_millis(60);
        let t0 = Instant::now();
        let mut flow = Flow::new(t0, 0);
        let mut link: VecDeque<(Instant, u64)> = VecDeque::new();
        let mut busy_until = t0;
        let mut now = t0;
        let mut start = None;
        loop {
            let t = now - t0;
            if t < stall.0 || t >= stall.1 {
                while let Some(&(arrived, end)) = link.front() {
                    if arrived + rtt / 2 > now {
                        break;
                    }
                    link.pop_front();
                    flow.acked(end, now).unwrap();
                }
            }
            if t >= from {
                let sent = *start.get_or_insert(flow.sent);
                if flow.sent - sent >= bytes {
                    return (flow, t - from);
                }
            }
            while flow.may_write(now) {
                let b = flow.batch();
                let at = busy_until.max(now);
                busy_until = at + Duration::from_secs_f64(b as f64 / rate(t));
                flow.wrote(b, now, false);
                link.push_back((busy_until + rtt / 2, flow.sent));
            }
            now += Duration::from_micros(500);
            assert!(
                t < from + Duration::from_secs(120),
                "never wrote {bytes} bytes"
            );
        }
    }

    #[test]
    fn a_client_that_stopped_acking_comes_back_to_its_rate() {
        let s = Duration::from_secs;
        // 4 Mbit/s: a megabyte in 2 s.
        let (_, steady) = drive(|_| 500_000.0, (s(0), s(0)), s(5), 1_000_000);
        // A page in the background for two minutes, mid-stream: the one
        // slow sample its acks show doesn't become the link's rate.
        let (flow, after) = drive(|_| 500_000.0, (s(5), s(125)), s(125), 1_000_000);
        assert!(flow.rate().unwrap() > 450_000.0, "{:?}", flow.rate());
        assert!(
            after.as_secs_f64() < steady.as_secs_f64() * 1.2,
            "a megabyte in {after:?} after the stall, {steady:?} before"
        );
    }

    #[test]
    fn a_link_that_slows_is_measured_slower() {
        let s = Duration::from_secs;
        // 4 Mbit/s, then 1 Mbit/s from 10 s on.
        let rate = |t: Duration| if t < s(10) { 500_000.0 } else { 125_000.0 };
        let (flow, _) = drive(rate, (s(0), s(0)), s(13), 10_000);
        let measured = flow.rate().unwrap();
        assert!((110_000.0..=140_000.0).contains(&measured), "{measured}");
    }

    #[test]
    fn a_client_that_stops_acking_holds_a_bounded_number_of_writes() {
        let t0 = Instant::now();
        let mut flow = Flow::new(t0, 0);
        // Small frames (a climate, an unload) fit the window by the
        // thousand; past `MAX_WRITES` the lane waits for acks.
        let mut n = 0;
        while flow.has_room() {
            flow.wrote(16, t0, true);
            n += 1;
            assert!(n <= MAX_WRITES, "{n} writes in flight");
        }
        assert_eq!(n, MAX_WRITES);
        flow.acked(16 * 1000, t0 + Duration::from_millis(60))
            .unwrap();
        assert!(flow.has_room());
    }
}
