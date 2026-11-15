//! The server's side of the control channel: a loopback listener, the
//! endpoint file, and the answer to each request.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tc_auth::{LiveTokens, Revoked};
use tc_net::stats::IoCounters;
use tc_sim::{Game, ReloadReport, SimHandle, SimStatus};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

use crate::backups::Backups;
use crate::endpoint::{Endpoint, same_token};
use crate::proto::{MAX_LINE, PlayerBrief, Reply, ReportsReply, Request, Status, decode_request};
use crate::reports::ReportsSource;

/// How long one exchange may take, from accepting the connection to
/// writing the reply: a caller that sends nothing is dropped. Long enough
/// for a backup or a reload of a modest game.
pub const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a caller that sends nothing is waited for.
pub const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Control connections open at once; more are closed as accepted.
pub const MAX_OPEN: usize = 8;

/// Reports [`Request::Reports`] lists.
pub const NEWEST_REPORTS: usize = 5;

/// Why the loop didn't take a control ([`SimControl`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlError {
    /// The game doesn't do this (a loop with no clock to pause, no data
    /// to reload), and why: answered [`Reply::Unsupported`].
    Unsupported(String),
    /// The loop has stopped.
    Stopped,
    /// It was tried and failed, and why (a loader's error).
    Failed(String),
}

/// The game's loop, as the channel drives it: [`SimControls`] over a
/// [`SimHandle`], or a game's own loop. Only [`status`](Self::status) is
/// needed: the controls a loop doesn't have answer
/// [`ControlError::Unsupported`] by default.
pub trait SimControl: Send + Sync {
    /// The game as its loop last published it.
    fn status(&self) -> SimStatus;

    /// The players present, for [`Status::players`]: by default `status`'s
    /// ids, each with its name ([`SimStatus::names`]).
    fn players(&self, status: &SimStatus) -> Vec<PlayerBrief> {
        status
            .players
            .iter()
            .map(|&id| PlayerBrief::id(id, status.names.get(&id).cloned()))
            .collect()
    }

    /// Pauses the clock.
    fn pause(&self) -> Result<(), ControlError> {
        Err(ControlError::Unsupported(
            "this game's loop has no clock to pause".into(),
        ))
    }

    /// Runs the clock again.
    fn resume(&self) -> Result<(), ControlError> {
        Err(ControlError::Unsupported(
            "this game's loop has no clock to resume".into(),
        ))
    }

    /// Reads the game's data again and rebuilds the game from it; the
    /// outcome arrives on the receiver.
    fn reload(&self) -> Result<mpsc::Receiver<Result<ReloadReport, String>>, ControlError> {
        Err(ControlError::Unsupported(
            "this game's loop doesn't reload".into(),
        ))
    }
}

/// Reads a game's data again, for a reload.
pub type DataLoader<G> = Arc<dyn Fn() -> Result<Arc<<G as Game>::Data>, String> + Send + Sync>;

/// [`SimControl`] for a running [`tc_sim::Sim`].
pub struct SimControls<G: Game> {
    /// The loop.
    pub handle: SimHandle<G>,
    /// Reads the data a reload rebuilds from; none: reload is refused.
    pub data: Option<DataLoader<G>>,
}

impl<G: Game> SimControl for SimControls<G>
where
    SimHandle<G>: Send + Sync,
{
    fn status(&self) -> SimStatus {
        self.handle.status().get()
    }

    fn pause(&self) -> Result<(), ControlError> {
        self.handle
            .pause()
            .then_some(())
            .ok_or(ControlError::Stopped)
    }

    fn resume(&self) -> Result<(), ControlError> {
        self.handle
            .resume()
            .then_some(())
            .ok_or(ControlError::Stopped)
    }

    fn reload(&self) -> Result<mpsc::Receiver<Result<ReloadReport, String>>, ControlError> {
        let load = self
            .data
            .as_ref()
            .ok_or_else(|| ControlError::Unsupported("this server has no data to reload".into()))?;
        Ok(self.handle.reload(load().map_err(ControlError::Failed)?))
    }
}

/// How long [`SessionRevoke`] waits for the sessions it ends to close
/// before it answers.
pub const REVOKE_WAIT: Duration = Duration::from_secs(3);

/// Revokes a name's tokens: [`SessionRevoke`], or a game's own. Runs off
/// the runtime's threads.
pub trait Revoke: Send + Sync {
    /// Revokes every token `name` holds so far; its open sessions close.
    /// The name's generation now, and the sessions that closed and those
    /// still closing.
    fn revoke(&self, name: &str) -> Result<Revoked, String>;
}

/// [`Revoke`] through [`tc_auth::SessionAuth`]: moves the name's
/// generation on, then waits up to `wait` for the sessions on its older
/// tokens (in `live`, which the server's Hello hook fills:
/// [`LiveTokens::hook`]) to close, and counts them.
pub struct SessionRevoke {
    /// The tokens.
    pub auth: Arc<tc_auth::SessionAuth>,
    /// The open sessions' tokens.
    pub live: Arc<LiveTokens>,
    /// How long to wait for them to close ([`REVOKE_WAIT`]).
    pub wait: Duration,
    rt: tokio::runtime::Handle,
}

impl SessionRevoke {
    /// Over `auth` and `live`, waiting [`REVOKE_WAIT`]. Call within a
    /// tokio runtime (the wait runs on it).
    pub fn new(auth: Arc<tc_auth::SessionAuth>, live: Arc<LiveTokens>) -> SessionRevoke {
        SessionRevoke {
            auth,
            live,
            wait: REVOKE_WAIT,
            rt: tokio::runtime::Handle::current(),
        }
    }
}

impl Revoke for SessionRevoke {
    fn revoke(&self, name: &str) -> Result<Revoked, String> {
        let generation = self
            .auth
            .revoke(name)
            .map_err(|e| self.auth.format().reason(&e))?;
        // On the channel's blocking thread: waits on the runtime.
        let seen = self
            .rt
            .block_on(self.live.revoke(&*self.auth, name, self.wait));
        Ok(seen.unwrap_or(Revoked {
            generation,
            closed: 0,
            closing: 0,
        }))
    }
}

/// Answers a game's own requests: its name and arguments in, a value or
/// why not out. Runs off the runtime's threads.
pub type GameRequests = Arc<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;

/// The game's own status (its world's numbers), asked at
/// every status request on the runtime's thread: keep it quick (read what
/// the game publishes, never wait on its loop).
pub type GameStatus = Arc<dyn Fn() -> Value + Send + Sync>;

/// What the channel reads and drives: the server's live parts. Each is
/// optional but the loop; a request for a missing one is refused.
pub struct Live {
    /// The game's loop.
    pub sim: Arc<dyn SimControl>,
    /// The network's counters.
    pub io: Option<Arc<IoCounters>>,
    /// The game's port.
    pub port: u16,
    /// The server's build, as the game names it.
    pub build: String,
    /// Set once the server is shutting down.
    pub stopping: Arc<AtomicBool>,
    /// Revokes tokens.
    pub revoke: Option<Arc<dyn Revoke>>,
    /// Backs the store up.
    pub backups: Option<Backups>,
    /// The reports kept: [`Reports`], or the game's own.
    pub reports: Option<Arc<dyn ReportsSource>>,
    /// The game's own requests.
    pub game: Option<GameRequests>,
    /// The game's own status, in every [`Status`]'s `game`.
    pub status: Option<GameStatus>,
}

impl Live {
    /// The loop alone: the rest unset.
    pub fn new(sim: Arc<dyn SimControl>) -> Live {
        Live {
            sim,
            io: None,
            port: 0,
            build: String::new(),
            stopping: Arc::new(AtomicBool::new(false)),
            revoke: None,
            backups: None,
            reports: None,
            game: None,
            status: None,
        }
    }
}

/// An open control channel: the listener's task and its endpoint file,
/// both gone at [`AdminChannel::close`].
pub struct AdminChannel {
    task: tokio::task::JoinHandle<()>,
    file: PathBuf,
    token: String,
    addr: SocketAddr,
}

struct Answerer {
    live: Live,
    token: String,
    started: Instant,
    started_unix: u64,
    stop: watch::Sender<bool>,
}

impl AdminChannel {
    /// Listens on a free loopback port and writes the endpoint file into
    /// `dir` (the directory the server holds the lock of, so
    /// [`ask`](crate::ask) trusts only a live server's file). A stop
    /// request sets `stop`. Call within a tokio runtime.
    pub async fn open(
        dir: &Path,
        live: Live,
        stop: watch::Sender<bool>,
    ) -> std::io::Result<AdminChannel> {
        // Loopback only, whatever the game listens on.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let addr = listener.local_addr()?;
        let endpoint = Endpoint::fresh(addr.port());
        let token = endpoint.token.clone();
        let file = endpoint.write(dir)?;
        let answerer = Arc::new(Answerer {
            live,
            token: token.clone(),
            started: Instant::now(),
            started_unix: tc_store::unix_now(),
            stop,
        });
        let task = tokio::spawn(accept_loop(listener, answerer));
        info!(%addr, "admin channel open");
        Ok(AdminChannel {
            task,
            file,
            token,
            addr,
        })
    }

    /// The address it listens on (always loopback).
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stops listening and removes the endpoint file, if it is still this
    /// channel's.
    pub fn close(self) {
        self.task.abort();
        let dir = self.file.parent().unwrap_or(Path::new("."));
        if Endpoint::read(dir).is_some_and(|e| e.token == self.token)
            && let Err(e) = std::fs::remove_file(&self.file)
        {
            warn!("could not remove {}: {e}", self.file.display());
        }
    }
}

async fn accept_loop(listener: TcpListener, answerer: Arc<Answerer>) {
    let mut open = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    if open.len() >= MAX_OPEN {
                        debug!(%peer, "admin: refused, too many open");
                        continue;
                    }
                    let answerer = answerer.clone();
                    open.spawn(async move {
                        if tokio::time::timeout(EXCHANGE_TIMEOUT, exchange(stream, &answerer))
                            .await
                            .is_err()
                        {
                            debug!(%peer, "admin: timed out");
                        }
                    });
                }
                Err(e) => {
                    warn!("admin: accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            Some(_) = open.join_next(), if !open.is_empty() => {}
        }
    }
}

/// One exchange: a request line in, a reply line out.
async fn exchange(stream: TcpStream, answerer: &Answerer) {
    let (read, mut write) = stream.into_split();
    let mut line = Vec::new();
    let mut reader = BufReader::new(read).take(MAX_LINE as u64 + 1);
    let read = tokio::time::timeout(READ_TIMEOUT, reader.read_until(b'\n', &mut line)).await;
    let reply = match read {
        Ok(Ok(_)) if line.len() > MAX_LINE => Reply::Refused("the request is too long".into()),
        Ok(Ok(_)) => match std::str::from_utf8(&line) {
            Ok(text) => answerer.answer(text.trim_end()).await,
            Err(_) => Reply::Refused("the request is not UTF-8".into()),
        },
        Ok(Err(e)) => {
            debug!("admin: reading: {e}");
            return;
        }
        Err(_) => {
            debug!("admin: no request in time");
            return;
        }
    };
    let mut out = reply.encode();
    out.push('\n');
    if let Err(e) = write.write_all(out.as_bytes()).await {
        debug!("admin: writing: {e}");
    }
    let _ = write.shutdown().await;
}

/// The reply to a request the game doesn't do.
fn unsupported(request: &str, why: &str) -> Reply {
    info!(request, why, "admin: unsupported");
    Reply::Unsupported {
        request: request.into(),
        why: why.into(),
    }
}

/// The reply to a control the loop didn't take.
fn control_failed(request: &Request, e: ControlError) -> Reply {
    match e {
        ControlError::Unsupported(why) => unsupported(request.name(), &why),
        ControlError::Stopped => Reply::Refused("the game's loop has stopped".into()),
        ControlError::Failed(why) => Reply::Refused(format!("{}: {why}", request.name())),
    }
}

/// Runs `f` off the runtime's threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("the task failed: {e}"))
}

impl Answerer {
    async fn answer(&self, line: &str) -> Reply {
        let asked = match decode_request(line) {
            Ok(a) => a,
            Err(why) => return Reply::Refused(why),
        };
        if !same_token(&asked.token, &self.token) {
            warn!("admin: a request with a wrong token, refused");
            return Reply::Refused("a wrong token".into());
        }
        let request = match asked.request {
            Ok(r) => r,
            Err(name) => return Reply::Unknown(name),
        };
        let live = &self.live;
        match request {
            Request::Status => Reply::Status(self.status()),
            Request::Stop => {
                let already = self.stop.send_replace(true) || live.stopping.load(Ordering::Relaxed);
                if !already {
                    info!("admin: asked to stop");
                }
                Reply::Stopping { already }
            }
            Request::Pause | Request::Resume => {
                let pause = request == Request::Pause;
                let sent = if pause {
                    live.sim.pause()
                } else {
                    live.sim.resume()
                };
                if let Err(e) = sent {
                    return control_failed(&request, e);
                }
                info!(pause, "admin: clock");
                Reply::Clock {
                    paused: pause,
                    time: live.sim.status().time,
                }
            }
            Request::Reload => {
                let sim = live.sim.clone();
                let outcome = blocking(move || {
                    sim.reload()?
                        .recv()
                        .map_err(|_| ControlError::Stopped)?
                        .map_err(ControlError::Failed)
                })
                .await
                .map_err(ControlError::Failed)
                .and_then(|r| r);
                match outcome {
                    Ok(r) => {
                        info!(time = r.time, version = r.version, "admin: reloaded");
                        Reply::Reloaded {
                            time: r.time,
                            version: r.version,
                            rounds: r.rounds,
                            replayed: r.replayed.applied,
                        }
                    }
                    Err(e) => control_failed(&request, e),
                }
            }
            Request::Backup { out } => {
                let Some(backups) = live.backups.clone() else {
                    return unsupported("backup", "this server keeps no store to back up");
                };
                let outcome = blocking(move || backups.run(out.as_deref().map(Path::new)))
                    .await
                    .and_then(|r| r);
                match outcome {
                    Ok(b) => Reply::BackedUp {
                        dir: b.dir.display().to_string(),
                        files: b.files,
                        bytes: b.bytes,
                        last_seq: b.last_seq,
                        pruned: b.pruned,
                    },
                    Err(why) => Reply::Refused(format!("backup: {why}")),
                }
            }
            Request::Revoke { name } => {
                let Some(revoke) = live.revoke.clone() else {
                    return unsupported("revoke", "this server takes no tokens it can revoke");
                };
                let n = name.clone();
                match blocking(move || revoke.revoke(&n)).await.and_then(|r| r) {
                    Ok(r) => {
                        info!(
                            name,
                            generation = r.generation,
                            closed = r.closed,
                            closing = r.closing,
                            "admin: revoked"
                        );
                        Reply::Revoked {
                            name,
                            generation: r.generation,
                            closed: r.closed as u64,
                            closing: r.closing as u64,
                        }
                    }
                    Err(why) => Reply::Refused(format!("revoke: {why}")),
                }
            }
            Request::Reports { since, kind } => {
                let Some(reports) = live.reports.clone() else {
                    return Reply::Reports(ReportsReply::default());
                };
                let answer = blocking(move || {
                    let (count, newest) = reports.held(since, kind.as_deref(), NEWEST_REPORTS)?;
                    Ok((count, newest, reports.counts(), reports.extra()))
                })
                .await
                .and_then(|r| r);
                match answer {
                    Ok((count, newest, counts, extra)) => Reply::Reports(ReportsReply {
                        kept: true,
                        count,
                        newest,
                        received: counts.received,
                        saved: counts.saved,
                        rate_limited: counts.rate_limited,
                        dropped: counts.dropped,
                        pruned: counts.pruned,
                        extra,
                    }),
                    Err(why) => Reply::Refused(format!("reports: {why}")),
                }
            }
            Request::Game { name, args } => {
                let Some(game) = live.game.clone() else {
                    return Reply::Unknown(format!("game {name}"));
                };
                match blocking(move || game(&name, args)).await.and_then(|r| r) {
                    Ok(v) => Reply::Game(v),
                    Err(why) => Reply::Refused(why),
                }
            }
        }
    }

    fn status(&self) -> Status {
        let game = self.live.sim.status();
        let players = self.live.sim.players(&game);
        let io = self
            .live
            .io
            .as_ref()
            .map(|io| io.snapshot())
            .unwrap_or_default();
        Status {
            pid: std::process::id(),
            build: self.live.build.clone(),
            port: self.live.port,
            started: self.started_unix,
            uptime_secs: self.started.elapsed().as_secs(),
            players,
            connections: game.connections as u64,
            version: game.version,
            time: game.time,
            paused: game.paused,
            reloading: game.reloading,
            stopping: *self.stop.borrow() || self.live.stopping.load(Ordering::Relaxed),
            store_error: game.store_error,
            refused: game.refused,
            limited: game.limited,
            frames_sent: io.frames_written,
            bytes_sent: io.bytes_written,
            game: self.live.status.as_ref().map(|f| f()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Endpoint, ask_endpoint};

    /// A game's own loop: a status, and none of the controls.
    struct OwnLoop;

    impl SimControl for OwnLoop {
        fn status(&self) -> SimStatus {
            SimStatus {
                players: vec![4],
                names: [(4, "ada".to_string())].into(),
                ..SimStatus::default()
            }
        }
    }

    /// Reports kept the game's own way, with its numbers.
    struct OwnReports;

    impl ReportsSource for OwnReports {
        fn held(
            &self,
            _since: Option<u64>,
            kind: Option<&str>,
            _newest: usize,
        ) -> Result<(u64, Vec<crate::ReportBrief>), String> {
            match kind {
                Some("bogus") => Err("no kind bogus".into()),
                _ => Ok((7, Vec::new())),
            }
        }

        fn counts(&self) -> crate::ReportCounts {
            crate::ReportCounts {
                received: 9,
                rate_limited: 2,
                ..Default::default()
            }
        }

        fn extra(&self) -> Option<Value> {
            Some(serde_json::json!({ "per_player": { "ada": 7 } }))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_game_s_own_loop_and_reports() {
        let dir = std::env::temp_dir().join(format!("tc-admin-own-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut live = Live::new(Arc::new(OwnLoop));
        live.reports = Some(Arc::new(OwnReports));
        let (stop, _) = watch::channel(false);
        let channel = AdminChannel::open(&dir, live, stop).await.unwrap();
        let endpoint = Endpoint::read(&dir).unwrap();
        let ask = |request: Request| {
            let endpoint = endpoint.clone();
            tokio::task::spawn_blocking(move || ask_endpoint(&endpoint, &request).unwrap())
        };

        let Reply::Status(s) = ask(Request::Status).await.unwrap() else {
            panic!("no status");
        };
        assert_eq!(s.players, [PlayerBrief::id(4, Some("ada".into()))]);
        for (request, name) in [
            (Request::Pause, "pause"),
            (Request::Resume, "resume"),
            (Request::Reload, "reload"),
            (Request::Backup { out: None }, "backup"),
            (Request::Revoke { name: "ada".into() }, "revoke"),
        ] {
            let reply = ask(request).await.unwrap();
            assert!(
                matches!(&reply, Reply::Unsupported { request, .. } if request == name),
                "{reply:?}"
            );
        }
        let reports = |kind: Option<&str>| Request::Reports {
            since: None,
            kind: kind.map(String::from),
        };
        let Reply::Reports(r) = ask(reports(None)).await.unwrap() else {
            panic!("no reports");
        };
        assert_eq!(
            (r.kept, r.count, r.received, r.rate_limited),
            (true, 7, 9, 2)
        );
        assert_eq!(r.extra.unwrap()["per_player"]["ada"], 7);
        let refused = ask(reports(Some("bogus"))).await.unwrap();
        assert!(matches!(refused, Reply::Refused(_)), "{refused:?}");

        channel.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
