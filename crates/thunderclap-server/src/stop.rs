//! What ends [`Builder::run`](crate::Builder::run) besides the admin
//! channel's stop: the OS's stop signals (Ctrl-C and `SIGTERM` on Unix;
//! Ctrl-C, Ctrl-Break and closing the console on Windows), a stop file in
//! the data directory (any OS: a service manager, a script without a
//! console), and the game's loop ending. A second signal after
//! [`REPEAT_GRACE`] exits at once with [`EXIT_FORCED`].

use std::time::Duration;

use tracing::warn;

/// A file in the data directory that stops the server when it appears
/// (and is removed); one left over is removed at start.
pub const STOP_FILE: &str = "server.stop";
/// A second stop signal this long after the first exits at once (signals
/// within it are the same press, delivered twice).
pub const REPEAT_GRACE: Duration = Duration::from_secs(1);
/// The exit code of a forced exit (a second signal).
pub const EXIT_FORCED: i32 = 130;
/// How often the stop file and the loop are looked at.
pub(crate) const STOP_POLL: Duration = Duration::from_millis(250);

/// The OS's stop signals.
pub(crate) struct Signals {
    #[cfg(unix)]
    int: Option<tokio::signal::unix::Signal>,
    #[cfg(unix)]
    term: Option<tokio::signal::unix::Signal>,
    #[cfg(windows)]
    c: Option<tokio::signal::windows::CtrlC>,
    #[cfg(windows)]
    brk: Option<tokio::signal::windows::CtrlBreak>,
    #[cfg(windows)]
    close: Option<tokio::signal::windows::CtrlClose>,
}

fn listen<T, E: std::fmt::Display>(what: &str, r: Result<T, E>) -> Option<T> {
    r.map_err(|e| warn!("can't listen for {what}: {e}")).ok()
}

impl Signals {
    pub(crate) fn new() -> Signals {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Signals {
                int: listen("SIGINT", signal(SignalKind::interrupt())),
                term: listen("SIGTERM", signal(SignalKind::terminate())),
            }
        }
        #[cfg(windows)]
        {
            use tokio::signal::windows;
            Signals {
                c: listen("Ctrl-C", windows::ctrl_c()),
                brk: listen("Ctrl-Break", windows::ctrl_break()),
                close: listen("the console closing", windows::ctrl_close()),
            }
        }
        #[cfg(not(any(unix, windows)))]
        Signals {}
    }

    /// The next stop signal's name.
    pub(crate) async fn next(&mut self) -> &'static str {
        async fn on<F: Future<Output = Option<()>>>(f: Option<F>) {
            match f {
                Some(f) => {
                    if f.await.is_none() {
                        std::future::pending::<()>().await;
                    }
                }
                None => std::future::pending().await,
            }
        }
        #[cfg(unix)]
        {
            tokio::select! {
                () = on(self.int.as_mut().map(|s| s.recv())) => "SIGINT",
                () = on(self.term.as_mut().map(|s| s.recv())) => "SIGTERM",
            }
        }
        #[cfg(windows)]
        {
            tokio::select! {
                () = on(self.c.as_mut().map(|s| s.recv())) => "Ctrl-C",
                () = on(self.brk.as_mut().map(|s| s.recv())) => "Ctrl-Break",
                () = on(self.close.as_mut().map(|s| s.recv())) => "the console closing",
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = tokio::signal::ctrl_c().await;
            "Ctrl-C"
        }
    }
}
