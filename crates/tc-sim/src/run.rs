//! The loop: a [`Sim`] on its own thread, taking tc-net's requests and
//! the owner's [`Control`]s, sleeping until its next deadline.

use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tc_net::Request;

use crate::core::Core;
use crate::game::Game;
use crate::host::{Host, HostExit, run_host};
use crate::reload::{ReloadReply, ReloadReport};
use crate::sim::Sim;
use crate::status::StatusHandle;

/// What the loop's owner can ask of it.
pub enum Control<G: Game> {
    /// Pause the clock.
    Pause,
    /// Run the clock again.
    Resume,
    /// Jump `steps` steps ahead; the time reached goes to `reply`.
    Advance {
        /// Steps.
        steps: u64,
        /// The time reached, or why not.
        reply: Option<Sender<Result<u64, String>>>,
    },
    /// Jump to `time` ([`Sim::advance_to`]); the time reached goes to
    /// `reply`.
    AdvanceTo {
        /// The time to reach.
        time: u64,
        /// The time reached, or why not.
        reply: Option<Sender<Result<u64, String>>>,
    },
    /// Rebuild the game from new data ([`Sim::reload`]).
    Reload {
        /// The data.
        data: Arc<G::Data>,
        /// The outcome.
        reply: Option<ReloadReply>,
    },
    /// Stop the loop ([`Sim::stop`]).
    Stop,
}

/// The owner's side of a running loop: cheap to clone.
pub struct SimHandle<G: Game> {
    controls: Sender<Control<G>>,
    wake: Sender<Request<G::Protocol>>,
    stopping: Arc<AtomicBool>,
    status: StatusHandle,
}

impl<G: Game> Clone for SimHandle<G> {
    fn clone(&self) -> Self {
        SimHandle {
            controls: self.controls.clone(),
            wake: self.wake.clone(),
            stopping: self.stopping.clone(),
            status: self.status.clone(),
        }
    }
}

impl<G: Game> SimHandle<G> {
    /// Sends a control and wakes the loop. False if the loop is gone.
    pub fn send(&self, control: Control<G>) -> bool {
        if matches!(control, Control::Stop) {
            self.stopping.store(true, Ordering::Relaxed);
        }
        self.controls.send(control).is_ok() && self.wake.send(Request::Wake).is_ok()
    }

    /// Pauses the clock.
    pub fn pause(&self) -> bool {
        self.send(Control::Pause)
    }

    /// Runs the clock.
    pub fn resume(&self) -> bool {
        self.send(Control::Resume)
    }

    /// Jumps `steps` ahead; receive the time reached.
    pub fn advance(&self, steps: u64) -> Receiver<Result<u64, String>> {
        let (reply, rx) = mpsc::channel();
        self.send(Control::Advance {
            steps,
            reply: Some(reply),
        });
        rx
    }

    /// Jumps to `time`; receive the time reached.
    pub fn advance_to(&self, time: u64) -> Receiver<Result<u64, String>> {
        let (reply, rx) = mpsc::channel();
        self.send(Control::AdvanceTo {
            time,
            reply: Some(reply),
        });
        rx
    }

    /// Reloads the game from `data`; receive the outcome.
    pub fn reload(&self, data: Arc<G::Data>) -> Receiver<Result<ReloadReport, String>> {
        let (reply, rx) = mpsc::channel();
        self.send(Control::Reload {
            data,
            reply: Some(reply),
        });
        rx
    }

    /// Stops the loop (a long advance stops between slices).
    pub fn stop(&self) -> bool {
        self.send(Control::Stop)
    }

    /// The loop's status.
    pub fn status(&self) -> StatusHandle {
        self.status.clone()
    }
}

/// A loop running on its own thread.
pub struct Running<G: Game> {
    /// Where tc-net sends requests: hand it to `tc_net::Server::start`.
    pub requests: Sender<Request<G::Protocol>>,
    /// The owner's handle.
    pub handle: SimHandle<G>,
    /// The loop's thread; it returns the core once stopped.
    pub thread: JoinHandle<Core<G>>,
}

impl<G: Game> Running<G> {
    /// Stops the loop and waits for it: the core as it stopped.
    pub fn stop(self) -> Core<G> {
        self.handle.stop();
        drop(self.requests);
        match self.thread.join() {
            Ok(core) => core,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
}

impl<G: Game> Sim<G> {
    /// Runs the loop on a new thread.
    pub fn spawn(self) -> std::io::Result<Running<G>> {
        let (requests, rx) = mpsc::channel();
        let (controls, control_rx) = mpsc::channel();
        let handle = SimHandle {
            controls,
            wake: requests.clone(),
            stopping: self.stopping(),
            status: self.status(),
        };
        let thread = std::thread::Builder::new()
            .name("tc-sim".into())
            .spawn(move || self.run(&rx, &control_rx))?;
        Ok(Running {
            requests,
            handle,
            thread,
        })
    }

    /// Runs the loop on this thread until a [`Control::Stop`], or until
    /// every request sender is gone. Returns the core as it stopped.
    ///
    /// It is [`run_host`] over the sim: each pass the controls, a tick
    /// ([`Sim::tick`]), the bulk lanes' wakes ([`Sim::wake_outbound`]),
    /// then, while the game has idle work ([`Game::idle_work`]), its idle
    /// time up to the next deadline less
    /// [`SimConfig::idle_margin`](crate::SimConfig::idle_margin)
    /// ([`Sim::idle`], cut short by a waiting request), then a wait for
    /// a request until the deadline.
    pub fn run(
        self,
        requests: &Receiver<Request<G::Protocol>>,
        controls: &Receiver<Control<G>>,
    ) -> Core<G> {
        let mut host = SimHost {
            sim: self,
            controls,
        };
        if run_host(&mut host, requests) == HostExit::Disconnected {
            // What the owner sent before the senders went, up to a stop.
            let _ = host.poll();
        }
        host.sim.stop()
    }

    /// Does one control; false for [`Control::Stop`].
    pub fn control(&mut self, control: Control<G>) -> bool {
        match control {
            Control::Pause => self.pause(),
            Control::Resume => {
                if !self.resume() {
                    tracing::warn!("not resumed: the store failed");
                }
            }
            Control::Advance { steps, reply } => {
                let reached = self.advance(steps);
                if let Some(reply) = reply {
                    let _ = reply.send(reached);
                }
            }
            Control::AdvanceTo { time, reply } => {
                let reached = self.advance_to(time);
                if let Some(reply) = reply {
                    let _ = reply.send(reached);
                }
            }
            Control::Reload { data, reply } => self.reload(data, reply),
            Control::Stop => return false,
        }
        true
    }
}

/// A [`Sim`] as a [`Host`]: tc-net's requests, the owner's controls.
struct SimHost<'a, G: Game> {
    sim: Sim<G>,
    controls: &'a Receiver<Control<G>>,
}

impl<G: Game> Host for SimHost<'_, G> {
    type Request = Request<G::Protocol>;

    fn poll(&mut self) -> ControlFlow<()> {
        while let Ok(control) = self.controls.try_recv() {
            if !self.sim.control(control) {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    }

    fn tick(&mut self, now: Instant) {
        self.sim.tick(now);
    }

    fn wake_outbound(&mut self, now: Instant) {
        self.sim.wake_outbound(now);
    }

    fn deadline(&self) -> Option<Instant> {
        self.sim.deadline()
    }

    fn idle_work(&self) -> bool {
        self.sim.core.game().idle_work()
    }

    fn idle_margin(&self) -> Duration {
        self.sim.idle_margin
    }

    fn idle(&mut self, until: Instant, interrupted: &mut dyn FnMut() -> bool) {
        self.sim.idle(until, interrupted);
    }

    fn handle(&mut self, request: Self::Request) -> ControlFlow<()> {
        self.sim.handle(request);
        ControlFlow::Continue(())
    }

    fn woke_late(&mut self, late: Duration, _wait: Duration) {
        self.sim.late = late;
    }
}
