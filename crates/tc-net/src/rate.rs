//! Per-connection message rates: token buckets that make a session wait,
//! so a client sending faster than its limit is slowed down (its messages
//! wait in TCP) rather than refused: every command still gets its result,
//! in order. Normal play stays far below the limits; they only stop one
//! connection from keeping the game's thread busy.

use std::time::Duration;

use tokio::time::Instant;

use crate::envelope::{ClientMsg, Protocol};

/// A rate: `burst` messages at once, then one per `interval`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    /// Messages allowed back to back.
    pub burst: u32,
    /// After a burst, one message per this long.
    pub interval: Duration,
}

impl Rate {
    /// `burst` at once, then `per_second` a second.
    pub const fn per_second(burst: u32, per_second: u32) -> Rate {
        Rate {
            burst,
            interval: Duration::from_nanos(1_000_000_000 / per_second as u64),
        }
    }
}

// The defaults sit well above what a voxel game's bot scenarios sent
// (measured per connection, the busiest second: 108 commands, 844 batch
// commands, 412 subscription changes and 154 other messages).

/// Commands (other than bulk commands): 200 at once, then 50 a second.
pub const COMMANDS: Rate = Rate::per_second(200, 50);

/// Bulk commands ([`Protocol::bulk_command`]: a tool's or a bot's batch
/// work): 2,000 at once, then 500 a second.
pub const BULK_COMMANDS: Rate = Rate::per_second(2000, 500);

/// `Subscribe` and `Unsubscribe`: 1,000 at once (a reconnect resumes every
/// live query at once), then 200 a second.
pub const SUBSCRIPTIONS: Rate = Rate::per_second(1000, 200);

/// Everything else (`Input`, `Ping`, `SetInterest`, game messages): 400 at
/// once, then 200 a second. Movement is about 20 inputs a second.
pub const OTHER: Rate = Rate::per_second(400, 200);

/// The limits for each kind of message.
#[derive(Clone, Copy, Debug)]
pub struct Rates {
    /// See [`COMMANDS`].
    pub commands: Rate,
    /// See [`BULK_COMMANDS`].
    pub bulk_commands: Rate,
    /// See [`SUBSCRIPTIONS`].
    pub subscriptions: Rate,
    /// See [`OTHER`].
    pub other: Rate,
}

impl Default for Rates {
    fn default() -> Rates {
        Rates {
            commands: COMMANDS,
            bulk_commands: BULK_COMMANDS,
            subscriptions: SUBSCRIPTIONS,
            other: OTHER,
        }
    }
}

/// One rate limit's state (the generic cell rate algorithm).
#[derive(Debug)]
struct Bucket {
    rate: Rate,
    /// When the next message would be due if they came one per interval.
    due: Instant,
}

impl Bucket {
    fn new(rate: Rate, now: Instant) -> Bucket {
        Bucket { rate, due: now }
    }

    /// Takes one message; returns when it may go (`now` within the burst).
    fn take(&mut self, now: Instant) -> Instant {
        let due = self.due.max(now);
        let slack = self.rate.interval * self.rate.burst.saturating_sub(1);
        let at = due.checked_sub(slack).map_or(now, |at| at.max(now));
        self.due = due + self.rate.interval;
        at
    }
}

/// The message kinds with separate limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `Command`, except bulk commands; `TakeControl`, `EntityResync`.
    Command,
    /// A bulk command ([`Protocol::bulk_command`]).
    BulkCommand,
    /// `Subscribe` and `Unsubscribe`.
    Subscription,
    /// Everything else after `Hello`.
    Other,
}

impl Kind {
    /// The kind of `msg`.
    pub fn of<P: Protocol>(msg: &ClientMsg<P>) -> Kind {
        match msg {
            ClientMsg::Command { command, .. } if P::bulk_command(command) => Kind::BulkCommand,
            ClientMsg::Command { .. } | ClientMsg::TakeControl | ClientMsg::EntityResync => {
                Kind::Command
            }
            ClientMsg::Subscribe { .. } | ClientMsg::Unsubscribe { .. } => Kind::Subscription,
            _ => Kind::Other,
        }
    }

    /// A name for logs.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Command => "commands",
            Kind::BulkCommand => "bulk commands",
            Kind::Subscription => "subscriptions",
            Kind::Other => "messages",
        }
    }
}

/// One connection's limits.
#[derive(Debug)]
pub struct Limiter {
    commands: Bucket,
    bulk_commands: Bucket,
    subscriptions: Bucket,
    other: Bucket,
}

impl Limiter {
    /// Full buckets at `now`.
    pub fn new(rates: Rates, now: Instant) -> Limiter {
        Limiter {
            commands: Bucket::new(rates.commands, now),
            bulk_commands: Bucket::new(rates.bulk_commands, now),
            subscriptions: Bucket::new(rates.subscriptions, now),
            other: Bucket::new(rates.other, now),
        }
    }

    /// Takes one message of `kind`; returns when it may be handled.
    pub fn take(&mut self, kind: Kind, now: Instant) -> Instant {
        match kind {
            Kind::Command => self.commands.take(now),
            Kind::BulkCommand => self.bulk_commands.take(now),
            Kind::Subscription => self.subscriptions.take(now),
            Kind::Other => self.other.take(now),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_goes_at_once_then_one_per_interval() {
        let now = Instant::now();
        let rate = Rate::per_second(3, 10);
        let mut b = Bucket::new(rate, now);
        for _ in 0..3 {
            assert_eq!(b.take(now), now);
        }
        assert_eq!(b.take(now), now + rate.interval);
        assert_eq!(b.take(now), now + rate.interval * 2);
        // Idle time refills the bucket, up to the burst.
        let later = now + Duration::from_secs(10);
        for _ in 0..3 {
            assert_eq!(b.take(later), later);
        }
        assert_eq!(b.take(later), later + rate.interval);
    }

    #[derive(Debug, Clone, PartialEq)]
    struct Game;
    impl Protocol for Game {
        type Hello = crate::Empty;
        type Welcome = crate::Empty;
        type Command = u32;
        type Result = crate::Empty;
        type Interest = crate::Empty;
        type Input = crate::Empty;
        type State = crate::Empty;
        type Client = crate::Empty;
        type Server = crate::Empty;
        fn bulk_command(command: &u32) -> bool {
            *command >= 100
        }
    }

    #[test]
    fn bulk_commands_have_their_own_limit() {
        let play = ClientMsg::<Game>::Command { seq: 0, command: 1 };
        let bulk = ClientMsg::<Game>::Command {
            seq: 0,
            command: 100,
        };
        assert_eq!(Kind::of(&play), Kind::Command);
        assert_eq!(Kind::of(&bulk), Kind::BulkCommand);
        assert_eq!(Kind::of(&ClientMsg::<Game>::TakeControl), Kind::Command);
        assert_eq!(
            Kind::of(&ClientMsg::<Game>::Unsubscribe { sub: 1 }),
            Kind::Subscription
        );
        assert_eq!(
            Kind::of(&ClientMsg::<Game>::Ping { client_time: 0 }),
            Kind::Other
        );
    }

    #[test]
    fn a_steady_rate_under_the_limit_never_waits() {
        let start = Instant::now();
        let mut l = Limiter::new(Rates::default(), start);
        // Movement inputs and a ping or two a second, for a minute.
        for tick in 0..1200u32 {
            let now = start + Duration::from_millis(50) * tick;
            assert_eq!(l.take(Kind::Other, now), now);
            if tick % 10 == 0 {
                assert_eq!(l.take(Kind::Other, now), now);
                assert_eq!(l.take(Kind::Command, now), now);
            }
        }
    }
}
