//! [`BulkTicket`]: a bulk-lane frame the game can withdraw until its
//! session takes it (to replace a queued frame with a newer one).

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

const QUEUED: u8 = 0;
const TAKEN: u8 = 1;
const WITHDRAWN: u8 = 2;

/// A bulk-lane frame that can be withdrawn until the session takes it.
/// The session calls [`BulkTicket::take`] before writing the frame and
/// skips it if it was withdrawn; the game calls
/// [`BulkTicket::withdraw`] to replace a queued frame with a newer one.
#[derive(Clone, Debug, Default)]
pub struct BulkTicket(Arc<AtomicU8>);

impl BulkTicket {
    /// A ticket for a frame about to be queued.
    pub fn new() -> BulkTicket {
        BulkTicket::default()
    }

    /// The session takes the frame: true to write it, false if it was
    /// withdrawn. Once taken it can't be withdrawn.
    pub fn take(&self) -> bool {
        match self
            .0
            .compare_exchange(QUEUED, TAKEN, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => true,
            Err(state) => state == TAKEN,
        }
    }

    /// Withdraws the frame unless the session took it; true if it will
    /// never be written.
    pub fn withdraw(&self) -> bool {
        match self
            .0
            .compare_exchange(QUEUED, WITHDRAWN, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => true,
            Err(state) => state == WITHDRAWN,
        }
    }

    /// True once the session took the frame.
    pub fn taken(&self) -> bool {
        self.0.load(Ordering::Acquire) == TAKEN
    }

    /// True once the frame was withdrawn: it will never be written.
    pub fn withdrawn(&self) -> bool {
        self.0.load(Ordering::Acquire) == WITHDRAWN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taken_or_withdrawn_once() {
        let t = BulkTicket::new();
        assert!(t.take());
        assert!(!t.withdraw());
        assert!(t.taken() && !t.withdrawn());
        let t = BulkTicket::new();
        assert!(t.withdraw());
        assert!(!t.take());
        assert!(t.withdrawn() && !t.taken());
        // Both stick.
        assert!(t.withdraw());
    }
}
