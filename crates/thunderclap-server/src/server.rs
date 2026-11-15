//! [`Server`]: the builder, and the [`Running`] server it starts.

use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use tc_admin::{
    AdminChannel, Backups, DataLoader, GameRequests, GameStatus, KEEP_BACKUPS, Live, Reports,
    ReportsSource, Revoke, SessionRevoke, SimControls,
};
use tc_auth::{FileAccounts, LiveTokens, NameRules, SessionAuth, TokenFormat};
use tc_net::{Auth, ServerConfig};
use tc_sim::{Core, Game, Sim, SimConfig, SimHandle};
use tc_store::{ArchivePolicy, META_FILE};
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::stop::{EXIT_FORCED, REPEAT_GRACE, STOP_FILE, STOP_POLL, Signals};
use crate::watch::{WatchConfig, Watcher};

/// The store's directory, under the data directory.
pub const STORE_DIR: &str = "store";
/// The accounts' directory (dev guests), under the data directory.
pub const ACCOUNTS_DIR: &str = "accounts";
/// The backups' directory, under the data directory.
pub const BACKUPS_DIR: &str = "backups";
/// The file holding the dev token secret, under the data directory.
pub const SECRET_FILE: &str = "auth.secret";
/// The file naming the build that last opened the store, under the data
/// directory ([`Builder::backup_on_new_build`]).
pub const LAST_OPEN_FILE: &str = "last-open";
/// Where [`Builder::backup_on_new_build`]'s backups go, under
/// [`BACKUPS_DIR`] (apart from the admin channel's).
pub const AUTO_BACKUPS_DIR: &str = "auto";

/// Names [`AuthMode::DevGuests`] takes: `lower_snake`, 2 to 24.
pub const DEV_NAMES: NameRules =
    NameRules::lower_snake(2, 24, "2 to 24 lowercase letters, digits and _");

/// How a server checks tokens.
#[derive(Clone, Default)]
pub enum AuthMode {
    /// Session tokens over accounts in the data directory, with a secret
    /// kept beside them, and guests: an empty token joins as a numbered
    /// guest. Tokens come from [`Running::auth`]'s `issue`, and the admin
    /// channel's revoke ends them ([`SessionRevoke`]: it says how many
    /// sessions closed). The default.
    #[default]
    DevGuests,
    /// Every token good, the token the name: tests and tools.
    Open,
    /// The game's own: it checks tokens, and revokes them if `revoke`.
    Custom {
        /// Checks tokens.
        auth: Arc<dyn Auth>,
        /// Revokes a name's tokens, for the admin channel.
        revoke: Option<Arc<dyn Revoke>>,
    },
}

/// A game server: [`Server::builder`] sets it up.
pub struct Server<G: Game>(std::marker::PhantomData<G>);

impl<G: Game> Server<G> {
    /// A server for `game`, with the defaults: data in `./data`, loopback,
    /// a free port, [`AuthMode::DevGuests`], the newest
    /// [`KEEP_BACKUPS`] backups kept, the store's archive kept by
    /// [`ArchivePolicy::default`].
    pub fn builder(game: G) -> Builder<G> {
        Builder {
            game,
            data_dir: PathBuf::from("data"),
            host: "127.0.0.1".into(),
            port: 0,
            auth: AuthMode::default(),
            meta: Vec::new(),
            sim: SimConfig::default(),
            data: None,
            build: String::new(),
            reports: None,
            reports_source: None,
            game_requests: None,
            keep_backups: KEEP_BACKUPS,
            archive: ArchivePolicy::default(),
            net: Vec::new(),
            game_status: None,
            on_started: None,
            auto_backups: None,
            watch: None,
        }
    }
}

type NetTweak = Box<dyn FnOnce(&mut ServerConfig) + Send>;
type Started<G> = Box<dyn FnOnce(&Running<G>) -> Box<dyn Any + Send> + Send>;

/// How a server is set up: [`Server::builder`].
pub struct Builder<G: Game> {
    game: G,
    data_dir: PathBuf,
    host: String,
    port: u16,
    auth: AuthMode,
    meta: Vec<u8>,
    sim: SimConfig,
    data: Option<DataLoader<G>>,
    build: String,
    reports: Option<Reports>,
    reports_source: Option<Arc<dyn ReportsSource>>,
    game_requests: Option<GameRequests>,
    keep_backups: usize,
    archive: ArchivePolicy,
    net: Vec<NetTweak>,
    game_status: Option<GameStatus>,
    on_started: Option<Started<G>>,
    auto_backups: Option<usize>,
    watch: Option<(Vec<PathBuf>, WatchConfig)>,
}

impl<G: Game> Builder<G> {
    /// Where the server keeps its store, accounts, backups and reports.
    pub fn data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.data_dir = dir.into();
        self
    }

    /// The address to serve the game on.
    pub fn host(mut self, host: impl Into<String>) -> Self {
        self.host = host.into();
        self
    }

    /// The port to serve the game on; 0 picks a free one.
    pub fn port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    /// How tokens are checked.
    pub fn auth(mut self, auth: AuthMode) -> Self {
        self.auth = auth;
        self
    }

    /// The bytes a new store keeps as its meta (the game's own: a seed, a
    /// version).
    pub fn meta(mut self, meta: impl Into<Vec<u8>>) -> Self {
        self.meta = meta.into();
        self
    }

    /// How the loop runs.
    pub fn sim(mut self, config: SimConfig) -> Self {
        self.sim = config;
        self
    }

    /// How a reload reads the game's data again; without, reload is
    /// refused.
    pub fn reload_with(
        mut self,
        load: impl Fn() -> Result<Arc<G::Data>, String> + Send + Sync + 'static,
    ) -> Self {
        self.data = Some(Arc::new(load));
        self
    }

    /// The build the status names.
    pub fn build(mut self, build: impl Into<String>) -> Self {
        self.build = build.into();
        self
    }

    /// The reports the game writes (its own clone submits them), for the
    /// admin channel to list.
    pub fn reports(mut self, reports: Reports) -> Self {
        self.reports = Some(reports);
        self
    }

    /// What the admin channel's `reports` lists, in place of
    /// [`reports`](Self::reports)': the game's own reports, or `Reports`
    /// with the game's numbers ([`ReportsSource::extra`]).
    pub fn reports_source(mut self, source: Arc<dyn ReportsSource>) -> Self {
        self.reports_source = Some(source);
        self
    }

    /// Answers the admin channel's game requests.
    pub fn game_requests(
        mut self,
        answer: impl Fn(&str, serde_json::Value) -> Result<serde_json::Value, String>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.game_requests = Some(Arc::new(answer));
        self
    }

    /// Backups kept; 0 keeps every one.
    pub fn keep_backups(mut self, keep: usize) -> Self {
        self.keep_backups = keep;
        self
    }

    /// How long the store's archive (the log behind the game's bases, see
    /// `Game::save`) and recovered files are kept, and how big it may get.
    pub fn archive(mut self, policy: ArchivePolicy) -> Self {
        self.archive = policy;
        self
    }

    /// Changes the network's config past these settings (origins, limits,
    /// threads) just before it starts.
    pub fn net(mut self, tweak: impl FnOnce(&mut ServerConfig) + Send + 'static) -> Self {
        self.net.push(Box::new(tweak));
        self
    }

    /// The game's own status (its world's numbers), in
    /// the admin channel's every status (`Status::game`). Asked on the
    /// runtime's thread: read what the game publishes, never wait.
    pub fn game_status(
        mut self,
        status: impl Fn() -> serde_json::Value + Send + Sync + 'static,
    ) -> Self {
        self.game_status = Some(Arc::new(status));
        self
    }

    /// Runs `started` once the server is up (it listens, the admin channel
    /// is open): the game's own announcement (where it listens, on stdout
    /// for a launcher), a status writer. What it returns is kept until the
    /// server stops, then dropped first.
    pub fn on_started(
        mut self,
        started: impl FnOnce(&Running<G>) -> Box<dyn Any + Send> + Send + 'static,
    ) -> Self {
        self.on_started = Some(Box::new(started));
        self
    }

    /// Backs the store up before it opens when the build (see
    /// [`build`](Self::build); fold a content hash into it to count data
    /// changes too) differs from the one that opened it last, into
    /// [`AUTO_BACKUPS_DIR`] under the backups, keeping the newest `keep`
    /// (0: every one). A backup that fails is logged and the server opens
    /// anyway. Off by default.
    pub fn backup_on_new_build(mut self, keep: usize) -> Self {
        self.auto_backups = Some(keep);
        self
    }

    /// Watches `paths` (files, or directories walked) while it runs and
    /// reloads the game's data through [`reload_with`](Self::reload_with)'s
    /// loader once they change and go quiet: dev hot reload. A load that
    /// fails is logged (and handed to [`WatchConfig::on_reload`]) and the
    /// game runs on as it was. Needs `reload_with`.
    pub fn watch(mut self, paths: impl IntoIterator<Item = PathBuf>, config: WatchConfig) -> Self {
        self.watch = Some((paths.into_iter().collect(), config));
        self
    }

    /// The data directory set.
    pub fn data_path(&self) -> &Path {
        &self.data_dir
    }

    /// The store's directory: [`STORE_DIR`] in the data directory.
    pub fn store_path(&self) -> PathBuf {
        self.data_dir.join(STORE_DIR)
    }

    /// Where backups go, keeping the newest set.
    pub fn backups(&self) -> Backups {
        Backups {
            store: self.store_path(),
            dir: self.data_dir.join(BACKUPS_DIR),
            keep: self.keep_backups,
        }
    }

    /// The game's log codec, for offline tools (a rollback).
    pub fn codec(&self) -> G::Codec {
        self.game.codec()
    }

    /// Starts it: opens the store (creating it the first time, and tidying
    /// its archive), runs the loop, serves the game and opens the admin
    /// channel. Call within a tokio runtime.
    pub async fn start(self) -> Result<Running<G>, String> {
        let data = self.data_dir;
        std::fs::create_dir_all(&data).map_err(|e| format!("creating {}: {e}", data.display()))?;
        let store = data.join(STORE_DIR);
        if self.watch.is_some() && self.data.is_none() {
            return Err("watching the game's data needs reload_with".into());
        }
        let open_backup = match self.auto_backups {
            Some(keep) => backup_on_new_build(&data, &store, &self.build, keep),
            None => None,
        };
        let codec = self.game.codec();
        // The archive the bases leave the log in keeps by the same policy.
        let config = SimConfig {
            archive: self.archive,
            ..self.sim
        };
        let sim = if store.join(META_FILE).exists() {
            match tc_store::tidy(&store, &codec, 0, &self.archive) {
                Ok(t) => info!(?t, "store tidied"),
                Err(e) => warn!("could not tidy {}: {e}", store.display()),
            }
            Sim::open(&store, self.game, config)?.0
        } else {
            Sim::create(&store, self.game, &self.meta, config).map_err(|e| e.to_string())?
        };
        let running = sim.spawn().map_err(|e| format!("starting the loop: {e}"))?;

        let mut hooks = tc_net::hooks::Hooks::<G::Protocol>::default();
        let (auth, revoke, session): (Arc<dyn Auth>, Option<Arc<dyn Revoke>>, _) = match self.auth {
            AuthMode::DevGuests => {
                let secret = secret(&data.join(SECRET_FILE))?;
                let accounts = FileAccounts::open(&data.join(ACCOUNTS_DIR), DEV_NAMES);
                let session = Arc::new(
                    SessionAuth::new(secret, TokenFormat::default(), Arc::new(accounts))
                        .with_guests(),
                );
                // The open sessions' tokens, so a revoke counts those it
                // closes.
                let live = LiveTokens::new();
                hooks.hello = Some(live.hook());
                let revoke = SessionRevoke::new(session.clone(), live);
                (session.clone(), Some(Arc::new(revoke)), Some(session))
            }
            AuthMode::Open => (Arc::new(tc_net::AllowAll), None, None),
            AuthMode::Custom { auth, revoke } => (auth, revoke, None),
        };

        let mut config = ServerConfig::new(G::schema().hash());
        config.host = self.host;
        config.port = self.port;
        config.auth = auth;
        for tweak in self.net {
            tweak(&mut config);
        }
        let net = match tc_net::Server::start_with(config, running.requests.clone(), hooks).await {
            Ok(n) => n,
            Err(e) => {
                running.stop();
                return Err(format!("serving the game: {e}"));
            }
        };
        let addr = net.local_addr();

        let stopping = Arc::new(AtomicBool::new(false));
        let (stop_tx, stop_rx) = watch::channel(false);
        let watcher = match self.watch {
            Some((paths, config)) => {
                let load = self.data.clone().ok_or("watch needs reload_with")?;
                match Watcher::spawn(paths, config, running.handle.clone(), load) {
                    Ok(w) => Some(w),
                    Err(e) => {
                        net.stop().await;
                        running.stop();
                        return Err(e);
                    }
                }
            }
            None => None,
        };
        let live = Live {
            sim: Arc::new(SimControls {
                handle: running.handle.clone(),
                data: self.data,
            }),
            io: Some(net.io_counters()),
            port: addr.port(),
            build: self.build.clone(),
            stopping: stopping.clone(),
            revoke,
            backups: Some(Backups {
                store: store.clone(),
                dir: data.join(BACKUPS_DIR),
                keep: self.keep_backups,
            }),
            reports: self.reports_source.or_else(|| {
                self.reports
                    .clone()
                    .map(|r| Arc::new(r) as Arc<dyn ReportsSource>)
            }),
            game: self.game_requests,
            status: self.game_status,
        };
        let admin = match AdminChannel::open(&store, live, stop_tx).await {
            Ok(a) => a,
            Err(e) => {
                net.stop().await;
                running.stop();
                return Err(format!("opening the admin channel: {e}"));
            }
        };
        info!(%addr, data = %data.display(), "serving");
        if self.auto_backups.is_some()
            && let Err(e) = std::fs::write(data.join(LAST_OPEN_FILE), &self.build)
        {
            warn!("could not note the build that opened the store: {e}");
        }
        let mut running = Running {
            net: Some(net),
            sim: Some(running),
            admin: Some(admin),
            stop: stop_rx,
            stopping,
            auth: session,
            reports: self.reports,
            data_dir: data,
            store,
            addr,
            open_backup,
            watcher,
            guard: None,
        };
        if let Some(started) = self.on_started {
            running.guard = Some(started(&running));
        }
        Ok(running)
    }

    /// Starts it on a runtime of its own and serves until it is asked to
    /// stop: the admin channel's stop, a stop signal (Ctrl-C, `SIGTERM`;
    /// on Windows Ctrl-Break and closing the console too), or
    /// [`STOP_FILE`] appearing in the data directory; then stops cleanly.
    /// A second signal after [`REPEAT_GRACE`] exits at once with
    /// [`EXIT_FORCED`]. If the game's loop ends on its own (a panic), it
    /// stops too and says so: the error. Prints where it serves.
    pub fn run(self) -> Result<(), String> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("starting a runtime: {e}"))?;
        let stop_file = self.data_dir.join(STOP_FILE);
        rt.block_on(async {
            if std::fs::remove_file(&stop_file).is_ok() {
                info!("removed a stop file left over");
            }
            let mut signals = Signals::new();
            let running = self.start().await?;
            eprintln!(
                "serving ws://{} from {} (Ctrl-C or `stop` ends it)",
                running.addr(),
                running.data_dir().display()
            );
            let mut asked = running.stop.clone();
            let mut poll = tokio::time::interval(STOP_POLL);
            let why = loop {
                tokio::select! {
                    _ = asked.wait_for(|s| *s) => break "asked to",
                    s = signals.next() => break s,
                    _ = poll.tick() => {
                        if std::fs::remove_file(&stop_file).is_ok() {
                            break "the stop file";
                        }
                        if running.loop_ended() {
                            break "the game's loop ended";
                        }
                    }
                }
            };
            let crashed = running.loop_ended();
            if crashed {
                error!("the game's loop ended on its own: stopping");
            }
            eprintln!("stopping ({why})");
            let first = Instant::now();
            let force = tokio::spawn(async move {
                loop {
                    let s = signals.next().await;
                    if first.elapsed() >= REPEAT_GRACE {
                        eprintln!("{s} again: exiting now");
                        std::process::exit(EXIT_FORCED);
                    }
                }
            });
            running.stop().await;
            force.abort();
            if crashed {
                return Err("the game's loop ended on its own (see the log)".into());
            }
            Ok(())
        })
    }
}

/// Backs `store` up into the auto backups if `build` didn't open it last;
/// where the backup went.
fn backup_on_new_build(data: &Path, store: &Path, build: &str, keep: usize) -> Option<PathBuf> {
    if !store.join(META_FILE).exists() {
        return None;
    }
    let last = std::fs::read_to_string(data.join(LAST_OPEN_FILE)).ok();
    if last.as_deref() == Some(build) {
        return None;
    }
    let backups = Backups {
        store: store.to_path_buf(),
        dir: data.join(BACKUPS_DIR).join(AUTO_BACKUPS_DIR),
        keep,
    };
    match backups.run(None) {
        Ok(b) => {
            info!(
                from = last.as_deref().unwrap_or("(unknown)"),
                to = build,
                dir = %b.dir.display(),
                "a new build: backed the store up before opening it"
            );
            Some(b.dir)
        }
        Err(e) => {
            warn!("a new build, but the backup before opening failed (opening anyway): {e}");
            None
        }
    }
}

/// The dev secret in `path`, made the first time (readable by its owner
/// only, on Unix).
fn secret(path: &Path) -> Result<Vec<u8>, String> {
    if let Ok(text) = std::fs::read_to_string(path)
        && !text.trim().is_empty()
    {
        return Ok(text.trim().as_bytes().to_vec());
    }
    let token = tc_admin::new_token();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options
        .open(path)
        .and_then(|mut f| f.write_all(token.as_bytes()))
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(token.into_bytes())
}

/// A server [`Builder::start`] started.
pub struct Running<G: Game> {
    net: Option<tc_net::Server<G::Protocol>>,
    sim: Option<tc_sim::Running<G>>,
    admin: Option<AdminChannel>,
    stop: watch::Receiver<bool>,
    stopping: Arc<AtomicBool>,
    auth: Option<Arc<SessionAuth>>,
    reports: Option<Reports>,
    data_dir: PathBuf,
    store: PathBuf,
    addr: std::net::SocketAddr,
    open_backup: Option<PathBuf>,
    watcher: Option<Watcher>,
    guard: Option<Box<dyn Any + Send>>,
}

impl<G: Game> Running<G> {
    /// The address the game is served on.
    pub fn addr(&self) -> std::net::SocketAddr {
        self.addr
    }

    /// The data directory.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The store's directory, where the admin channel's endpoint file is:
    /// [`tc_admin::ask`] it.
    pub fn store_dir(&self) -> &Path {
        &self.store
    }

    /// The session tokens, under [`AuthMode::DevGuests`]: `issue` one.
    pub fn auth(&self) -> Option<&Arc<SessionAuth>> {
        self.auth.as_ref()
    }

    /// The loop's handle.
    pub fn sim(&self) -> Option<&SimHandle<G>> {
        self.sim.as_ref().map(|s| &s.handle)
    }

    /// The reports, if the builder was given them.
    pub fn reports(&self) -> Option<&Reports> {
        self.reports.as_ref()
    }

    /// The admin channel's address.
    pub fn admin_addr(&self) -> Option<std::net::SocketAddr> {
        self.admin.as_ref().map(AdminChannel::addr)
    }

    /// The backup [`Builder::backup_on_new_build`] made as it opened, if
    /// it did.
    pub fn open_backup(&self) -> Option<&Path> {
        self.open_backup.as_deref()
    }

    /// True if the game's loop ended on its own (it panicked): the server
    /// should stop ([`Builder::run`] does).
    pub fn loop_ended(&self) -> bool {
        self.sim.as_ref().is_some_and(|s| s.thread.is_finished())
    }

    /// Returns once the admin channel is asked to stop.
    pub async fn stopped(&mut self) {
        let _ = self.stop.wait_for(|s| *s).await;
    }

    /// Stops: the admin channel closes, the sessions close, the loop stops
    /// (its log flushed), the reports waiting are written. The game as it
    /// stopped.
    /// A loop that panicked is logged, and gives `None`.
    pub async fn stop(mut self) -> Option<Core<G>> {
        self.stopping.store(true, Ordering::Relaxed);
        drop(self.guard.take());
        drop(self.watcher.take());
        if let Some(admin) = self.admin.take() {
            admin.close();
        }
        if let Some(net) = self.net.take() {
            net.game_ended(false);
            net.stop().await;
        }
        // Brief blocking: the loop flushes its log and its thread ends; the
        // reports waiting are written.
        let core = self.sim.take().and_then(|sim| {
            sim.handle.stop();
            drop(sim.requests);
            sim.thread
                .join()
                .map_err(|panic| {
                    let why = panic
                        .downcast_ref::<&str>()
                        .map(|s| (*s).to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_default();
                    error!("the game's loop panicked: {why}");
                })
                .ok()
        });
        if let Some(r) = &self.reports {
            r.close();
        }
        info!("stopped");
        core
    }
}
