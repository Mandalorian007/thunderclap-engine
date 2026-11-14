//! Compressing the bulk lane (`ServerMsg::Bulk`, codec
//! [`DEFLATE`](crate::codec::DEFLATE)) for clients that take it
//! (`Hello.bulk`).
//!
//! A `Bulk` whose data is over [`MIN_BYTES`] is compressed with raw
//! deflate (RFC 1951) at [`LEVEL`] before its session writes it, and goes
//! as it is if that isn't smaller; a smaller one isn't worth a round trip
//! through a compressor. Flow control ([`crate::flow`]) counts the data as
//! written and acknowledged (`Ack.bytes`), compressed: the same window
//! holds about twice the data.
//!
//! **Level 1.** Measured on a voxel game's world data (3.2 MiB of `Bulk`s;
//! Apple M4), level 1 leaves 45.1% of the bytes at 4.6 ms of CPU a MB;
//! level 2, 42.8% at 7.3 ms; level 6 (zlib's default), 40.9% at 21 ms. Each
//! level past 1 buys 2 to 4 points for 1.6 to 4.6 times the CPU.
//!
//! **Off the game thread.** Compression runs on a small pool of threads
//! ([`Deflater`], `tc-deflate-N`), at most a quarter of the machine's
//! cores ([`threads`]): never on the game's thread, and never on the tokio
//! workers that carry every session's priority frames. A session hands its
//! write's bulk frames to the pool and waits for the message before
//! writing the write, so its `Bulk` still follows the write's priority
//! frames and precedes the next write's. A pool that has gone (the server
//! stopping) leaves the session compressing on its own.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tc_wire::bulk;
use tokio::sync::oneshot;

use crate::envelope::{bulk_head, codec};
use crate::stats::IoCounters;
use crate::transport::Frame;

/// A `Bulk`'s data is compressed only if it is over this many bytes.
pub const MIN_BYTES: usize = 1024;

/// The deflate level (1 fastest, 9 smallest): see the [module docs](self).
pub const LEVEL: u8 = 1;

/// The largest data [`inflate`] gives back: far more than any `Bulk`
/// (a session write takes at most a few hundred KiB).
pub const MAX_INFLATED: usize = 64 * 1024 * 1024;

/// Threads in the pool: a quarter of the machine's cores, at least one.
pub fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| (n.get() / 4).max(1))
}

/// One encoded `Bulk`, as a session writes it.
#[derive(Debug)]
pub struct Packed {
    /// The whole message.
    pub message: Vec<u8>,
    /// How its data is coded.
    pub codec: u8,
    /// The data's bytes as coded: what the client acknowledges.
    pub data: usize,
    /// The data's bytes before compression.
    pub raw: usize,
    /// Whether it was compressed, smaller or not (`codec` says which).
    pub tried: bool,
}

/// Packs `frames` into one `Bulk`, compressed if `codec` allows it and
/// it pays (see the `deflate` module), counting the work in `io`.
pub fn pack<F: AsRef<[u8]>>(frames: &[F], codec: u8, io: &IoCounters) -> Packed {
    if codec != codec::DEFLATE {
        let codec = codec::NONE;
        // As before compression: one copy.
        let raw = bulk::data_len(frames);
        return Packed {
            message: bulk::pack(&bulk_head(codec), frames),
            codec,
            data: raw,
            raw,
            tried: false,
        };
    }
    let raw = bulk::data(frames);
    if raw.len() <= MIN_BYTES {
        return Packed {
            message: bulk::encode(&bulk_head(codec::NONE), &raw),
            codec: codec::NONE,
            data: raw.len(),
            raw: raw.len(),
            tried: false,
        };
    }
    let start = Instant::now();
    let compressed = miniz_oxide::deflate::compress_to_vec(&raw, LEVEL);
    io.deflated(raw.len(), start.elapsed());
    let (codec, data): (u8, &Vec<u8>) = if compressed.len() < raw.len() {
        (codec::DEFLATE, &compressed)
    } else {
        (codec::NONE, &raw)
    };
    Packed {
        message: bulk::encode(&bulk_head(codec), data),
        codec,
        data: data.len(),
        raw: raw.len(),
        tried: true,
    }
}

/// Inflates a `Bulk`'s data coded [`codec::DEFLATE`]: for clients
/// written in Rust (bots, benches, tests). `None` if it isn't raw deflate or
/// inflates past `MAX_INFLATED`.
pub fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    miniz_oxide::inflate::decompress_to_vec_with_limit(data, MAX_INFLATED).ok()
}

/// A write's bulk frames to pack, and where the `Bulk` goes.
struct Job {
    frames: Vec<Frame>,
    codec: u8,
    reply: oneshot::Sender<Packed>,
}

/// The pool that compresses every session's bulk lane. Cloning shares
/// it; its threads end once every clone is dropped.
#[derive(Clone, Debug)]
pub struct Deflater {
    jobs: mpsc::Sender<Job>,
    io: Arc<IoCounters>,
}

impl Deflater {
    /// Starts `threads` threads, counting their work in `io`.
    pub fn start(threads: usize, io: Arc<IoCounters>) -> std::io::Result<Deflater> {
        let (jobs, rx) = mpsc::channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..threads.max(1) {
            let rx = rx.clone();
            let io = io.clone();
            std::thread::Builder::new()
                .name(format!("tc-deflate-{i}"))
                .spawn(move || {
                    loop {
                        // One thread waits for the next job at a time; the
                        // others wait for the lock.
                        let job = match rx.lock() {
                            Ok(rx) => rx.recv(),
                            Err(_) => return,
                        };
                        let Ok(job) = job else {
                            return;
                        };
                        let _ = job.reply.send(pack(&job.frames, job.codec, &io));
                    }
                })?;
        }
        Ok(Deflater { jobs, io })
    }

    /// Packs `frames` into one `Bulk` of at most `codec`: on the pool if
    /// it may be compressed, else here (a copy, no compression).
    pub async fn pack(&self, frames: Vec<Frame>, codec: u8) -> Packed {
        if codec != codec::DEFLATE {
            return pack(&frames, codec, &self.io);
        }
        let (reply, packed) = oneshot::channel();
        match self.jobs.send(Job {
            frames,
            codec,
            reply,
        }) {
            Ok(()) => match packed.await {
                Ok(packed) => packed,
                // A thread died mid-job; a write of nothing would lose
                // its frames, so this never happens quietly.
                Err(_) => panic!("a deflate thread dropped a job"),
            },
            Err(mpsc::SendError(job)) => pack(&job.frames, job.codec, &self.io),
        }
    }
}

#[cfg(test)]
mod tests {
    use tc_wire::{Bytes, Wire};

    use super::*;
    use crate::envelope::ServerMsg;
    use crate::envelope::tests::Game;

    fn frame(x: u8, len: usize) -> Vec<u8> {
        ServerMsg::<Game>::EntityStream {
            data: Bytes(
                std::iter::once(x)
                    .chain((0..len).map(|i| (i % 7) as u8))
                    .collect(),
            ),
        }
        .to_bytes()
    }

    fn frames_of(packed: &Packed) -> Vec<Vec<u8>> {
        let ServerMsg::<Game>::Bulk { codec, data } =
            ServerMsg::<Game>::from_bytes(&packed.message).unwrap()
        else {
            panic!("not a Bulk");
        };
        assert_eq!(codec, packed.codec);
        assert_eq!(data.0.len(), packed.data);
        let data = match codec {
            codec::NONE => data.0,
            codec::DEFLATE => inflate(&data.0).unwrap(),
            other => panic!("codec {other}"),
        };
        assert_eq!(data.len(), packed.raw);
        bulk::frames(&data).map(|f| f.unwrap().to_vec()).collect()
    }

    #[test]
    fn data_over_a_kib_is_deflated_and_inflates_to_the_same_frames() {
        let io = IoCounters::default();
        let frames = vec![frame(1, 3000), frame(2, 10)];
        let packed = pack(&frames, codec::DEFLATE, &io);
        assert_eq!(packed.codec, codec::DEFLATE);
        assert!(
            packed.message.len() < packed.raw / 4,
            "{}",
            packed.message.len()
        );
        assert_eq!(frames_of(&packed), frames);
        let stats = io.snapshot();
        assert_eq!(
            (stats.bulks_deflated, stats.deflate_in_bytes),
            (1, packed.raw as u64)
        );
        // Plain when the client takes only that.
        let plain = pack(&frames, codec::NONE, &io);
        assert_eq!((plain.codec, plain.tried), (codec::NONE, false));
        assert_eq!(plain.message, bulk::pack(&bulk_head(codec::NONE), &frames));
        assert_eq!(frames_of(&plain), frames);
    }

    #[test]
    fn small_or_incompressible_data_goes_as_it_is() {
        let io = IoCounters::default();
        let small = vec![frame(1, 900)];
        let packed = pack(&small, codec::DEFLATE, &io);
        assert_eq!((packed.codec, packed.tried), (codec::NONE, false));
        assert_eq!(packed.message, bulk::pack(&bulk_head(codec::NONE), &small));
        assert_eq!(io.snapshot().bulks_deflated, 0);
        // Bytes that don't compress (a xorshift stream) go as they are.
        let mut x = 0x9e37_79b9_u32;
        let noise: Vec<u8> = (0..4000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        let noisy = vec![ServerMsg::<Game>::EntityStream { data: Bytes(noise) }.to_bytes()];
        let packed = pack(&noisy, codec::DEFLATE, &io);
        assert_eq!((packed.codec, packed.tried), (codec::NONE, true));
        assert_eq!(packed.message, bulk::pack(&bulk_head(codec::NONE), &noisy));
        assert_eq!(frames_of(&packed), noisy);
        // It was tried.
        assert_eq!(io.snapshot().bulks_deflated, 1);
    }

    #[test]
    fn the_pool_packs_off_the_caller_and_ends_with_its_handles() {
        let io = Arc::new(IoCounters::default());
        let deflater = Deflater::start(2, io.clone()).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let frames = vec![frame(3, 5000)];
        let packed = rt.block_on(deflater.pack(
            frames.iter().cloned().map(Frame::from).collect(),
            codec::DEFLATE,
        ));
        assert_eq!(packed.codec, codec::DEFLATE);
        assert_eq!(frames_of(&packed), frames);
        drop(deflater);
        // Bad data inflates to nothing.
        assert!(inflate(&[0xff, 0xff, 0xff]).is_none());
    }
}
