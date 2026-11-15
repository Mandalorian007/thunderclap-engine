//! [`SimCounters`]: what the loop did, for benches, budgets and the
//! status. Counts and microseconds only; nothing here reaches the game.

/// The loop's work so far ([`Sim::counters`](crate::Sim::counters), and
/// [`SimStatus::counters`](crate::SimStatus)). A bench reads two and
/// subtracts ([`SimCounters::since`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SimCounters {
    /// [`Sim::tick`](crate::Sim::tick) calls.
    pub ticks: u64,
    /// Steps the game clock moved.
    pub steps: u64,
    /// [`Game::live_step`](crate::Game::live_step) calls.
    pub live_steps: u64,
    /// [`Game::wake`](crate::Game::wake) calls.
    pub wakes: u64,
    /// Commands handled ([`Game::act`](crate::Game::act)).
    pub commands: u64,
    /// Input ticks that took inputs.
    pub input_ticks: u64,
    /// Inputs taken ([`Game::input`](crate::Game::input)).
    pub inputs: u64,
    /// Flushes (for everyone or one connection).
    pub flushes: u64,
    /// Entity stream runs ([`Game::entities`](crate::Game::entities)).
    pub entity_runs: u64,
    /// Entity frames sent.
    pub entity_frames: u64,
    /// Entity views split into fields: once per change of a thing,
    /// however many streams see it ([`tc_net::ViewCache`]).
    pub entity_splits: u64,
    /// Batches logged and applied.
    pub batches: u64,
    /// Events logged and applied.
    pub events: u64,
    /// Batches of events [`Game::after_batch`](crate::Game::after_batch)
    /// added to a batch (counted in `batches` too).
    pub rule_batches: u64,
    /// Senders closed at a command's flush, over their byte budget with
    /// its effects to send
    /// ([`SimConfig::close_slow_senders`](crate::SimConfig::close_slow_senders)).
    pub closed_slow: u64,
    /// Live hooks (live step, wake, act) that changed what
    /// [`Game::hash_state`](crate::Game::hash_state) covers: a game bug,
    /// found only with [`SimConfig::verify_live`](crate::SimConfig::verify_live).
    /// Should stay 0.
    pub live_misses: u64,
    /// Microseconds in live steps and wakes.
    pub live_us: u64,
    /// Microseconds in input ticks.
    pub input_us: u64,
    /// Microseconds in flushes.
    pub flush_us: u64,
}

impl SimCounters {
    /// The work done since `earlier` (each field's difference).
    pub fn since(&self, earlier: &SimCounters) -> SimCounters {
        SimCounters {
            ticks: self.ticks.saturating_sub(earlier.ticks),
            steps: self.steps.saturating_sub(earlier.steps),
            live_steps: self.live_steps.saturating_sub(earlier.live_steps),
            wakes: self.wakes.saturating_sub(earlier.wakes),
            commands: self.commands.saturating_sub(earlier.commands),
            input_ticks: self.input_ticks.saturating_sub(earlier.input_ticks),
            inputs: self.inputs.saturating_sub(earlier.inputs),
            flushes: self.flushes.saturating_sub(earlier.flushes),
            entity_runs: self.entity_runs.saturating_sub(earlier.entity_runs),
            entity_frames: self.entity_frames.saturating_sub(earlier.entity_frames),
            entity_splits: self.entity_splits.saturating_sub(earlier.entity_splits),
            batches: self.batches.saturating_sub(earlier.batches),
            events: self.events.saturating_sub(earlier.events),
            rule_batches: self.rule_batches.saturating_sub(earlier.rule_batches),
            closed_slow: self.closed_slow.saturating_sub(earlier.closed_slow),
            live_misses: self.live_misses.saturating_sub(earlier.live_misses),
            live_us: self.live_us.saturating_sub(earlier.live_us),
            input_us: self.input_us.saturating_sub(earlier.input_us),
            flush_us: self.flush_us.saturating_sub(earlier.flush_us),
        }
    }
}

/// Microseconds since `start`, saturating.
pub(crate) fn micros(start: std::time::Instant) -> u64 {
    u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_subtracts_each_field() {
        let a = SimCounters {
            steps: 10,
            live_steps: 4,
            ..SimCounters::default()
        };
        let b = SimCounters {
            steps: 25,
            live_steps: 9,
            flushes: 2,
            ..SimCounters::default()
        };
        let d = b.since(&a);
        assert_eq!((d.steps, d.live_steps, d.flushes), (15, 5, 2));
        assert_eq!(a.since(&b), SimCounters::default());
    }
}
