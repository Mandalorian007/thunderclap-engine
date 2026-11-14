//! Rate lanes: budgets for game messages a player sends often and the
//! game may lose (a pose, a chat line, an emote), which the loop drops
//! over budget rather than making the client wait. tc-net's per-connection
//! rates slow a whole connection; a lane only drops its own kind.
//!
//! A game names its lanes ([`Game::lanes`]) and puts each message in one
//! or none ([`Game::lane`]). Each player has one budget per lane, shared by
//! all its connections (a second tab doesn't double it): a generic cell
//! rate (GCRA), `burst` messages at once, then one per `every`.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::game::PlayerId;

/// A kind of game message and its budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lane {
    /// Its name, for logs.
    pub name: &'static str,
    /// Messages taken at once from a full budget (at least 1).
    pub burst: u32,
    /// One more message's worth of budget comes back this often.
    pub every: Duration,
}

/// Every player's budget in every lane: when each lane is next due.
#[derive(Debug, Default)]
pub(crate) struct Budgets {
    due: BTreeMap<(PlayerId, usize), Instant>,
}

impl Budgets {
    /// Takes one message of `lane` for `player` at `now`; false if over
    /// budget (the message is dropped).
    pub(crate) fn take(
        &mut self,
        player: PlayerId,
        lane: usize,
        rule: &Lane,
        now: Instant,
    ) -> bool {
        let due = self.due.entry((player, lane)).or_insert(now);
        let next = (*due).max(now);
        let slack = rule.every * rule.burst.max(1).saturating_sub(1);
        if next > now + slack {
            return false;
        }
        *due = next + rule.every;
        true
    }

    /// Forgets `player`'s budgets (it left: a full budget is the same as
    /// none).
    pub(crate) fn forget(&mut self, player: PlayerId) {
        self.due.retain(|(p, _), _| *p != player);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_then_one_per_interval() {
        let rule = Lane {
            name: "pose",
            burst: 3,
            every: Duration::from_millis(100),
        };
        let mut b = Budgets::default();
        let t = Instant::now();
        let taken: Vec<bool> = (0..5).map(|_| b.take(1, 0, &rule, t)).collect();
        assert_eq!(taken, [true, true, true, false, false]);
        assert!(!b.take(1, 0, &rule, t + Duration::from_millis(50)));
        assert!(b.take(1, 0, &rule, t + Duration::from_millis(100)));
        assert!(b.take(2, 0, &rule, t), "another player has its own");
        assert!(b.take(1, 1, &rule, t), "another lane has its own");
        b.forget(1);
        assert!(b.take(1, 0, &rule, t), "forgotten: full again");
    }
}
