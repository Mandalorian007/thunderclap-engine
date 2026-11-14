//! The server's side of the control channel: a loopback listener, the
//! endpoint file, and the answer to each request.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tc_net::stats::IoCounters;
use tc_sim::{Game, ReloadReport, SimHandle, SimStatus};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

use crate::backups::Backups;
use crate::endpoint::{Endpoint, same_token};
use crate::proto::{MAX_LINE, Reply, ReportsReply, Request, Status, decode_request};
use crate::reports::Reports;

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

/// The game's loop, as the channel drives it: [`SimControls`] over a
/// [`SimHandle`].
pub trait SimControl: Send + Sync {
    /// The game as its loop last published it.
    fn status(&self) -> SimStatus;
    /// Pauses the clock; false if the loop has stopped.
    fn pause(&self) -> bool;
    /// Runs the clock again; false if the loop has stopped.
    fn resume(&self) -> bool;
    /// Reads the game's data again and rebuilds the game from it; the
    /// outcome arrives on the receiver. `Err` if there is no loader or it
    /// failed.
    fn reload(&self) -> Result<mpsc::Receiver<Result<ReloadReport, String>>, String>;
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

    fn pause(&self) -> bool {
        self.handle.pause()
    }

    fn resume(&self) -> bool {
        self.handle.resume()
    }

    fn reload(&self) -> Result<mpsc::Receiver<Result<ReloadReport, String>>, String> {
        let load = self
            .data
            .as_ref()
            .ok_or("this server has no data to reload")?;
        Ok(self.handle.reload(load()?))
    }
}

/// Revokes a name's tokens: [`tc_auth::SessionAuth`] does.
pub trait Revoke: Send + Sync {
    /// Revokes every token `name` holds so far; its open sessions close.
    /// The name's generation now.
    fn revoke(&self, name: &str) -> Result<u32, String>;
}

impl Revoke for tc_auth::SessionAuth {
    fn revoke(&self, name: &str) -> Result<u32, String> {
        tc_auth::SessionAuth::revoke(self, name).map_err(|e| self.format().reason(&e))
    }
}

/// Answers a game's own requests: its name and arguments in, a value or
/// why not out. Runs off the runtime's threads.
pub type GameRequests = Arc<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;

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
    /// The reports kept.
    pub reports: Option<Reports>,
    /// The game's own requests.
    pub game: Option<GameRequests>,
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
                if !sent {
                    return Reply::Refused("the game's loop has stopped".into());
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
                        .map_err(|_| "the game's loop stopped".to_string())?
                })
                .await
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
                    Err(why) => Reply::Refused(format!("reload: {why}")),
                }
            }
            Request::Backup { out } => {
                let Some(backups) = live.backups.clone() else {
                    return Reply::Refused("this server keeps no store to back up".into());
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
                    return Reply::Refused(
                        "this server takes dev tokens: there are none to revoke".into(),
                    );
                };
                let n = name.clone();
                match blocking(move || revoke.revoke(&n)).await.and_then(|r| r) {
                    Ok(generation) => {
                        info!(name, generation, "admin: revoked");
                        Reply::Revoked { name, generation }
                    }
                    Err(why) => Reply::Refused(format!("revoke: {why}")),
                }
            }
            Request::Reports { since, kind } => {
                let Some(reports) = live.reports.clone() else {
                    return Reply::Reports(ReportsReply::default());
                };
                let counts = reports.counts();
                let (count, newest) =
                    blocking(move || reports.held(since, kind.as_deref(), NEWEST_REPORTS))
                        .await
                        .unwrap_or_default();
                Reply::Reports(ReportsReply {
                    kept: true,
                    count,
                    newest,
                    received: counts.received,
                    saved: counts.saved,
                    dropped: counts.dropped,
                    pruned: counts.pruned,
                })
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
            players: game.players.clone(),
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
        }
    }
}
