//! The wall clock that drives game time while the game is running.
//!
//! Running, game time (a count of fixed steps) advances one step per step
//! length of wall time, measured from an anchor so it never drifts however
//! late the game's thread wakes. Paused, it never advances. Wall time is
//! passed in so tests can drive it. `Welcome`, `Clock` and `Pong` carry
//! game time in steps and the step length (`step_us`).

use std::time::{Duration, Instant};

/// Maps wall time to game time, in steps.
#[derive(Clone, Copy, Debug)]
pub struct WallClock {
    step: Duration,
    /// `None` while paused.
    anchor: Option<Anchor>,
}

#[derive(Clone, Copy, Debug)]
struct Anchor {
    wall: Instant,
    time: u64,
}

impl WallClock {
    /// A clock of `step`-long steps that is paused, or running from `time`
    /// at `now`.
    ///
    /// # Panics
    ///
    /// If `step` is zero.
    pub fn new(step: Duration, paused: bool, now: Instant, time: u64) -> WallClock {
        assert!(!step.is_zero(), "a step takes some time");
        let mut clock = WallClock { step, anchor: None };
        if !paused {
            clock.run_from(now, time);
        }
        clock
    }

    /// One step's length.
    pub fn step(&self) -> Duration {
        self.step
    }

    /// One step's length in microseconds, as `Welcome.step_us` carries it.
    pub fn step_us(&self) -> u32 {
        u32::try_from(self.step.as_micros()).unwrap_or(u32::MAX)
    }

    /// True while paused.
    pub fn paused(&self) -> bool {
        self.anchor.is_none()
    }

    /// Stops the clock.
    pub fn pause(&mut self) {
        self.anchor = None;
    }

    /// Runs the clock from world time `time` at wall time `now`. Used to
    /// resume, and to re-anchor after world time jumps.
    pub fn run_from(&mut self, now: Instant, time: u64) {
        self.anchor = Some(Anchor { wall: now, time });
    }

    /// The game time it should be at `now`, or `None` while paused.
    pub fn target(&self, now: Instant) -> Option<u64> {
        let anchor = self.anchor?;
        let elapsed = now.saturating_duration_since(anchor.wall).as_nanos();
        let steps = u64::try_from(elapsed / self.step.as_nanos()).unwrap_or(u64::MAX);
        Some(anchor.time.saturating_add(steps))
    }

    /// When the step after `current` is due, or `None` while paused.
    pub fn next_step_at(&self, current: u64) -> Option<Instant> {
        let anchor = self.anchor?;
        let steps = current.saturating_sub(anchor.time).saturating_add(1);
        let nanos = u128::from(steps).saturating_mul(self.step.as_nanos());
        let nanos = u64::try_from(nanos).ok()?;
        anchor.wall.checked_add(Duration::from_nanos(nanos))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEP: Duration = Duration::from_millis(50);

    #[test]
    fn paused_never_advances() {
        let now = Instant::now();
        let clock = WallClock::new(STEP, true, now, 7);
        assert!(clock.paused());
        assert_eq!(clock.target(now + Duration::from_secs(60)), None);
        assert_eq!(clock.next_step_at(7), None);
    }

    #[test]
    fn one_step_per_50ms_without_drift() {
        let start = Instant::now();
        let clock = WallClock::new(STEP, false, start, 100);
        let at = |ms| clock.target(start + Duration::from_millis(ms)).unwrap();
        assert_eq!(at(0), 100);
        assert_eq!(at(49), 100);
        assert_eq!(at(50), 101);
        assert_eq!(at(1_000), 120);
        // A late wake-up catches up instead of drifting.
        assert_eq!(at(10_049), 300);
        assert_eq!(
            clock.next_step_at(120),
            Some(start + Duration::from_millis(1_050))
        );
        if let Some(earlier) = start.checked_sub(Duration::from_millis(5)) {
            assert_eq!(clock.target(earlier), Some(100));
        }
    }

    #[test]
    fn pause_and_rebase() {
        let start = Instant::now();
        let mut clock = WallClock::new(STEP, false, start, 0);
        clock.pause();
        assert!(clock.paused());
        let later = start + Duration::from_secs(5);
        clock.run_from(later, 40);
        assert_eq!(clock.target(later + Duration::from_millis(100)), Some(42));
    }
}
